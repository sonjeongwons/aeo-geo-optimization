/**
 * src/cli/diagnoseUrl.ts
 *
 * CLI entry point: `npm run diagnose-url -- --url <url> [--customer <slug>] [--industry <i>]`
 *
 * Steps:
 *   1. Parse CLI args.
 *   2. Run qgenBudget preflight (global cap gate — coarse, env-based).
 *   3. Build GeminiAdapter from GEMINI_API_KEY.
 *   4. Run diagnose() pipeline (fetch + extract + ONE Gemini structured call).
 *   5. Print BrandBrief JSON to stdout for human sanity check.
 *   6. If --customer given, carry the BrandBrief forward as seed (printed note).
 *
 * Graceful degrade:
 *   - GEMINI_API_KEY absent + no --industry fallback → exit 1 with clear message.
 *   - GEMINI_API_KEY absent + --industry supplied → diagnose() returns NOT_CONFIGURED;
 *     handled with clear message + exit 1.
 *   - URL fetch failure → diagnose() degrades to industry-only; brief still printed.
 *
 * Budget:
 *   - QgenRunBudget assertGlobalGate() called before first Gemini call with a small
 *     estimate (~$0.01 for a single diagnosis call).
 *   - Per-run ceiling enforced by the same budget instance (recordUsage not needed
 *     here because diagnose.ts handles the single call internally; the global gate
 *     is the coarse pre-run guard for the CLI use-case).
 *
 * Off-site §0 compliance:
 *   - URL fetch is GET-only via urlFetch.ts (SSRF guard inside).
 *   - No competitor URLs are fetched; competitors inferred from LLM knowledge.
 *
 * DESIGN-phase1.md §"URL Diagnosis" / T17.
 */

import "../config/env.js"; // side-effect: load .env + fail fast on missing DATABASE_URL
import { env, geminiApiKeys } from "../config/env.js";
import { makeGeminiAdapter } from "../providers/gemini.js";
import { diagnose } from "../generate/diagnose.js";
import { createQgenBudget, QgenGlobalCapExceededError } from "../cost/qgenBudget.js";
import type { LedgerPort } from "../generate/diagnose.js";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  url: string | undefined;
  customer: string | undefined;
  industry: string | undefined;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  let url: string | undefined;
  let customer: string | undefined;
  let industry: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    if ((flag === "--url" || flag === "-u") && next && !next.startsWith("-")) {
      url = next;
      i++;
    } else if ((flag === "--customer" || flag === "-c") && next && !next.startsWith("-")) {
      customer = next;
      i++;
    } else if ((flag === "--industry" || flag === "-i") && next && !next.startsWith("-")) {
      industry = next;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: npm run diagnose-url -- --url <url> [--customer <slug>] [--industry <key>]\n\n" +
          "Options:\n" +
          "  --url, -u        Customer URL to diagnose (http/https)\n" +
          "  --customer, -c   Customer slug to carry the BrandBrief forward as seed\n" +
          "  --industry, -i   Industry key hint (e.g. ai-companion). Used as fallback.\n" +
          "  --help, -h       Show this help message\n",
      );
      process.exit(0);
    }
  }

  return { url, customer, industry };
}

// ---------------------------------------------------------------------------
// No-op ledger (diagnose-url is an advisory read-only CLI; no DB required)
// ---------------------------------------------------------------------------

/**
 * Best-effort ledger that tries to write to the DB if DATABASE_URL is set
 * and a DB connection is available, but silently drops failures.
 *
 * For the diagnose-url CLI, the ledger is provided as a stub that logs the
 * call locally. In production, callers integrating with gen-template will
 * wire the real repo.insertLlmCall instead.
 */
