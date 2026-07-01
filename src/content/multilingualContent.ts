/**
 * src/content/multilingualContent.ts
 *
 * T08 — Multilingual content orchestration (budget + ledger + partial-return).
 *
 * DESIGN-phase2.md §"Variant Pipeline / STAGE B" / §Cost Design (§11):
 *
 *   1. Groups ContentCell[] by language (same grouping logic as multilingual.ts
 *      for questions, mirrored exactly here).
 *   2. For EACH language, calls generateContentForLanguage() — ONE adapter
 *      call per language, batched across all cells for that language.
 *      Native generation in the target language (§6) — NOT machine translation.
 *   3. Before EACH language call, checks budget.isWithinCeiling().  If already
 *      over, stops gracefully and returns the partial result (does NOT throw to
 *      the caller).
 *   4. Records actual spend via insertLlmCall(purpose:'generation') + recordUsage()
 *      AFTER each successful call.  Gracefully stops on QgenBudgetExceededError
 *      and keeps the questions already generated (already paid for).
 *   5. Flags low-resource languages (default: tl, vi, th) by attaching
 *      needs_native_review=true on each GeneratedContentItem returned for those
 *      languages.  This routes assets toward needs_human downstream.
 *   6. Uses CONTENT_RUN_CEILING_USD (~$2) — NOT the $0.50 qgen default.
 *      The caller passes createQgenBudget({ runCeilingUsd: CONTENT_RUN_CEILING_USD }).
 *
 * EXACT REQUIRED EXPORT (consumers assembleContentSet.ts + tests depend on
 * this signature):
 *
 *   export async function generateMultilingualContent(opts: {
 *     adapter: ContentGenerationAdapter;
 *     brief: BrandBrief;
 *     matrix: ContentCell[];
 *     genOptions: ContentGenOptions;
 *     ledger: LedgerPort;
 *     budget: ReturnType<typeof createQgenBudget>;
 *     customerId?: string | null;
 *   }): Promise<{ items: GeneratedContentItemWithReview[]; generatedTotal: number }>;
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import type { z } from "zod";
import {
  generateContentForLanguage,
  type ContentGenerationAdapter,
  type GeneratedContentItem,
} from "./generateContentForLanguage.js";
import type { ContentCell, ContentGenOptions } from "./types.js";
import type { BrandBrief } from "../generate/types.js";
import type {
  GenerateStructuredRequest,
  GenerateStructuredResult,
} from "../providers/types.js";
import { NOT_CONFIGURED } from "../providers/types.js";
import { QgenBudgetExceededError } from "../cost/qgenBudget.js";
import type { createQgenBudget } from "../cost/qgenBudget.js";

// ---------------------------------------------------------------------------
// Ledger port (injectable for tests) — matches diagnose.ts LedgerPort exactly
// ---------------------------------------------------------------------------

/**
 * Port for writing llm_call ledger rows.
 * In production this is insertLlmCall from repo.ts.
 * In tests it may be a no-op stub.
 */
