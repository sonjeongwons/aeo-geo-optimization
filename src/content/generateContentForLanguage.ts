/**
 * src/content/generateContentForLanguage.ts
 *
 * T07 — Per-language content generation via ONE adapter.generateStructured()
 * call PER FORMAT (within each language).
 *
 * BUG FIX (lean generation schemas):
 *   The previous implementation sent the STORAGE body schemas (FORMAT_BODY_SCHEMA_MAP)
 *   as the Gemini responseSchema.  Those storage schemas require post-generation
 *   reference fields the LLM cannot author:
 *     - AnswerBlock.numeric_claim_ids / source_ids — UUID refs to ClaimRecords that
 *       don't exist at generation time (created by claimExtract downstream).
 *     - Faq.rows[].answer_claim_ids — same post-generation UUID refs.
 *     - Comparison.rows[].cells[].claim_id / CaseStudy.metrics[].claim_id — null refs.
 *     - DefinitionSentence.meaning_key, AnswerBlock.length_units — internal/derived.
 *   Gemini could not produce valid UUIDs, so every call returned PARSE_FAILED
 *   "Response JSON did not match the expected schema" → 0 content assets produced.
 *
 *   The fix uses LEAN_GEN_SCHEMA_MAP: lean schemas containing ONLY the fields the
 *   LLM should author (no UUIDs, no derived counts, no internal keys).  After the
 *   LLM returns, buildStorageBodyWithLength() constructs the full storage body by
 *   filling derived/non-authored fields code-side.
 *
 *   Additionally, jsonld_* formats are EXCLUDED from LLM generation — they are built
 *   deterministically by jsonld.ts (T13) and must never be sent to the LLM.
 *
 * DESIGN-phase2.md §"Variant Pipeline / STAGE B":
 *   - ONE adapter.generateStructured() call per (language, format).
 *   - Over-generates ~1.3x total cell targets (reuses OVER_GEN_FACTOR) to give
 *     the phrasingVariationGate room to discard near-duplicates.
 *   - Seeds from BrandBrief DESCRIPTORS — NEVER other-language strings or
 *     machine-translated content (§6 native generation guarantee).
 *   - A STRUCTURAL GUARD rejects any output item whose language != the requested
 *     cell language (proves native generation, not covert translation).
 *   - Resilient: one format's failure does NOT abort the others (partial-return).
 *   - Budget.isWithinCeiling()/recordUsage() per call (IC-03 pattern); usage
 *     is summed across all per-format calls for the ledger.
 *   - Returns real AdapterUsage for the ledger / budget (NOT a $0 sentinel).
 *
 * Output shape per item:
 *   { format, language, channel_class, body, phrasingGroupId, candidateClaims[] }
 *
 * The body in GeneratedContentItem is the CONSTRUCTED STORAGE body (validated
 * by ContentBodySchema), NOT the lean LLM output.  Downstream code can rely on
 * it for gate evaluation and insertion.
 *
 * The candidateClaims[] is empty at this stage — claim extraction happens
 * downstream (T09 claimExtract.ts) AFTER the cheap structural gates.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { z } from "zod";
import { buildContentPromptForFormat } from "./generationPromptContent.js";
import {
  ContentBodySchema,
  ContentFormatSchema,
  ChannelClassSchema,
  LeanContentBodySchema,
  LEAN_GEN_SCHEMA_MAP,
  LLM_GENERATABLE_FORMATS,
  buildStorageBodyWithLength,
} from "./types.js";
import type { ContentBody, ContentCell, ClaimRecord, ContentFormat, LlmGeneratableFormat } from "./types.js";
import type { BrandBrief } from "../generate/types.js";
import type {
  AdapterUsage,
  GenerateStructuredRequest,
  GenerateStructuredResult,
} from "../providers/types.js";
import { NOT_CONFIGURED } from "../providers/types.js";
import { computeLengthUnits } from "./wordCount.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Over-generation factor: generate this many times the cell target count.
 * Reused from generateQuestions.ts / contentMatrix.ts.
 */
export const OVER_GEN_FACTOR = 1.3;

/** Default model for content generation calls. */
const DEFAULT_GEN_MODEL = "gemini-2.5-flash";

/** Generation temperature — slightly creative for phrasing variety. */
const GEN_TEMPERATURE = 0.7;

// ---------------------------------------------------------------------------
// Adapter port (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal adapter interface required by generateContentForLanguage.
 * Matches the GenerationAdapter in generateQuestions.ts and GeminiAdapter.
 */
