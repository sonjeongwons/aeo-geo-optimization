/**
 * src/cli/genContent.ts
 *
 * T16 — CLI: generate offsite content variants for a customer+industry.
 *
 * Usage:
 *   npm run gen-content -- --customer <uuid> --industry <key>
 *                          [--formats <n>] [--languages <n>] [--total <n>]
 *
 * Pipeline:
 *   1. Load ACTIVE industry_template via getLatestActiveTemplate(industry).
 *   2. Seed claim_source rows from BrandBrief.productAttributes (idempotent).
 *   3. Build ContentMatrix (PURE, no LLM) — prints the coverage+cost contract.
 *   4. Assert global USD gate; check per-customer weekly/monthly caps.
 *   5. Generate multilingual content (budget-bounded, partial-return on ceiling).
 *   6. assembleContentSet — validates bodies, runs §7 gates, persists gate_status.
 *   7. Print result summary (passed/blocked/needs_human/validation_failed counts).
 *
 * §0 OFF-SITE:
 *   This CLI generates and gates content; it NEVER deploys or publishes.
 *   Use queue-content to queue passed assets for Phase 3 deploy.
 *
 * §11 COST:
 *   - CONTENT_RUN_CEILING_USD (env, default $2) is used — NOT the $0.50 default.
 *   - Per-customer budget caps (max_content_assets_per_run, max_formats) are read
 *     from the budget table (migration 0009 columns).
 *   - Coverage+cost contract (matrix) is PRINTED before any token spend.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { fileURLToPath } from "node:url";
import "../config/env.js"; // side-effect: load .env + fail fast
import { env } from "../config/env.js";
import { makeGeminiAdapter } from "../providers/gemini.js";
import {
  getLatestActiveTemplate,
  seedClaimSourcesFromBrief,
  findClaimSources,
  insertContentSet,
} from "../db/repo.js";
import { buildContentMatrix } from "../content/contentMatrix.js";
import type { ContentMatrixCaps } from "../content/contentMatrix.js";
import { generateMultilingualContent } from "../content/multilingualContent.js";
import type { LedgerPort } from "../content/multilingualContent.js";
import { assembleContentSet } from "../content/assembleContentSet.js";
import { buildProductionContentGateRegistry } from "../content/contentGate.js";
import { createQgenBudget, QgenBudgetExceededError, QgenGlobalCapExceededError } from "../cost/qgenBudget.js";
import { insertLlmCall, findBudget, sumCostSince } from "../db/repo.js";
import { getDb } from "../db/kysely.js";
import type { BrandBrief } from "../generate/types.js";
import { BrandBriefSchema } from "../generate/types.js";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  customer: string | undefined;
  industry: string | undefined;
  formats: number | undefined;
  languages: number | undefined;
  total: number | undefined;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  let customer: string | undefined;
  let industry: string | undefined;
  let formats: number | undefined;
  let languages: number | undefined;
  let total: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    if ((flag === "--customer" || flag === "-c") && next && !next.startsWith("-")) {
      customer = next;
      i++;
    } else if ((flag === "--industry" || flag === "-i") && next && !next.startsWith("-")) {
      industry = next;
      i++;
    } else if ((flag === "--formats" || flag === "-f") && next && !next.startsWith("-")) {
      const n = parseInt(next, 10);
      if (!isNaN(n) && n > 0) formats = n;
      i++;
    } else if ((flag === "--languages" || flag === "-l") && next && !next.startsWith("-")) {
      const n = parseInt(next, 10);
      if (!isNaN(n) && n > 0) languages = n;
      i++;
    } else if ((flag === "--total" || flag === "-n") && next && !next.startsWith("-")) {
      const n = parseInt(next, 10);
      if (!isNaN(n) && n > 0) total = n;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: npm run gen-content -- --customer <uuid> --industry <key>\n" +
          "                             [--formats <n>] [--languages <n>] [--total <n>]\n\n" +
          "Options:\n" +
          "  --customer, -c   Customer UUID (required)\n" +
          "  --industry, -i   Industry key matching an ACTIVE template (required)\n" +
          "  --formats, -f    Max format types to generate (overrides budget cap)\n" +
          "  --languages, -l  Max languages to generate (overrides budget cap)\n" +
          "  --total, -n      Max total content assets to generate\n" +
          "  --help, -h       Show this help message\n\n" +
          "Output:\n" +
          "  Prints the coverage+cost matrix BEFORE any token spend.\n" +
          "  Then prints gated asset counts (passed/blocked/needs_human).\n" +
          "  Use queue-content to queue passed assets for Phase 3.\n",
      );
      process.exit(0);
    }
  }

  return { customer, industry, formats, languages, total };
}

// ---------------------------------------------------------------------------
// DB ledger port
// ---------------------------------------------------------------------------

const dbLedger: LedgerPort = {
  insertLlmCall(c) {
    return insertLlmCall(c);
  },
};

// ---------------------------------------------------------------------------
// Fetch content budget columns (Phase 2 additive columns in migration 0009)
// ---------------------------------------------------------------------------

async function findContentBudget(customerId: string): Promise<{
  max_content_assets_per_run: number | null;
  max_formats: number | null;
  content_run_ceiling_usd: string | null;
} | null> {
  const row = await getDb()
    .selectFrom("budget")
    .select(["max_content_assets_per_run", "max_formats", "content_run_ceiling_usd"])
    .where("customer_id", "=", customerId)
    .executeTakeFirst();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// BrandBrief extractor from active template
// ---------------------------------------------------------------------------

function briefFromTemplate(template: {
  id: string;
  industry: string;
  version: number;
  questions: unknown;
  competitors: unknown;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  source_url: string | null;
  customer_slug: string | null;
  generated_total: number | null;
  brief_snapshot?: unknown | null;
}): BrandBrief {
  // Track 2 — PREFER the full persisted brief_snapshot (0019). When present and
  // valid, it carries productAttributes (→ claim_source seed) AND detectedLanguages
  // (→ multilingual content matrix), so content is brand-named, multilingual, and
  // claim-backed instead of the en-only generic fallback below.
  if (template.brief_snapshot != null && typeof template.brief_snapshot === "object") {
    const parsed = BrandBriefSchema.safeParse(template.brief_snapshot);
    if (parsed.success) {
      return parsed.data;
    }
    process.stderr.write(
      `[gen-content] WARNING: brief_snapshot present but failed BrandBriefSchema ` +
        `(${parsed.error.issues.length} issue(s)) — falling back to scalar reconstruction.\n`,
    );
  }

  // Build a BrandBrief from the template's stored data.
  // The template's questions JSONB carries a briefSnapshot on each question
  // row (if generated by genTemplate.ts). We try to extract it; fall back to
  // minimal construction from the industry key.
  const questions = Array.isArray(template.questions) ? template.questions : [];

  // Attempt to extract briefSnapshot from the first question that carries it.
  let snapshot: BrandBrief | null = null;
  for (const q of questions) {
    if (q && typeof q === "object") {
      const bs = (q as Record<string, unknown>)["briefSnapshot"];
      if (bs && typeof bs === "object" && !Array.isArray(bs)) {
        snapshot = bs as BrandBrief;
        break;
      }
    }
  }

  // Complete base brief from the industry key + template competitors — every
  // required BrandBrief field is guaranteed present here.
  const slug = template.customer_slug ?? template.industry;
  const base: BrandBrief = {
    brandName: slug,
    brandAliases: [],
    category: template.industry,  // required field
    industryKey: template.industry,
    icp: [],                       // required field
    positioning: "",
    productAttributes: [],
    seedCompetitors: Array.isArray(template.competitors)
      ? (template.competitors as Array<{ name: string; aliases: string[] }>).map((c) => ({
          name: c.name,
          aliases: c.aliases ?? [],
        }))
      : [],
    detectedLanguages: [{ code: "en", weight: 1.0, rationale: "fallback" }], // at least one required
    confidence: 0.5,
  };

  if (!snapshot) return base;

  // The stored briefSnapshot is a PARTIAL brief (genTemplate persists only
  // scalar fields like brandName/category/industryKey/positioning per question).
  // Merge it OVER the complete base so required array/detectedLanguages fields
  // are never undefined (line ~277 brief.detectedLanguages.map crashed otherwise).
  const s = snapshot as Partial<BrandBrief>;
  return {
    ...base,
    ...s,
    brandAliases: s.brandAliases?.length ? s.brandAliases : base.brandAliases,
    icp: s.icp?.length ? s.icp : base.icp,
    productAttributes: s.productAttributes?.length ? s.productAttributes : base.productAttributes,
    seedCompetitors: s.seedCompetitors?.length ? s.seedCompetitors : base.seedCompetitors,
    detectedLanguages: s.detectedLanguages?.length ? s.detectedLanguages : base.detectedLanguages,
    confidence: typeof s.confidence === "number" ? s.confidence : base.confidence,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { customer, industry, formats, languages, total } = parseArgs();

  if (!customer) {
    process.stderr.write(
      "gen-content: error — --customer <uuid> is required.\n" +
        "Usage: npm run gen-content -- --customer <uuid> --industry <key>\n",
    );
    process.exit(1);
  }

  if (!industry) {
    process.stderr.write(
      "gen-content: error — --industry <key> is required.\n" +
        "Usage: npm run gen-content -- --customer <uuid> --industry <key>\n",
    );
    process.exit(1);
  }

  // ---- Load ACTIVE template ------------------------------------------------
  process.stderr.write(`[gen-content] Loading ACTIVE template for industry="${industry}"...\n`);

  const template = await getLatestActiveTemplate(industry);
  if (!template) {
    process.stderr.write(
      `gen-content: no ACTIVE template found for industry="${industry}".\n` +
        `Use review-template --action active to activate a template first.\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `[gen-content] Found template id=${template.id} v${template.version}\n`,
  );

  // ---- Build BrandBrief ----------------------------------------------------
  const brief = briefFromTemplate(template);

  // ---- Seed claim_source rows from productAttributes -----------------------
  process.stderr.write(`[gen-content] Seeding claim_source rows from BrandBrief...\n`);
  const seededClaims = await seedClaimSourcesFromBrief(customer, brief);
  if (seededClaims.length > 0) {
    process.stderr.write(
      `[gen-content] Seeded ${seededClaims.length} new claim_source rows (awaiting sign-off).\n`,
    );
  }

  // ---- Fetch per-customer content budget caps ------------------------------
  const budgetRow = await findContentBudget(customer);
  const contentRunCeilingUsd = budgetRow?.content_run_ceiling_usd != null
    ? parseFloat(String(budgetRow.content_run_ceiling_usd))
    : env.CONTENT_RUN_CEILING_USD;

  const caps: ContentMatrixCaps = {
    max_content_assets_per_run: total ?? budgetRow?.max_content_assets_per_run ?? null,
    max_formats: formats ?? budgetRow?.max_formats ?? null,
    maxLanguages: languages ?? null,
  };

  process.stderr.write(
    `[gen-content] Content caps: max_assets=${caps.max_content_assets_per_run ?? "default"} ` +
      `max_formats=${caps.max_formats ?? "default"} ` +
      `max_languages=${caps.maxLanguages ?? "default"} ` +
      `run_ceiling=$${contentRunCeilingUsd.toFixed(2)}\n`,
  );

  // ---- Build ContentMatrix (PURE — NO token spend) -------------------------
  // Template languages for reconciliation — extract from briefSnapshot or use
  // detectedLanguages from brief.
  const templateLanguages: Array<{ code: string; weight: number }> = brief.detectedLanguages.map((l) => ({
    code: l.code,
    weight: l.weight,
  }));

  const matrixResult = buildContentMatrix(brief, { languages: templateLanguages }, caps);

  // ---- Print coverage+cost contract BEFORE any token spend -----------------
  process.stdout.write(
    "\n=== Content Coverage + Cost Contract ===\n" +
      matrixResult.summary +
      "\n" +
      `Total cells: ${matrixResult.totalCells}  ` +
      `Total variants (with over-gen): ${matrixResult.totalVariants}\n` +
      `Format set: ${matrixResult.formatSet.join(", ")}\n` +
      "=========================================\n\n",
  );

  if (matrixResult.cells.length === 0) {
    process.stderr.write(
      "gen-content: matrix is empty — no content to generate.\n" +
        "Check that the template has languages and the caps are not too restrictive.\n",
    );
    process.exit(0);
  }

  // ---- Budget preflight ----------------------------------------------------
  const budget = createQgenBudget({ runCeilingUsd: contentRunCeilingUsd });

  // Conservative estimate: $0.05 per variant call
  const estimatedUsd = matrixResult.totalVariants * 0.05;

  try {
    budget.assertGlobalGate({ estimatedUsd });
  } catch (err) {
    if (err instanceof QgenGlobalCapExceededError) {
      process.stderr.write(
        `gen-content: global ${err.capType} cap would be exceeded ` +
          `(estimated $${err.estimatedUsd.toFixed(4)}, cap $${err.capUsd.toFixed(2)}).\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  // ---- IC-04: Per-customer weekly_usd_cap check (DESIGN §11(5)) ---------------
  // findBudget returns weekly_usd_cap (a numeric column stored as string by pg).
  // sumCostSince reads the cost_daily continuous aggregate for the rolling 7-day
  // window.  Abort if already-spent + estimatedUsd would exceed the customer cap.
  {
    const customerBudgetRow = await findBudget(customer);
    if (customerBudgetRow) {
      const weeklyCapUsd = parseFloat(customerBudgetRow.weekly_usd_cap);
      if (!isNaN(weeklyCapUsd) && weeklyCapUsd > 0) {
        const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const alreadySpentUsd = (await sumCostSince(customer, weekStart)) ?? 0;

        if (alreadySpentUsd + estimatedUsd > weeklyCapUsd) {
          process.stderr.write(
            `gen-content: per-customer weekly_usd_cap would be exceeded ` +
              `(already spent $${alreadySpentUsd.toFixed(4)}, estimated $${estimatedUsd.toFixed(4)}, ` +
              `weekly cap $${weeklyCapUsd.toFixed(2)}).\n`,
          );
          process.exit(1);
        }

        process.stderr.write(
          `[gen-content] Per-customer weekly cap check: ` +
            `$${alreadySpentUsd.toFixed(4)} spent / $${weeklyCapUsd.toFixed(2)} cap ` +
            `(estimated run $${estimatedUsd.toFixed(4)}).\n`,
        );
      }
    }
  }

  // ---- Enforce per-customer asset ceiling ----------------------------------
  if (caps.max_content_assets_per_run != null && matrixResult.cells.length > caps.max_content_assets_per_run) {
    process.stderr.write(
      `gen-content: error — matrix (${matrixResult.cells.length} cells) exceeds ` +
        `max_content_assets_per_run cap (${caps.max_content_assets_per_run}).\n` +
        "The buildContentMatrix function should have clamped this — check the caps.\n",
    );
    process.exit(1);
  }

  if (caps.max_formats != null && matrixResult.formatSet.length > caps.max_formats) {
    process.stderr.write(
      `gen-content: error — format set (${matrixResult.formatSet.length}) exceeds ` +
        `max_formats cap (${caps.max_formats}).\n`,
    );
    process.exit(1);
  }

  // ---- Create content_set row ----------------------------------------------
  const contentSet = await insertContentSet({
    customerId: customer,
    industry,
    templateId: template.id,
    templateVersion: template.version,
  });
  const contentSetId = contentSet.id;

  process.stderr.write(`[gen-content] Created content_set id=${contentSetId}\n`);

  // ---- Build Gemini adapter ------------------------------------------------
  const apiKey = env.GEMINI_API_KEY;
  const adapter = makeGeminiAdapter(apiKey);

  if (!apiKey) {
    process.stderr.write(
      "[gen-content] WARNING: GEMINI_API_KEY is not set — generation will return ok:false.\n",
    );
  }

  // ---- Stage B: Generate multilingual content ------------------------------
  process.stderr.write(
    `[gen-content] Generating content for ${matrixResult.cells.length} cells ` +
      `across ${matrixResult.languageAllocations.length} languages...\n`,
  );

  let generatedItems: Awaited<ReturnType<typeof generateMultilingualContent>>["items"];
  let generatedTotal: number;

  // Load VERIFIED comparative facts (ingested competitor claim_sources) so
  // comparison_table generation builds cells from sourced claims (§7 passes).
  const comparativeFacts = (await findClaimSources(customer))
    .filter((c) => c.claim_kind === "comparative" && c.verified_by)
    .map((c) => c.claim_text);
  if (comparativeFacts.length > 0) {
    process.stderr.write(
      `[gen-content] Loaded ${comparativeFacts.length} verified comparative facts for comparison tables.\n`,
    );
  }

  try {
    const genResult = await generateMultilingualContent({
      adapter,
      brief,
      matrix: matrixResult.cells,
      genOptions: {
        runCeilingUsd: contentRunCeilingUsd,
        lowResourceLanguages: ["tl", "vi", "th"],
      },
      ledger: dbLedger,
      budget,
      customerId: customer,
      ...(comparativeFacts.length > 0 ? { comparativeFacts } : {}),
    });
    generatedItems = genResult.items;
    generatedTotal = genResult.generatedTotal;
  } catch (err) {
    if (err instanceof QgenBudgetExceededError) {
      process.stderr.write(
        `gen-content: per-run budget ceiling exceeded ` +
          `(accumulated $${err.accumulatedUsd.toFixed(4)}, ceiling $${err.ceilingUsd.toFixed(4)}).\n` +
          "Partial results will be assembled and gated.\n",
      );
      // This shouldn't happen since generateMultilingualContent handles this
      // gracefully internally — but be safe.
      process.exit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`gen-content: generation failed: ${msg}\n`);
    process.exit(1);
  }

  process.stderr.write(
    `[gen-content] Generated ${generatedTotal} raw items, ` +
      `${generatedItems.length} structurally valid.\n`,
  );

  // ---- Load claim sources for gate context ---------------------------------
  // Cast from DB row (claim_kind: string) to typed ClaimSourceRow (literal union).
  const claimSourcesRaw = await findClaimSources(customer);
  const claimSources: import("../content/types.js").ClaimSourceRow[] = claimSourcesRaw as import("../content/types.js").ClaimSourceRow[];
  process.stderr.write(
    `[gen-content] Loaded ${claimSources.length} claim_source rows for gating.\n`,
  );

  // ---- Stage D: assembleContentSet (validate + gate + persist) -------------
  process.stderr.write(
    `[gen-content] Assembling and gating content (§7 guardrail gates)...\n`,
  );

  // CO-2/IC-02 fix: build the production gate registry with the REAL Gemini
  // adapter injected into createClaimVerificationGate, so the §7#7 claim
  // extraction pass actually runs instead of failing closed to needs_human.
  // IC-03 fix: pass the same budget so extraction spend is ceiling-bounded.
  const productionGateRegistry = buildProductionContentGateRegistry({
    adapter,
    ledger: dbLedger,
    customerId: customer,
    budget,
  });

  const assembleResult = await assembleContentSet({
    contentSetId,
    customerId: customer,
    industry,
    templateId: template.id,
    templateVersion: template.version,
    generatedItems,
    jsonLdAssets: [], // JSON-LD built separately (T13); empty here for genContent
    // Include the canonical brandName alongside aliases so brand-aware gates
    // (selfContainednessGate brand-in-lead, phrasingVariation) recognize the
    // plain brand string. brief.brandAliases often omits the canonical name
    // (e.g. EMORA's is just ["EMORA AI"]), which falsely failed brand-in-lead.
    brandAliases: [brief.brandName, ...brief.brandAliases].filter((v, i, a) => v && a.indexOf(v) === i),
    claimSources,
    gates: productionGateRegistry.gates(),
    provenance: {
      model: "gemini-2.5-flash",
      generated_at: new Date().toISOString(),
    },
  });

  // ---- Output summary -------------------------------------------------------
  const output = {
    contentSetId,
    industry,
    templateId: template.id,
    templateVersion: template.version,
    totalCells: matrixResult.totalCells,
    totalVariants: matrixResult.totalVariants,
    generatedTotal,
    totalInserted: assembleResult.totalInserted,
    passedCount: assembleResult.passedCount,
    blockedCount: assembleResult.blockedCount,
    needsHumanCount: assembleResult.needsHumanCount,
    validationFailedCount: assembleResult.validationFailedCount,
    budgetUsdSpent: budget.totalUsd,
    contentRunCeilingUsd,
    message:
      assembleResult.passedCount > 0
        ? `${assembleResult.passedCount} asset(s) passed gating. Run queue-content --set ${contentSetId} to queue for Phase 3.`
        : assembleResult.needsHumanCount > 0
        ? `${assembleResult.needsHumanCount} asset(s) need human review. Run review-claims --set ${contentSetId} to review.`
        : "No assets passed gating. Review blocked assets' gate_report for details.",
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  process.stderr.write(
    `[gen-content] Done. contentSetId=${contentSetId} ` +
      `passed=${assembleResult.passedCount} blocked=${assembleResult.blockedCount} ` +
      `needs_human=${assembleResult.needsHumanCount} ` +
      `budget=$${budget.totalUsd.toFixed(4)}/$${contentRunCeilingUsd.toFixed(2)}\n`,
  );
}

// ---------------------------------------------------------------------------
// ESM main-module guard
// ---------------------------------------------------------------------------

const _selfUrl = import.meta.url;
const _selfPath = fileURLToPath(_selfUrl);
const _argv1 = process.argv[1] ?? "";

const _isCli =
  _argv1 === _selfPath ||
  _argv1.endsWith("/genContent.ts") ||
  _argv1.endsWith("\\genContent.ts") ||
  _argv1.endsWith("/genContent.js") ||
  _argv1.endsWith("\\genContent.js");

if (_isCli) {
  main().catch((err: unknown) => {
    process.stderr.write(`gen-content: fatal error: ${String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  });
}