export interface LedgerPort {
  insertLlmCall(c: {
    customerId: string | null;
    runId: string | null;
    purpose: "generation" | "judge";
    provider: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    usd: number;
    cacheHit: boolean;
    responseRawId: string | null;
  }): Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/**
 * A GeneratedContentItem annotated with the low-resource-language review flag.
 * This flag is set by the orchestrator (not by generateContentForLanguage which
 * has no budget/ledger awareness).
 */
export interface GeneratedContentItemWithReview extends GeneratedContentItem {
  /**
   * True when the asset's language is in the low-resource set (default: tl, vi, th).
   * Assets with this flag are routed toward needs_human downstream.
   */
  needs_native_review: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Provider string written to llm_call ledger rows. */
const PROVIDER = "gemini";

/** Default model for content generation (same as diagnosis, per cost design). */
const DEFAULT_GEN_MODEL = "gemini-2.5-flash";

/**
 * Default set of low-resource language codes.
 * Assets in these languages require native-speaker review and are routed
 * toward needs_human downstream.
 * DESIGN-phase2.md §"Variant Pipeline / STAGE B".
 */
export const DEFAULT_LOW_RESOURCE_LANGUAGES: readonly string[] = ["tl", "vi", "th"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group ContentCell[] by language code.
 * Returns a Map<language, ContentCell[]> preserving the order cells appear.
 * Mirrors groupCellsByLanguage in multilingual.ts.
 */
function groupCellsByLanguage(matrix: ContentCell[]): Map<string, ContentCell[]> {
  const map = new Map<string, ContentCell[]>();
  for (const cell of matrix) {
    const arr = map.get(cell.language) ?? [];
    arr.push(cell);
    map.set(cell.language, arr);
  }
  return map;
}

// ---------------------------------------------------------------------------
// generateMultilingualContent — main export
// ---------------------------------------------------------------------------

/**
 * Run native per-language content generation across all languages in the matrix.
 *
 * Mirrors generateMultilingual() from generate/multilingual.ts but operates on
 * ContentCell[] and returns GeneratedContentItemWithReview[].
 *
 * @param opts.adapter       Adapter with generateStructured().
 * @param opts.brief         BrandBrief (seeds prompts with descriptors, NOT strings).
 * @param opts.matrix        ContentCell[] from buildContentMatrix().
 * @param opts.genOptions    ContentGenOptions (ceiling, model override, low-resource langs).
 * @param opts.ledger        LedgerPort for writing llm_call rows per language call.
 * @param opts.budget        QgenRunBudget — checked before each call; spend recorded after.
 * @param opts.customerId    Customer UUID for ledger rows (null for owned-net generic assets).
 * @returns { items, generatedTotal }
 *   items          — all generated items (pre-gate; may be partial on budget stop).
 *   generatedTotal — total raw item count before structural validation filtering.
 */
export async function generateMultilingualContent(opts: {
  adapter: ContentGenerationAdapter;
  brief: BrandBrief;
  matrix: ContentCell[];
  genOptions: ContentGenOptions;
  ledger: LedgerPort;
  budget: ReturnType<typeof createQgenBudget>;
  customerId?: string | null;
  /** Verified sourced competitor facts threaded into comparison_table generation. */
  comparativeFacts?: string[];
}): Promise<{ items: GeneratedContentItemWithReview[]; generatedTotal: number }> {
  const { adapter, brief, matrix, genOptions, ledger, budget, customerId = null, comparativeFacts } = opts;

  const modelId = genOptions.modelId ?? DEFAULT_GEN_MODEL;
  const lowResourceLangs = new Set(
    genOptions.lowResourceLanguages ?? [...DEFAULT_LOW_RESOURCE_LANGUAGES]
  );

  // ---- Group cells by language ----
  const langGroups = groupCellsByLanguage(matrix);

  const allItems: GeneratedContentItemWithReview[] = [];
  let generatedTotal = 0;

  // ---- Process each language ----
  for (const [language, cells] of langGroups) {
    // ---- Budget check: stop gracefully if already over ceiling ----
    if (!budget.isWithinCeiling()) {
      console.warn(
        `[multilingualContent] Budget ceiling reached after ${generatedTotal} items; ` +
          `stopping before language "${language}".`
      );
      break;
    }

    // ---- Make ONE structured call per language ----
    const langResult = await generateContentForLanguage({
      adapter,
      language,
      cells,
      brief,
      modelId,
      ...(comparativeFacts !== undefined ? { comparativeFacts } : {}),
    });

    if (!langResult.ok) {
      if (langResult.code === NOT_CONFIGURED) {
        // NOT_CONFIGURED is a permanent error — log clearly but continue to other langs
        console.warn(
          `[multilingualContent] Adapter not configured for language "${language}" ` +
            `(NOT_CONFIGURED). Skipping.`
        );
      } else {
        // Other errors (RATE_LIMITED, TIMEOUT, PARSE_FAILED, etc.) — log and continue
        console.warn(
          `[multilingualContent] Generation failed for language "${language}" ` +
            `[${langResult.code}]: ${langResult.message ?? "(no message)"}. Skipping.`
        );
      }
      continue;
    }

    // ---- Record spend via ledger and budget accumulator (§11) ----
    // generateContentForLanguage returns the REAL AdapterUsage from the
    // structured call (langResult.usage), so we ledger the actual tokens/usd
    // and feed the per-run budget accumulator with the true spend.
    const usage = langResult.usage;

    ledger
      .insertLlmCall({
        customerId: customerId ?? null,
        runId: null,
        purpose: "generation",
        provider: PROVIDER,
        modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        usd: usage.usd,
        cacheHit: usage.cacheHit,
        responseRawId: null,
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[multilingualContent] Ledger write failed for language "${language}" (non-fatal): ${msg}`
        );
      });

    // Keep this language's already-generated (and already-paid-for) items
    // BEFORE charging the budget, so a ceiling breach never discards work we
    // paid for.  recordUsage throws QgenBudgetExceededError once the per-run
    // ceiling is crossed; we then stop gracefully and return the partial result.
    let budgetExceeded = false;
    try {
      budget.recordUsage(usage.usd);
    } catch (err: unknown) {
      if (err instanceof QgenBudgetExceededError) {
        budgetExceeded = true;
      } else {
        // Non-budget errors are unexpected; re-throw to surface them.
        throw err;
      }
    }

    // ---- Annotate items with low-resource review flag ----
    const isLowResource = lowResourceLangs.has(language);
    const langItems: GeneratedContentItemWithReview[] = langResult.items.map((item) => ({
      ...item,
      needs_native_review: isLowResource,
    }));

    generatedTotal += langResult.rawCount;
    allItems.push(...langItems);

    if (budgetExceeded) {
      console.warn(
        `[multilingualContent] Per-run budget ceiling reached after language "${language}"; ` +
          `stopping (kept ${allItems.length} items generated so far).`
      );
      break;
    }

    console.info(
      `[multilingualContent] Language "${language}": generated ${langResult.items.length} items ` +
        `(raw: ${langResult.rawCount})` +
        (isLowResource ? " [needs_native_review]" : "")
    );
  }

  return { items: allItems, generatedTotal };
}