export interface ContentGenerationAdapter {
  generateStructured<T extends z.ZodTypeAny>(
    req: GenerateStructuredRequest<T>
  ): Promise<GenerateStructuredResult<z.infer<T>>>;
}

// ---------------------------------------------------------------------------
// Per-format lean item schema builder
// ---------------------------------------------------------------------------

/**
 * Build the per-format LEAN item schema for one generateStructured() call.
 *
 * The `body` field uses the LEAN generation schema for the given format
 * (from LEAN_GEN_SCHEMA_MAP), NOT the full storage schema.
 *
 * This ensures zodToGeminiSchema emits the correct Gemini responseSchema
 * (an object with only author-visible fields), not the storage schema that
 * requires UUID references the LLM cannot produce.
 *
 * The envelope fields (language, format, channel_class, phrasingGroupId)
 * are the same across all formats.
 */
function buildLeanFormatItemSchema(format: LlmGeneratableFormat) {
  const leanBodySchema = LEAN_GEN_SCHEMA_MAP[format];
  return z.object({
    /** BCP-47 language tag — MUST match the requested language (native-gen guard). */
    language: z.string().min(1),
    /** Content format — one of the LLM-generatable ContentFormat enum values. */
    format: ContentFormatSchema,
    /** Target channel class. */
    channel_class: ChannelClassSchema,
    /**
     * Phrasing group identifier — groups phrasing variants of the same meaning.
     * Passed through to the ContentCell → ContentAsset phrasing_group_id.
     * Also used code-side as meaning_key for definition_sentence bodies.
     */
    phrasingGroupId: z.string().min(1),
    /**
     * Lean body object — ONLY the fields the LLM should author.
     * Post-generation fields (UUIDs, derived counts, internal keys) are absent
     * and constructed code-side by buildStorageBodyWithLength() after generation.
     */
    body: leanBodySchema,
  });
}

/**
 * Build the per-format lean response schema wrapper for one generateStructured() call.
 */
function buildLeanFormatResponseSchema(format: LlmGeneratableFormat) {
  const itemSchema = buildLeanFormatItemSchema(format);
  return z.object({
    /** Array of generated content items for this format. */
    items: z.array(itemSchema),
  });
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/**
 * One successfully generated and structurally validated content item.
 */
export interface GeneratedContentItem {
  /** Content format (matches the cell). */
  format: z.infer<typeof ContentFormatSchema>;
  /** BCP-47 language tag (validated to match the requested language). */
  language: string;
  /** Target channel class. */
  channel_class: z.infer<typeof ChannelClassSchema>;
  /**
   * Phrasing group identifier — used as phrasing_group_id in the content_asset.
   * Generated by the model to group variants of the same meaning.
   */
  phrasingGroupId: string;
  /**
   * The CONSTRUCTED FULL STORAGE body — validated by ContentBodySchema.
   * Post-generation fields are filled code-side:
   *   - meaning_key (definition_sentence) ← phrasingGroupId
   *   - length_units (answer_block) ← computeLengthUnits(text, language)
   *   - numeric_claim_ids, source_ids, answer_claim_ids ← [] (empty; filled by claimExtract)
   *   - claim_id (comparison/case_study cells) ← null (filled by claimVerify)
   */
  body: ContentBody;
  /**
   * Candidate claims array — EMPTY at generation time.
   * Populated downstream by claimExtract.ts (T09) after the cheap structural
   * gates pass.  Typed here as ClaimRecord[] for downstream convenience.
   */
  candidateClaims: ClaimRecord[];
}

export interface GenerateContentOk {
  ok: true;
  items: GeneratedContentItem[];
  /** Raw item count before structural validation (for audit). */
  rawCount: number;
  /** Summed AdapterUsage across all per-format calls for the ledger and per-run budget. */
  usage: AdapterUsage;
}

export interface GenerateContentError {
  ok: false;
  code: string;
  message: string;
  /** Zero usage for error cases (no real call was made or call failed). */
  usage?: AdapterUsage;
}

export type GenerateContentResult = GenerateContentOk | GenerateContentError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the total target variant count across a set of cells.
 */
function sumCellTargets(cells: ContentCell[]): number {
  return cells.reduce((s, c) => s + c.targetVariants, 0);
}

/**
 * Compute the over-generated total (1.3x, integer ceiling).
 */
export function overGenTotal(cellTotal: number): number {
  return Math.ceil(cellTotal * OVER_GEN_FACTOR);
}

/**
 * Accumulate AdapterUsage values.
 */
function addUsage(a: AdapterUsage, b: AdapterUsage): AdapterUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    usd: a.usd + b.usd,
    cacheHit: a.cacheHit && b.cacheHit,
  };
}

