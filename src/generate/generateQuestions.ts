/**
 * src/generate/generateQuestions.ts
 *
 * Per-language Gemini structured call for native question generation.
 *
 * DESIGN-phase1.md §"Multilingual Pipeline (§6)" / §"Question Model & Generation" step 3:
 *   - ONE adapter.generateStructured() call per language, batched across all cells
 *     for that language.
 *   - Over-generates ~1.3x total cell targets (capped) to give dedup/guardrail room.
 *   - Seeds from intent DESCRIPTORS only (never English question strings).
 *   - Flags low-resource languages (tl, vi, th) with needs_native_review in the output.
 *   - Resilient: NOT_CONFIGURED / structured errors return ok:false, never throw.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { z } from 'zod';
import { buildGenerationPrompt } from './generationPrompt.js';
import type { BrandBrief, DraftQuestion, IntentCell, IntentType } from './types.js';
import { DraftQuestionSchema } from './types.js';
import type { AdapterUsage, GenerateStructuredRequest, GenerateStructuredResult } from '../providers/types.js';
import { NOT_CONFIGURED } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Over-generation multiplier: generate this many times the cell targetCount.
 * Capped at 1.3x per DESIGN-phase1.md §"Question Model & Generation" step 3.
 */
export const OVER_GEN_FACTOR = 1.3;

/** Default model for generation calls. */
const DEFAULT_GEN_MODEL = 'gemini-2.5-flash';

/** Generation temperature — slightly creative to get phrasing variety. */
const GEN_TEMPERATURE = 0.7;

// ---------------------------------------------------------------------------
// Adapter port (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal adapter interface required by generateQuestionsForLanguage.
 * Matches the MultilingualAdapter interface in genTemplate.ts / generate.ts.
 */
export interface GenerationAdapter {
  generateStructured<T extends z.ZodTypeAny>(
    req: GenerateStructuredRequest<T>
  ): Promise<GenerateStructuredResult<z.infer<T>>>;
}

// ---------------------------------------------------------------------------
// Zod schema for the model's structured response
// ---------------------------------------------------------------------------

/**
 * Schema for one question item returned by the model.
 * The model returns intentType and funnelStage as strings so we can map them
 * to the proper cell values. We coerce to valid enum values where possible.
 */
const RawQuestionItemSchema = z.object({
  text: z.string().min(1),
  intentType: z.string().min(1),
  funnelStage: z.string().min(1),
  phrasingGroupId: z.string().min(1),
});

const GenerationResponseSchema = z.object({
  questions: z.array(RawQuestionItemSchema),
});

type GenerationResponse = z.infer<typeof GenerationResponseSchema>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface GenerateQuestionsOk {
  ok: true;
  questions: DraftQuestion[];
  /** Raw count before validation filtering. */
  rawCount: number;
  /** Usage from the adapter call (for cost ledger and budget accumulator). */
  usage: AdapterUsage;
}

export interface GenerateQuestionsError {
  ok: false;
  code: string;
  message: string;
}

export type GenerateQuestionsResult = GenerateQuestionsOk | GenerateQuestionsError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate and coerce a raw intentType string to a valid IntentType.
 * Falls back to the cell's intentType when the model returns something unexpected.
 */
function coerceIntentType(raw: string, fallback: IntentType): IntentType {
  const valid: IntentType[] = ['brand', 'category', 'comparison', 'alternative', 'useCase', 'attribute'];
  if (valid.includes(raw as IntentType)) return raw as IntentType;
  return fallback;
}

/**
 * Validate and coerce a raw funnelStage string to a valid funnel stage string.
 * Falls back to 'awareness' when invalid.
 */
function coerceFunnelStage(raw: string): 'awareness' | 'consideration' | 'decision' {
  if (raw === 'awareness' || raw === 'consideration' || raw === 'decision') return raw;
  return 'awareness';
}

/**
 * Compute the total target count across a set of cells.
 */
function sumCellTargets(cells: IntentCell[]): number {
  return cells.reduce((s, c) => s + c.targetCount, 0);
}

/**
 * Compute the over-generated total (1.3x, integer ceiling).
 */
export function overGenTotal(cellTotal: number): number {
  return Math.ceil(cellTotal * OVER_GEN_FACTOR);
}

