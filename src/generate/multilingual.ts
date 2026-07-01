/**
 * src/generate/multilingual.ts
 *
 * T10 — Native multilingual generation + per-language allocation.
 *
 * DESIGN-phase1.md §"Multilingual Pipeline (§6)" / §Cost Design (§11):
 *
 *   1. Groups IntentCell[] by language.
 *   2. For EACH language, makes ONE adapter.generateStructured() call via
 *      generateQuestionsForLanguage() (batched across all cells for that language).
 *      Native generation in the target language — NOT machine translation.
 *      Seed = intent DESCRIPTORS + brand/category/wedge from BrandBrief.
 *   3. Over-generates ~1.3x each cell's targetCount (cap 1.3x) to give the
 *      downstream dedup/guardrail stages room.
 *   4. Returns DraftQuestion[] with: text, language, funnel_stage, density_tier,
 *      intentType, phrasingGroupId.
 *   5. Flags low-resource languages (tl, vi, th by default) — needs_native_review
 *      is set in the JSONB via provenance; the field is part of the return contract.
 *   6. COST/BUDGET: before each language call, checks the per-run budget ceiling;
 *      records spend via the injected ledger; gracefully stops on exhaustion
 *      (returns partial results, does NOT throw QgenBudgetExceededError to caller —
 *      the consumers handle partial completion; the budget accumulator is updated
 *      so genTemplate.ts can read totalUsd).
 *   7. RESILIENCE: a NOT_CONFIGURED or structured error for ONE language logs a
 *      warning and continues to other languages (partial return pattern).
 *
 * EXACT REQUIRED EXPORT (consumers genTemplate.ts + api/routes/generate.ts depend
 * on this signature byte-for-byte):
 *
 *   export async function generateMultilingual(opts: {
 *     adapter: { generateStructured<T extends z.ZodTypeAny>(req): Promise<...> };
 *     brief: BrandBrief;
 *     matrix: IntentCell[];
 *     genOptions: GenOptions;
 *     ledger: LedgerPort;
 *     budget: ReturnType<typeof createQgenBudget>;
 *   }): Promise<{ questions: DraftQuestion[]; generatedTotal: number }>;
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { z } from 'zod';
import { generateQuestionsForLanguage } from './generateQuestions.js';
import type { BrandBrief, DraftQuestion, GenOptions, IntentCell } from './types.js';
import type { GenerateStructuredRequest, GenerateStructuredResult } from '../providers/types.js';
import { NOT_CONFIGURED } from '../providers/types.js';
import type { LedgerPort } from './diagnose.js';
import type { createQgenBudget } from '../cost/qgenBudget.js';

// ---------------------------------------------------------------------------
// Adapter port (matches genTemplate.ts MultilingualAdapter exactly)
// ---------------------------------------------------------------------------

/**
 * Minimal adapter interface required by generateMultilingual.
 * Matches MultilingualAdapter in genTemplate.ts and api/routes/generate.ts.
 */