const ZERO_USAGE: AdapterUsage = {
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
  cacheHit: false,
};

/**
 * Returns true if the given format is LLM-generatable (not a jsonld_* format).
 */
function isLlmGeneratableFormat(format: ContentFormat): format is LlmGeneratableFormat {
  return (LLM_GENERATABLE_FORMATS as readonly string[]).includes(format);
}

// ---------------------------------------------------------------------------
// generateContentForLanguage — main export
// ---------------------------------------------------------------------------

/**
 * Make ONE adapter.generateStructured() call PER FORMAT for a single language,
 * using each format's LEAN body schema (LEAN_GEN_SCHEMA_MAP), then build
 * the full storage body code-side via buildStorageBodyWithLength(), and return
 * all GeneratedContentItem[].
 *
 * jsonld_* formats are SKIPPED — they are built deterministically by jsonld.ts
 * and must never be sent to the LLM.
 *
 * Resilience: one format's failure (NOT_CONFIGURED, PARSE_FAILED, etc.) does
 * NOT abort the other formats — partial results are returned.  If ALL formats
 * fail, returns ok:false with the first error code encountered.
 *
 * Mirrors generateQuestionsForLanguage from generate/generateQuestions.ts.
 *
 * @param opts.adapter    Adapter with generateStructured().
 * @param opts.language   BCP-47 language code — ALL cells MUST share this language.
 * @param opts.cells      ContentCells for this language (multiple formats/channels).
 * @param opts.brief      BrandBrief for prompt seeding (descriptors, NOT strings).
 * @param opts.modelId    Optional model override (default: gemini-2.5-flash).
 * @returns GenerateContentResult — never throws.
 */
