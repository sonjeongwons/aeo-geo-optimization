/**
 * src/cli/genTemplate.ts
 *
 * CLI entry point: `npm run gen-template -- [--url <u>] [--industry <i>]
 *                                           [--customer <slug>] [--total <n>]`
 *
 * PHASE 1 REWRITE (T18):
 *   Full pipeline: diagnose → intentMatrix → multilingual generation →
 *   dedup → guardrails → densityMap → assembleTemplate (status='draft').
 *
 * Both input modes:
 *   --industry-only  → no --url, just --industry <key>
 *   --url            → runs the full URL-diagnosis-seeded pipeline
 *
 * Route ALL Gemini calls through the Phase 0 GeminiAdapter (generateStructured).
 * NO raw GoogleGenAI instantiation.
 *
 * Budget:
 *   QgenRunBudget enforces a per-run USD ceiling (default $5.00 for a full
 *   gen run covering ~16 Gemini calls) via a process-local accumulator.
 *
 * §5.5 human-review gate:
 *   Output row is ALWAYS status='draft'. Never auto-activates.
 *
 * Off-site §0:
 *   URL fetch is GET-only via urlFetch.ts / diagnose.ts (SSRF guard inside).
 *   No competitor URLs are ever fetched.
 *
 * DESIGN-phase1.md §"Phase 0 Integration" / T18.
 */

import "../config/env.js"; // side-effect: load .env + fail fast
import { env, geminiApiKeys } from "../config/env.js";
import { makeGeminiAdapter } from "../providers/gemini.js";
import { diagnose } from "../generate/diagnose.js";
import { buildIntentMatrix, sumTargetCounts } from "../generate/intentMatrix.js";
import { applyDensityToQuestions, applyDensityTiers, buildLangWeightsMap } from "../generate/densityMap.js";
import { dedup } from "../generate/dedup.js";
import { applyQuestionGuards } from "../generate/questionGuards.js";
import { assembleTemplate } from "../generate/assembleTemplate.js";
import { createQgenBudget, QgenBudgetExceededError, QgenGlobalCapExceededError } from "../cost/qgenBudget.js";
import { insertLlmCall } from "../db/repo.js";
import type { BrandBrief, DraftQuestion, GenOptions, IntentCell } from "../generate/types.js";
import { GenOptionsSchema } from "../generate/types.js";
import type { LedgerPort } from "../generate/diagnose.js";
import type { GenerateStructuredRequest } from "../providers/types.js";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  url: string | undefined;
  industry: string | undefined;
  customer: string | undefined;
  total: number;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  let url: string | undefined;
  let industry: string | undefined;
  let customer: string | undefined;
  let total = 120;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    if ((flag === "--url" || flag === "-u") && next && !next.startsWith("-")) {
      url = next;
      i++;
    } else if ((flag === "--industry" || flag === "-i") && next && !next.startsWith("-")) {
      industry = next;
      i++;
    } else if ((flag === "--customer" || flag === "-c") && next && !next.startsWith("-")) {
      customer = next;
      i++;
    } else if ((flag === "--total" || flag === "-n") && next && !next.startsWith("-")) {
      const parsed = parseInt(next, 10);
      if (!isNaN(parsed)) {
        total = parsed;
      }
      i++;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: npm run gen-template -- [--url <url>] [--industry <key>]\n" +
          "                               [--customer <slug>] [--total <n>]\n\n" +
          "Options:\n" +
          "  --url, -u        Customer URL to diagnose (http/https)\n" +
          "  --industry, -i   Industry key (e.g. ai-companion). Required if no --url.\n" +
          "  --customer, -c   Customer slug for advisory provenance columns.\n" +
          "  --total, -n      Target question count (default 120, clamped [50,200]).\n" +
          "  --help, -h       Show this help message.\n\n" +
          "Output:\n" +
          "  Prints { templateId, questionCount, industry, status='draft' } to stdout.\n" +
          "  The draft template must be reviewed via 'npm run review-template' before use.\n",
      );
      process.exit(0);
    }
  }

  return { url, industry, customer, total };
}