interface MultilingualAdapter {
  generateStructured<T extends z.ZodTypeAny>(
    req: GenerateStructuredRequest<T>
  ): Promise<GenerateStructuredResult<z.infer<T>>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Provider string written to llm_call ledger rows. */
const PROVIDER = 'gemini';

/** Default model for generation (same as diagnosis, per cost design). */
const DEFAULT_GEN_MODEL = 'gemini-2.5-flash';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group IntentCell[] by language code.
 * Returns a Map<language, IntentCell[]> preserving the order cells appear.
 */
function groupCellsByLanguage(matrix: IntentCell[]): Map<string, IntentCell[]> {
  const map = new Map<string, IntentCell[]>();
  for (const cell of matrix) {
    const arr = map.get(cell.language) ?? [];
    arr.push(cell);
    map.set(cell.language, arr);
  }
  return map;
}

// ---------------------------------------------------------------------------
// generateMultilingual — EXACT required export
// ---------------------------------------------------------------------------

/**
 * Run native per-language question generation across all languages in the matrix.
 *
 * @param opts.adapter      Adapter with generateStructured().
 * @param opts.brief        BrandBrief from diagnosis (seeds prompts).
 * @param opts.matrix       IntentCell[] from buildIntentMatrix() with density tiers applied.
 * @param opts.genOptions   GenOptions (carries modelId override + lowResourceLanguages).
 * @param opts.ledger       LedgerPort for writing llm_call rows per language call.
 * @param opts.budget       QgenRunBudget instance — checked before each call; spend recorded after.
 * @returns { questions: DraftQuestion[]; generatedTotal: number }
 *   questions      — all generated DraftQuestion[] (pre-dedup/guard; may be partial on budget stop).
 *   generatedTotal — total question count before any downstream filtering.
 */
export async function generateMultilingual(opts: {
  adapter: MultilingualAdapter;
  brief: BrandBrief;
  matrix: IntentCell[];
  genOptions: GenOptions;
  ledger: LedgerPort;
  budget: ReturnType<typeof createQgenBudget>;
}): Promise<{ questions: DraftQuestion[]; generatedTotal: number }> {
  const { adapter, brief, matrix, genOptions, ledger, budget } = opts;

  const modelId = genOptions.modelId ?? DEFAULT_GEN_MODEL;
  const lowResourceLangs = new Set(genOptions.lowResourceLanguages ?? ['tl', 'vi', 'th']);

  // ---- Group cells by language ----
  const langGroups = groupCellsByLanguage(matrix);

  const allQuestions: DraftQuestion[] = [];
  let generatedTotal = 0;

  // ---- Process each language ----
  for (const [language, cells] of langGroups) {
    // ---- Budget check: stop gracefully if already over ceiling ----
    if (!budget.isWithinCeiling()) {
      console.warn(
        `[multilingual] Budget ceiling reached after ${generatedTotal} questions; ` +
          `stopping before language "${language}".`,
      );
      break;
    }

    // ---- Make ONE structured call per language ----
    const langResult = await generateQuestionsForLanguage({
      adapter,
      language,
      cells,
      brief,
      modelId,
    });

    if (!langResult.ok) {
      if (langResult.code === NOT_CONFIGURED) {
        // NOT_CONFIGURED is a permanent error — log clearly but continue to other langs
        console.warn(
          `[multilingual] Adapter not configured for language "${language}" ` +
            `(NOT_CONFIGURED). Skipping.`,
        );
      } else {
        // Other errors (RATE_LIMITED, TIMEOUT, PARSE_FAILED, etc.) — log and continue
        console.warn(
          `[multilingual] Generation failed for language "${language}" ` +
            `[${langResult.code}]: ${langResult.message}. Skipping.`,
        );
      }
      continue;
    }

    // ---- Record spend via ledger and budget accumulator (§11) ----
    // generateQuestionsForLanguage returns the REAL AdapterUsage from the
    // structured call (langResult.usage), so we ledger the actual tokens/usd and
    // feed the per-run budget accumulator with the true spend (not a $0 sentinel).
    const usage = langResult.usage;

    ledger
      .insertLlmCall({
        customerId: null,
        runId: null,
        purpose: 'generation',
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
        console.warn(`[multilingual] Ledger write failed for language "${language}" (non-fatal): ${msg}`);
      });

    // Keep this language's already-generated (and already-paid-for) questions
    // BEFORE charging the budget, so a ceiling breach never discards work we paid
    // for. recordUsage throws QgenBudgetExceededError once the per-run ceiling is
    // crossed; we then stop gracefully and return the partial result.
    let budgetExceeded = false;
    try {
      budget.recordUsage(usage.usd);
    } catch {
      budgetExceeded = true;
    }

    // ---- Annotate questions with low-resource review flag (provenance) ----
    const isLowResource = lowResourceLangs.has(language);
    const langQuestions = langResult.questions.map((q) => {
      if (!isLowResource) return q;
      // Attach needs_native_review as a non-enumerated extra field.
      // DraftQuestionSchema is open at the DraftQuestion type level (z.object with no .strict()),
      // but the ts type doesn't include this field. We cast through unknown to add it for
      // the JSONB provenance without affecting schema validation of the canonical fields.
      return Object.assign({}, q, { needs_native_review: true }) as DraftQuestion;
    });

    generatedTotal += langResult.rawCount;
    allQuestions.push(...langQuestions);

    if (budgetExceeded) {
      console.warn(
        `[multilingual] Per-run budget ceiling reached after language "${language}"; ` +
          `stopping (kept ${allQuestions.length} questions generated so far).`,
      );
      break;
    }

    console.info(
      `[multilingual] Language "${language}": generated ${langResult.questions.length} questions ` +
        `(raw: ${langResult.rawCount})` +
        (isLowResource ? ' [needs_native_review]' : ''),
    );
  }

  return { questions: allQuestions, generatedTotal };
}