export async function generateContentForLanguage(opts: {
  adapter: ContentGenerationAdapter;
  language: string;
  cells: ContentCell[];
  brief: BrandBrief;
  modelId?: string;
  /** Verified sourced competitor facts for comparison_table generation (SOTA H/I + competitor ingest). */
  comparativeFacts?: string[];
}): Promise<GenerateContentResult> {
  const { adapter, language, cells, brief, modelId = DEFAULT_GEN_MODEL, comparativeFacts } = opts;

  if (cells.length === 0) {
    return { ok: true, items: [], rawCount: 0, usage: ZERO_USAGE };
  }

  // ---- Filter out jsonld_* cells — those are built by jsonld.ts, not the LLM ----
  const llmCells = cells.filter((c) => isLlmGeneratableFormat(c.format));

  if (llmCells.length === 0) {
    // All cells were jsonld_* — nothing for the LLM to do
    return { ok: true, items: [], rawCount: 0, usage: ZERO_USAGE };
  }

  // ---- Group cells by format ----
  const cellsByFormat = new Map<LlmGeneratableFormat, ContentCell[]>();
  for (const cell of llmCells) {
    // isLlmGeneratableFormat guard above ensures this cast is safe
    const fmt = cell.format as LlmGeneratableFormat;
    const existing = cellsByFormat.get(fmt);
    if (existing) {
      existing.push(cell);
    } else {
      cellsByFormat.set(fmt, [cell]);
    }
  }

  // ---- Accumulate results across all per-format calls ----
  const allValidItems: GeneratedContentItem[] = [];
  let totalRawCount = 0;
  let accUsage: AdapterUsage = { ...ZERO_USAGE };

  // Track whether any format succeeded (for partial-return vs. all-failed logic)
  let anySuccess = false;
  let firstErrorCode = "PROVIDER_ERROR";
  let firstErrorMessage = `All format calls failed for language "${language}"`;

  for (const [format, formatCells] of cellsByFormat) {
    // ---- Compute over-generated target for this format's cells ----
    const cellTotal = sumCellTargets(formatCells);
    const totalItemsRequested = overGenTotal(cellTotal);

    // ---- Build native prompt for this specific format ----
    const { systemInstruction, userPrompt } = buildContentPromptForFormat({
      language,
      format,
      cells: formatCells,
      brief,
      totalItemsRequested,
      ...(comparativeFacts !== undefined ? { comparativeFacts } : {}),
    });

    // ---- Build LEAN per-format response schema ----
    const leanResponseSchema = buildLeanFormatResponseSchema(format);

    // ---- Gemini structured call ----
    const req: GenerateStructuredRequest<typeof leanResponseSchema> = {
      modelId,
      prompt: userPrompt,
      systemInstruction,
      temperature: GEN_TEMPERATURE,
      schema: leanResponseSchema,
    };

    let result: GenerateStructuredResult<z.infer<typeof leanResponseSchema>>;
    try {
      result = await adapter.generateStructured(req);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // One format failure does not abort the others
      console.warn(
        `[generateContentForLanguage] Unexpected error for language="${language}" format="${format}": ${msg} — skipping format.`
      );
      if (!anySuccess) {
        firstErrorCode = "PROVIDER_ERROR";
        firstErrorMessage = `Unexpected error calling generateStructured for language "${language}" format "${format}": ${msg}`;
      }
      continue;
    }

    // ---- NOT_CONFIGURED: abort all (key is absent for ALL calls) ----
    if (!result.ok && result.code === NOT_CONFIGURED) {
      return {
        ok: false,
        code: NOT_CONFIGURED,
        message: `GEMINI_API_KEY not configured; cannot generate content for language "${language}".`,
      };
    }

    // ---- Other structured errors (PARSE_FAILED, RATE_LIMITED, etc.) ----
    if (!result.ok) {
      const msg =
        "message" in result && result.message
          ? result.message
          : `generateStructured failed for language "${language}" format "${format}" with code: ${result.code}`;
      const callUsage =
        "usage" in result && result.usage ? result.usage : ZERO_USAGE;
      accUsage = addUsage(accUsage, callUsage);
      console.warn(
        `[generateContentForLanguage] Format call failed language="${language}" format="${format}": ${msg} — skipping format.`
      );
      if (!anySuccess) {
        firstErrorCode = result.code;
        firstErrorMessage = msg;
      }
      continue;
    }

    // ---- Successful format call ----
    anySuccess = true;
    const callUsage = result.usage;
    accUsage = addUsage(accUsage, callUsage);

    const rawItems = result.data.items;
    totalRawCount += rawItems.length;

    // ---- Validate each item and construct storage body ----
    for (const raw of rawItems) {
      // (1) STRUCTURAL GUARD — language tag must match the requested language.
      //     Any mismatch proves the model attempted covert translation rather than
      //     native generation; we reject the item.
      if (raw.language !== language) {
        console.warn(
          `[generateContentForLanguage] Language mismatch for "${language}": ` +
            `item.language="${raw.language}" — rejecting (native-gen guard).`
        );
        continue;
      }

      // (2) Validate the lean body via LeanContentBodySchema.
      //     The body is already typed by the lean per-format schema, but we run it
      //     through LeanContentBodySchema to produce the discriminated-union type.
      //     Per-item failures are dropped rather than aborting the format call.
      const leanParseResult = LeanContentBodySchema.safeParse(raw.body);
      if (!leanParseResult.success) {
        console.warn(
          `[generateContentForLanguage] Lean body schema mismatch for "${language}" ` +
            `format="${raw.format}": ${leanParseResult.error.message} — dropping item.`
        );
        continue;
      }

      // (3) Compute length_units for answer_block (needed by buildStorageBodyWithLength).
      //     For other formats, pass 0 (the field is not used).
      const leanBody = leanParseResult.data;
      const lengthUnits =
        leanBody.content_type === "answer_block"
          ? computeLengthUnits(leanBody.text, language)
          : 0;

      // (4) Construct the FULL STORAGE body — fills all post-generation fields
      //     (meaning_key, length_units, numeric_claim_ids[], source_ids[],
      //      answer_claim_ids[], claim_id=null) that the LLM must not author.
      const storageBody = buildStorageBodyWithLength(
        leanBody,
        raw.phrasingGroupId,
        lengthUnits
      );

      // (5) Validate the constructed storage body against ContentBodySchema.
      //     This catches any construction error and ensures the stored body is valid.
      const bodyParseResult = ContentBodySchema.safeParse(storageBody);
      if (!bodyParseResult.success) {
        // This indicates a buildStorageBodyWithLength bug — log as error, not warn.
        console.error(
          `[generateContentForLanguage] Storage body construction failed for "${language}" ` +
            `format="${raw.format}": ${bodyParseResult.error.message} — dropping item.`
        );
        continue;
      }

      allValidItems.push({
        format: raw.format,
        language: raw.language,
        channel_class: raw.channel_class,
        phrasingGroupId: raw.phrasingGroupId,
        body: bodyParseResult.data,
        // candidateClaims is always empty at generation time;
        // populated downstream by claimExtract.ts (T09).
        candidateClaims: [],
      });
    }
  }

  // ---- All formats failed and none succeeded ----
  if (!anySuccess && cellsByFormat.size > 0) {
    return {
      ok: false,
      code: firstErrorCode,
      message: firstErrorMessage,
      usage: accUsage,
    };
  }

  return {
    ok: true,
    items: allValidItems,
    rawCount: totalRawCount,
    usage: accUsage,
  };
}