// ---------------------------------------------------------------------------
// Real DB ledger (for production; tests inject a stub)
// ---------------------------------------------------------------------------

const dbLedger: LedgerPort = {
  insertLlmCall(c) {
    return insertLlmCall(c);
  },
};

// ---------------------------------------------------------------------------
// Multilingual generation — interface (T10 module)
// ---------------------------------------------------------------------------

/**
 * Interface for the multilingual generation function from T10.
 * Defined here so that T18 can compile before T10 is built.
 * At runtime, genTemplate.ts dynamically imports multilingual.ts.
 */
interface MultilingualAdapter {
  generateStructured<T extends z.ZodTypeAny>(
    req: GenerateStructuredRequest<T>
  ): Promise<import("../providers/types.js").GenerateStructuredResult<z.infer<T>>>;
}

/**
 * Options for the multilingual generation call (T10 interface).
 */
interface MultilingualOptions {
  adapter: MultilingualAdapter;
  brief: BrandBrief;
  matrix: IntentCell[];
  genOptions: GenOptions;
  ledger: LedgerPort;
  budget: ReturnType<typeof createQgenBudget>;
}

/**
 * Result from the multilingual generation call.
 */
interface MultilingualResult {
  questions: DraftQuestion[];
  generatedTotal: number;
}

// ---------------------------------------------------------------------------
// Attempt to load multilingual.ts (T10 — may not be built yet in CI)
// ---------------------------------------------------------------------------

/**
 * Dynamically load the multilingual generator from T10.
 * Returns null if the module is not available (e.g. T10 not yet built).
 *
 * When multilingual.ts is not available, the CLI falls back to a minimal
 * placeholder that generates no questions (prints a clear error message).
 * This allows T18 to compile and run in the --industry-only path without T10.
 */
async function tryLoadMultilingual(): Promise<
  ((opts: MultilingualOptions) => Promise<MultilingualResult>) | null