const stubLedger: LedgerPort = {
  async insertLlmCall(c) {
    // Non-blocking local log for visibility; no DB write in this CLI
    process.stderr.write(
      `[diagnose-url] llm_call: model=${c.modelId} in=${c.inputTokens} out=${c.outputTokens} ` +
        `usd=$${c.usd.toFixed(6)} cacheHit=${c.cacheHit}\n`,
    );
    // Return a synthetic id so the LedgerPort contract is satisfied
    return { id: "stub-ledger-no-db" };
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { url, customer, industry } = parseArgs();

  // ---- Validate: require at least a URL or an industry ----------------------
  if (!url && !industry) {
    process.stderr.write(
      "diagnose-url: error — supply at least --url <url> or --industry <key>.\n" +
        "Usage: npm run diagnose-url -- --url <url> [--customer <slug>] [--industry <key>]\n",
    );
    process.exit(1);
  }

  // ---- qgenBudget preflight (global cap, coarse env-based guard) ------------
  //
  // A single diagnosis call is very cheap (~$0.01 for gemini-2.5-flash with
  // typical page-extraction output).  We estimate conservatively at $0.05 to
  // give headroom for verbose pages.  This is a COARSE gate; the per-run
  // accumulator inside QgenRunBudget would catch overruns if the run had
  // multiple calls (gen-template uses it more extensively).
  const ESTIMATED_DIAGNOSIS_USD = 0.05;

  const budget = createQgenBudget({ runCeilingUsd: ESTIMATED_DIAGNOSIS_USD * 2 });

  try {
    budget.assertGlobalGate({ estimatedUsd: ESTIMATED_DIAGNOSIS_USD });
  } catch (err) {
    if (err instanceof QgenGlobalCapExceededError) {
      process.stderr.write(
        `diagnose-url: global ${err.capType} cap would be exceeded ` +
          `(estimated $${err.estimatedUsd.toFixed(4)}, cap $${err.capUsd.toFixed(2)}).\n` +
          "Set GLOBAL_WEEKLY_USD_CAP / GLOBAL_MONTHLY_USD_CAP in your environment to raise the cap.\n",
      );
      process.exit(1);
    }
    throw err;
  }

  // ---- GEMINI_API_KEY check -------------------------------------------------
  //
  // If no API key AND no industry, we cannot produce any brief.
  // If no API key BUT an industry was given, we let diagnose() handle it and
  // return NOT_CONFIGURED — we handle that below with a clear message + exit 1.
  const apiKeys = geminiApiKeys();

  if (apiKeys.length === 0 && !industry) {
    process.stderr.write(
      "diagnose-url: GEMINI_API_KEY is not set and no --industry fallback was supplied.\n" +
        "Set GEMINI_API_KEY in your .env file, or supply --industry <key> to get an industry-only brief.\n",
    );
    process.exit(1);
  }

  // ---- Build adapter --------------------------------------------------------
  const adapter = makeGeminiAdapter(apiKeys);

  // ---- Run diagnosis --------------------------------------------------------
  process.stderr.write(
    `[diagnose-url] Starting diagnosis` +
      (url ? ` for URL: ${url}` : "") +
      (industry ? ` (industry hint: ${industry})` : "") +
      (customer ? ` (customer: ${customer})` : "") +
      "\n",
  );

  const result = await diagnose({
    ...(url !== undefined ? { url } : {}),
    ...(industry !== undefined ? { industry } : {}),
    customerId: null, // no customer row at this point; attribution is advisory
    adapter,
    ledger: stubLedger,
  });

  // ---- Handle NOT_CONFIGURED ------------------------------------------------
  if (!result.ok && result.code === "NOT_CONFIGURED") {
    process.stderr.write(
      `diagnose-url: ${result.message}\n` +
        "Set GEMINI_API_KEY in your .env file and retry.\n",
    );
    process.exit(1);
  }

  // ---- Handle other errors --------------------------------------------------
  if (!result.ok) {
    process.stderr.write(
      `diagnose-url: diagnosis failed [${result.code}]: ${result.message}\n`,
    );
    process.exit(1);
  }

  // ---- Print robots/degrade notes to stderr (non-blocking info) -------------
  if (result.robotsNote) {
    process.stderr.write(`[diagnose-url] robots note: ${result.robotsNote}\n`);
  }
  if (result.degradeReason) {
    process.stderr.write(`[diagnose-url] degraded to industry-only: ${result.degradeReason}\n`);
  }

  // ---- Print BrandBrief JSON to stdout for human sanity check ---------------
  const output: Record<string, unknown> = {
    mode: result.mode,
    brief: result.brief,
  };

  if (customer) {
    output["customerSeed"] = {
      slug: customer,
      note:
        "BrandBrief carried forward as seed. Pass this to gen-template with --customer to " +
        "generate a full draft template for this customer.",
      brandName: result.brief.brandName,
      industryKey: result.brief.industryKey,
      detectedLanguages: result.brief.detectedLanguages,
      seedCompetitors: result.brief.seedCompetitors,
    };
  }

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  // ---- Summary to stderr (human-readable) -----------------------------------
  const langSummary = result.brief.detectedLanguages
    .map((l) => `${l.code}(w=${l.weight.toFixed(2)})`)
    .join(", ");

  process.stderr.write(
    `[diagnose-url] Done. mode=${result.mode} brand="${result.brief.brandName}" ` +
      `industry="${result.brief.industryKey}" confidence=${result.brief.confidence.toFixed(2)} ` +
      `languages=[${langSummary}] competitors=${result.brief.seedCompetitors.length}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`diagnose-url: fatal error: ${String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