// ---------------------------------------------------------------------------
// generateQuestionsForLanguage — main export
// ---------------------------------------------------------------------------

/**
 * Make ONE adapter.generateStructured() call for a single language, batched
 * across all that language's IntentCells, and return DraftQuestion[].
 *
 * @param opts.adapter          Adapter with generateStructured().
 * @param opts.language         BCP-47 language code.
 * @param opts.cells            IntentCells for this language.
 * @param opts.brief            BrandBrief for prompt seeding.
 * @param opts.modelId          Optional model override (default: gemini-2.5-flash).
 * @returns GenerateQuestionsResult — never throws.
 */
export async function generateQuestionsForLanguage(opts: {
  adapter: GenerationAdapter;
  language: string;
  cells: IntentCell[];
  brief: BrandBrief;
  modelId?: string;
}): Promise<GenerateQuestionsResult> {
  const { adapter, language, cells, brief, modelId = DEFAULT_GEN_MODEL } = opts;

  const ZERO_USAGE: AdapterUsage = { inputTokens: 0, outputTokens: 0, usd: 0, cacheHit: false };

  if (cells.length === 0) {
    return { ok: true, questions: [], rawCount: 0, usage: ZERO_USAGE };
  }

  // ---- Compute over-generated target ----
  const cellTotal = sumCellTargets(cells);
  const totalVariantsRequested = overGenTotal(cellTotal);

  // ---- Build prompt ----
  const { systemInstruction, userPrompt } = buildGenerationPrompt({
    language,
    cells,
    brief,
    totalVariantsRequested,
  });

  // ---- Structured Gemini call ----
  const req: GenerateStructuredRequest<typeof GenerationResponseSchema> = {
    modelId,
    prompt: userPrompt,
    systemInstruction,
    temperature: GEN_TEMPERATURE,
    schema: GenerationResponseSchema,
  };

  let result: GenerateStructuredResult<GenerationResponse>;
  try {
    result = await adapter.generateStructured(req);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'PROVIDER_ERROR',
      message: `Unexpected error calling generateStructured for language "${language}": ${msg}`,
    };
  }

  // ---- NOT_CONFIGURED ----
  if (!result.ok && result.code === NOT_CONFIGURED) {
    return {
      ok: false,
      code: NOT_CONFIGURED,
      message: `GEMINI_API_KEY not configured; cannot generate questions for language "${language}".`,
    };
  }

  // ---- Other errors ----
  if (!result.ok) {
    const msg =
      'message' in result && result.message
        ? result.message
        : `generateStructured failed for language "${language}" with code: ${result.code}`;
    return { ok: false, code: result.code, message: msg };
  }

  // ---- Map raw items to DraftQuestion[] ----
  const rawItems = result.data.questions;

  // Build a quick cell lookup for density_tier defaults
  // (density_tier will be overwritten by applyDensityToQuestions later;
  //  we use the cell's densityTier as the initial value here so schema validates)
  const cellByIntent = new Map<string, IntentCell>();
  for (const cell of cells) {
    cellByIntent.set(`${cell.intentType}:${cell.funnelStage}`, cell);
  }

  // Fallback cell for when the model returns an unexpected intent/funnel combination
  const fallbackCell = cells[0]!;

  const questions: DraftQuestion[] = [];

  for (const raw of rawItems) {
    const intentType = coerceIntentType(raw.intentType, fallbackCell.intentType);
    const funnelStage = coerceFunnelStage(raw.funnelStage);

    // Find the best matching cell for density_tier lookup
    const matchedCell =
      cellByIntent.get(`${intentType}:${funnelStage}`) ??
      cellByIntent.get(`${intentType}:awareness`) ??
      fallbackCell;

    const candidate: DraftQuestion = {
      text: raw.text,
      language,
      funnel_stage: funnelStage,
      density_tier: matchedCell.densityTier, // will be rewritten by applyDensityToQuestions
      intentType,
      phrasingGroupId: raw.phrasingGroupId,
    };

    // Validate against DraftQuestionSchema to filter out malformed items
    const parseResult = DraftQuestionSchema.safeParse(candidate);
    if (parseResult.success) {
      questions.push(parseResult.data);
    }
  }

  return {
    ok: true,
    questions,
    rawCount: rawItems.length,
    usage: result.usage,
  };
}