> {
  try {
    // Use a computed path so TypeScript does not statically resolve the module
    // (multilingual.ts is built by T10 — a parallel task that may not exist yet).
    const modulePath = "../generate/multilingual.js";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import(/* @vite-ignore */ modulePath) as any;
    if (typeof mod.generateMultilingual === "function") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
      return mod.generateMultilingual as (opts: MultilingualOptions) => Promise<MultilingualResult>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pipeline: build BrandBrief from diagnosis or industry hint
// ---------------------------------------------------------------------------

async function buildBrief(opts: {
  url: string | undefined;
  industry: string | undefined;
  adapter: ReturnType<typeof makeGeminiAdapter>;
  ledger: LedgerPort;
}): Promise<{ brief: BrandBrief; mode: "full" | "industry-only"; degradeReason?: string }> {
  const { url, industry, adapter, ledger } = opts;

  if (!url && !industry) {
    throw new Error(
      "gen-template: supply at least --url <url> or --industry <key>.\n" +
        "Usage: npm run gen-template -- --url <url> --industry <key>",
    );
  }

  const result = await diagnose({
    ...(url !== undefined ? { url } : {}),
    ...(industry !== undefined ? { industry } : {}),
    customerId: null,
    adapter,
    ledger,
  });

  if (!result.ok) {
    if (result.code === "NOT_CONFIGURED") {
      throw new Error(
        `gen-template: GEMINI_API_KEY is not set and a URL diagnosis was requested.\n` +
          `${result.message}\n` +
          `Either set GEMINI_API_KEY in your .env file, or supply --industry <key> only.`,
      );
    }
    throw new Error(`gen-template: diagnosis failed [${result.code}]: ${result.message}`);
  }

  return {
    brief: result.brief,
    mode: result.mode,
    ...(result.degradeReason !== undefined ? { degradeReason: result.degradeReason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { url, industry, customer, total } = parseArgs();

  // ---- Require at least --url or --industry ----------------------------------
  if (!url && !industry) {
    process.stderr.write(
      "gen-template: error — supply at least --url <url> or --industry <key>.\n" +
        "Usage: npm run gen-template -- [--url <url>] [--industry <key>] [--customer <slug>] [--total <n>]\n",
    );
    process.exit(1);
  }

  // ---- GEMINI_API_KEY check -------------------------------------------------
  const apiKeys = geminiApiKeys();
  if (apiKeys.length === 0) {
    process.stderr.write(
      "gen-template: GEMINI_API_KEY is not set.\n" +
        "Set GEMINI_API_KEY in your .env file and retry.\n",
    );
    process.exit(1);
  }

  // ---- Parse GenOptions (clamps total to [50,200]) -------------------------
  const genOptions: GenOptions = GenOptionsSchema.parse({ requestedTotal: total });

  // ---- Budget preflight (per-run ceiling: $5.00 for a full gen run) ---------
  // A full run = 1 diagnosis + ~14 language generation calls at ~$0.20 each ≈ $3.00
  // We set the ceiling at $5.00 to give headroom.
  const budget = createQgenBudget({ runCeilingUsd: 5.0 });
  const ESTIMATED_TOTAL_USD = 3.0; // conservative estimate for global gate

  try {
    budget.assertGlobalGate({ estimatedUsd: ESTIMATED_TOTAL_USD });
  } catch (err) {
    if (err instanceof QgenGlobalCapExceededError) {
      process.stderr.write(
        `gen-template: global ${err.capType} cap would be exceeded ` +
          `(estimated $${err.estimatedUsd.toFixed(4)}, cap $${err.capUsd.toFixed(2)}).\n` +
          "Set GLOBAL_WEEKLY_USD_CAP / GLOBAL_MONTHLY_USD_CAP in your environment to raise the cap.\n",
      );
      process.exit(1);
    }
    throw err;
  }

  // ---- Build adapter -------------------------------------------------------
  const adapter = makeGeminiAdapter(apiKeys);

  process.stderr.write(
    `[gen-template] Starting generation` +
      (url ? ` for URL: ${url}` : "") +
      (industry ? ` (industry hint: ${industry})` : "") +
      (customer ? ` (customer: ${customer})` : "") +
      ` (total target: ${genOptions.requestedTotal})\n`,
  );

  // ---- Stage A: URL diagnosis (or industry-only) ---------------------------
  let brief: BrandBrief;
  let diagMode: "full" | "industry-only";

  try {
    const diag = await buildBrief({ url, industry, adapter, ledger: dbLedger });
    brief = diag.brief;
    diagMode = diag.mode;
    if (diag.degradeReason) {
      process.stderr.write(`[gen-template] Diagnosis degraded: ${diag.degradeReason}\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`gen-template: ${msg}\n`);
    process.exit(1);
  }

  process.stderr.write(
    `[gen-template] BrandBrief: brand="${brief.brandName}" industry="${brief.industryKey}" ` +
      `mode=${diagMode} confidence=${brief.confidence.toFixed(2)} ` +
      `languages=${brief.detectedLanguages.length}\n`,
  );

  // ---- Stage B: IntentMatrix (pure, deterministic) -------------------------
  const matrix = buildIntentMatrix(brief, genOptions);
  const matrixTotal = sumTargetCounts(matrix);

  process.stderr.write(
    `[gen-template] IntentMatrix: ${matrix.length} cells, total target=${matrixTotal}\n`,
  );

  // ---- Stage C: Apply density tiers to the matrix (before generation) ------
  const langWeightsMap = buildLangWeightsMap(brief);
  applyDensityTiers(matrix, langWeightsMap, matrixTotal);

  // ---- Stage D: Multilingual generation ------------------------------------
  // Try to load T10's multilingual generator. If not available, abort with a
  // clear message (this module is required for question generation).
  const generateMultilingual = await tryLoadMultilingual();

  if (!generateMultilingual) {
    process.stderr.write(
      "gen-template: error — multilingual generation module (src/generate/multilingual.ts) " +
        "is not available.\n" +
        "This module is built by Task T10. Ensure all Phase 1 tasks are built before running " +
        "gen-template with full generation.\n",
    );
    process.exit(1);
  }

  let generatedQuestions: DraftQuestion[];
  let generatedTotal: number;

  try {
    const result = await generateMultilingual({
      adapter,
      brief,
      matrix,
      genOptions,
      ledger: dbLedger,
      budget,
    });
    generatedQuestions = result.questions;
    generatedTotal = result.generatedTotal;
  } catch (err: unknown) {
    if (err instanceof QgenBudgetExceededError) {
      process.stderr.write(
        `gen-template: per-run budget ceiling exceeded ` +
          `(accumulated $${err.accumulatedUsd.toFixed(4)}, ceiling $${err.ceilingUsd.toFixed(4)}).\n` +
          "Reduce --total or raise the GLOBAL_WEEKLY_USD_CAP.\n",
      );
      process.exit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`gen-template: multilingual generation failed: ${msg}\n`);
    process.exit(1);
  }

  process.stderr.write(
    `[gen-template] Generated ${generatedTotal} questions (pre-dedup/guard), ` +
      `${generatedQuestions.length} candidates\n`,
  );

  // ---- Stage E (skip density here — applied AFTER pruning; see Stage G+) ----
  // Do NOT call applyDensityToQuestions on the over-generated pool. The cap
  // denominator must be the FINAL question count (GQ-1 fix).

  // ---- Stage F: Dedup (normalized-exact + codepoint n-gram, CJK-safe) ------
  const { kept: dedupedQuestions, dropped: dedupDropped } = dedup(generatedQuestions);

  process.stderr.write(
    `[gen-template] Dedup: ${dedupedQuestions.length} kept, ${dedupDropped.length} dropped\n`,
  );

  // ---- Stage G: Question guardrails ----------------------------------------
  const { kept: guardedQuestions, rejected: guardRejected } = applyQuestionGuards(
    dedupedQuestions,
    brief.brandName,
    brief.brandAliases,
  );

  process.stderr.write(
    `[gen-template] Guardrails: ${guardedQuestions.length} kept, ${guardRejected.length} rejected\n`,
  );

  // ---- Stage G+: Apply density tiers to the FINAL kept set -----------------
  // Run applyDensityToQuestions on the post-dedup + post-guardrails set so
  // the HARD core cap (<=25%) is enforced against the actual final count,
  // not the over-generated pool (fixes GQ-1: cap denominator = final count).
  applyDensityToQuestions(guardedQuestions, brief);

  if (guardedQuestions.length === 0) {
    process.stderr.write(
      "gen-template: warning — all generated questions were rejected by dedup/guardrails.\n" +
        "Review the BrandBrief and try again with a different --industry or --total.\n",
    );
    // Continue anyway — assembleTemplate will store an empty draft for manual review.
  }

  // ---- Stage H: Assemble + persist as industry_template draft ---------------
  process.stderr.write(
    `[gen-template] Assembling draft template (status='draft') with ` +
      `${guardedQuestions.length} questions and ` +
      `${brief.seedCompetitors.length} competitors...\n`,
  );

  let templateId: string;
  let questionCount: number;

  try {
    const result = await assembleTemplate({
      questions: guardedQuestions,
      seedCompetitors: brief.seedCompetitors,
      brief,
      generatedTotal,
      source: url ? "url" : "industry",
      lowResourceLanguages: genOptions.lowResourceLanguages,
      ...(url ? { sourceUrl: url } : {}),
      ...(customer ? { customerSlug: customer } : {}),
    });
    templateId = result.templateId;
    questionCount = result.questionCount;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`gen-template: assembleTemplate failed: ${msg}\n`);
    process.exit(1);
  }

  // ---- Output summary -------------------------------------------------------
  const output = {
    templateId,
    industry: brief.industryKey,
    status: "draft",
    questionCount,
    competitorCount: brief.seedCompetitors.length,
    generatedTotal,
    diagnosisMode: diagMode,
    budgetUsd: budget.totalUsd,
    message:
      "Draft industry template created. Review with 'npm run review-template -- --id <id> " +
      "--action reviewed --by <email>' before use.",
    ...(customer ? { customerSlug: customer } : {}),
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  process.stderr.write(
    `[gen-template] Done. templateId=${templateId} questions=${questionCount} ` +
      `competitors=${brief.seedCompetitors.length} ` +
      `budgetUsd=$${budget.totalUsd.toFixed(4)}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`gen-template: fatal error: ${String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
