/**
 * src/generate/types.ts
 *
 * Phase 1 domain types as zod schemas.
 *
 * Exported schemas and inferred TS types:
 *   - BrandBrief          — inferred from URL diagnosis (one Gemini call)
 *   - IntentTypeSchema     — brand|category|comparison|alternative|useCase|attribute
 *   - FunnelStageSchema    — awareness|consideration|decision
 *   - IntentCellSchema     — one coverage cell in the IntentMatrix
 *   - DraftQuestionSchema  — superset of QuestionSchema (adds intentType, phrasingGroupId)
 *   - GenOptionsSchema     — generation options, requestedTotal clamped [50,200]
 *
 * DraftQuestion compatibility contract:
 *   The {text, language, funnel_stage, density_tier} subset is intentionally
 *   the same shape as QuestionSchema from template.schema.ts.  On promotion to
 *   the question table, intentType and phrasingGroupId are stripped; provenance
 *   lives only in industry_template.questions JSONB.
 *
 * DESIGN-phase1.md §"Question Model & Generation", §"Multilingual Pipeline".
 */

import { z } from 'zod';
import { DensityTierSchema } from '../config/template.schema.js';

// ---------------------------------------------------------------------------
// IntentType — generation-time concept; folded into density_tier on promote
// ---------------------------------------------------------------------------

/**
 * Intent taxonomy for question generation.
 * Maps to the six intent axes in DESIGN-phase1.md §IntentMatrix.
 */
export const IntentTypeSchema = z.enum([
  'brand',
  'category',
  'comparison',
  'alternative',
  'useCase',
  'attribute',
]);
export type IntentType = z.infer<typeof IntentTypeSchema>;

// ---------------------------------------------------------------------------
// FunnelStage
// ---------------------------------------------------------------------------

/**
 * Funnel stage values that match the existing QuestionSchema.funnel_stage
 * contract (free-text column, values controlled by this enum at gen-time).
 */
export const FunnelStageSchema = z.enum([
  'awareness',
  'consideration',
  'decision',
]);
export type FunnelStage = z.infer<typeof FunnelStageSchema>;

// ---------------------------------------------------------------------------
// BrandBrief — output of the one URL-diagnosis Gemini call
// ---------------------------------------------------------------------------

/**
 * Detected language weight entry.
 * Derived from hreflang attributes, HTML lang attribute, and content analysis.
 * Weight is a proportion (0..1] with the highest-weight language at 1.0,
 * or a relative positive number normalised by the caller.
 */
export const DetectedLanguageSchema = z.object({
  /** BCP-47 language code, e.g. "en", "ja", "ko", "zh-TW". */
  code: z.string().min(1),
  /**
   * Relative weight in (0, 1].  Derived from hreflang count, content signals.
   * The language with the most evidence gets weight 1.0; others are relative.
   */
  weight: z.number().positive(),
  /**
   * Free-text rationale from the LLM: which signal drove this weight.
   * e.g. "hreflang[ja] present with 8 Japanese pages".
   */
  rationale: z.string().min(1),
});
export type DetectedLanguage = z.infer<typeof DetectedLanguageSchema>;

/**
 * A competitor entry inferred from the brand's URL / industry context.
 */
export const SeedCompetitorSchema = z.object({
  /** Canonical competitor name. */
  name: z.string().min(1),
  /**
   * Aliases including transliterations for non-Latin scripts.
   * E.g. ["Replika", "レプリカ"] for a Japanese market competitor.
   */
  aliases: z.array(z.string().min(1)).default([]),
});
export type SeedCompetitor = z.infer<typeof SeedCompetitorSchema>;

/**
 * BrandBrief — the structured output of the 30-second URL diagnosis.
 *
 * Produced by diagnose.ts via ONE adapter.generateStructured() call.
 * Flows into IntentMatrix, multilingual prompt seeding, and competitor priming.
 *
 * Provenance: infer-only-from-evidence; LLM marks low confidence rather than
 * hallucinate metrics/superlatives (§7#2).
 */
export const BrandBriefSchema = z.object({
  /** Canonical brand name as inferred from the page. */
  brandName: z.string().min(1),

  /**
   * Alternative brand name forms including transliterations.
   * E.g. ["EMORA", "エモーラ", "에모라"] for a multilingual SaaS brand.
   */
  brandAliases: z.array(z.string().min(1)).default([]),

  /**
   * Human-readable product/service category, e.g. "AI companion app".
   * Used verbatim in generation prompts as the category descriptor.
   */
  category: z.string().min(1),

  /**
   * Normalised industry slug for template matching.
   * Lowercase, hyphenated, e.g. "ai-companion", "kbeauty", "b2b-saas".
   * Controlled vocabulary; emitted by the LLM, reviewed by a human.
   */
  industryKey: z.string().min(1).regex(/^[a-z0-9-]+$/, 'industryKey must be lowercase-hyphenated'),

  /**
   * Brand positioning / competitive wedge statement.
   * Short (1-2 sentences), inferred only, no invented claims.
   * E.g. "EMORA differentiates via long-term emotional memory and multilingual support."
   */
  positioning: z.string().optional(),

  /**
   * Ideal customer profile personas and primary use cases.
   * Drives the useCase intent cells in the IntentMatrix.
   */
  icp: z.array(z.string().min(1)).default([]),

  /**
   * Key product attributes inferred from the page.
   * E.g. ["voice chat", "emotion tracking", "offline mode"].
   */
  productAttributes: z.array(z.string().min(1)).default([]),

  /**
   * Competitor names (and aliases) inferred from LLM knowledge + page signals.
   * Seeded into the industry_template.competitors JSONB for the reviewer.
   * NOTE: competitors are NEVER scraped; inferred from LLM knowledge only (§12).
   */
  seedCompetitors: z.array(SeedCompetitorSchema).default([]),

  /**
   * Languages detected from the page (hreflang, HTML lang, content).
   * Weight-proportional; the highest-weight language gets weight = 1.0.
   * Drives IntentMatrix language allocation (§6).
   */
  detectedLanguages: z.array(DetectedLanguageSchema).min(1),

  /**
   * Overall confidence in the brief's accuracy (0..1).
   * LLM sets this low when evidence is sparse (SPA shell, minimal content).
   */
  confidence: z.number().min(0).max(1),
});
export type BrandBrief = z.infer<typeof BrandBriefSchema>;

// ---------------------------------------------------------------------------
// IntentCell — one coverage cell in the IntentMatrix
// ---------------------------------------------------------------------------

/**
 * One cell in the IntentMatrix: the plan atom for a single
 * (language × funnelStage × intentType) combination.
 *
 * targetCount is the number of questions to generate for this cell
 * (after over-generation at 1.3x and dedup/guard passes).
 * densityTier is set deterministically by densityMap.ts.
 */
export const IntentCellSchema = z.object({
  /** BCP-47 language code. */
  language: z.string().min(1),
  /** Funnel stage for this cell. */
  funnelStage: FunnelStageSchema,
  /** Intent type for this cell. */
  intentType: IntentTypeSchema,
  /** Target question count for this cell (post-dedup/guard). */
  targetCount: z.number().int().positive(),
  /**
   * Density tier assigned by densityMap.ts.
   * Set AFTER the matrix is built; may be mutated by densityMap before use.
   */
  densityTier: DensityTierSchema,
});
export type IntentCell = z.infer<typeof IntentCellSchema>;

// ---------------------------------------------------------------------------
// DraftQuestion — superset of QuestionSchema
// ---------------------------------------------------------------------------

/**
 * DraftQuestion — a generated question with full provenance metadata.
 *
 * The canonical 4-field subset {text, language, funnel_stage, density_tier}
 * is intentionally identical to QuestionSchema from template.schema.ts.
 * The extra intentType and phrasingGroupId fields are provenance-only and
 * live in industry_template.questions JSONB; they are stripped on promotion
 * to the question table (accepted per DESIGN-phase1.md §Key Decisions).
 *
 * Assignability contract:
 *   A DraftQuestion value's {text, language, funnel_stage, density_tier}
 *   subset is always a valid QuestionSchema parse result.
 */
export const DraftQuestionSchema = z.object({
  // ---- Canonical QuestionSchema subset (§5.5 compatible) ----

  /** The question text in the specified native language. */
  text: z.string().min(1, 'question.text is required'),

  /** BCP-47 language code, e.g. "en", "ja". */
  language: z.string().min(1, 'question.language is required'),

  /**
   * Funnel stage: awareness | consideration | decision.
   * Stored as a nullable string in the question table (matches QuestionSchema).
   */
  funnel_stage: z.string().nullable().optional(),

  /**
   * Density tier — drives sampling cadence.
   * Assigned by densityMap.ts; HARD cap: core <=25% of total.
   */
  density_tier: DensityTierSchema,

  // ---- Provenance-only (stripped on promote) ----

  /**
   * Generation-time intent type.
   * Folded into density_tier on promotion; NOT stored in the question table.
   */
  intentType: IntentTypeSchema,

  /**
   * Phrasing group identifier (UUID or hash).
   * Groups surface variants of the same underlying intent together.
   * Sibling variants share a phrasingGroupId; the lead variant may differ
   * in density tier from its siblings (siblings default to secondary).
   */
  phrasingGroupId: z.string().min(1),
});
export type DraftQuestion = z.infer<typeof DraftQuestionSchema>;

// ---------------------------------------------------------------------------
// GenOptions — generation run configuration
// ---------------------------------------------------------------------------

/**
 * Generation options passed to the full pipeline.
 *
 * requestedTotal is the total target question count across all languages,
 * funnel stages, and intent types.  It is clamped to [50, 200] per spec §2.
 */
export const GenOptionsSchema = z.object({
  /**
   * Total target question count.
   * Default: 120.  Clamped to [50, 200] regardless of caller input.
   */
  requestedTotal: z
    .number()
    .int()
    .default(120)
    .transform((v) => Math.max(50, Math.min(200, v))),

  /**
   * Optional model ID override for generation calls.
   * Defaults to gemini-2.5-flash when absent.
   */
  modelId: z.string().optional(),

  /**
   * Optional list of low-resource language codes that require native review.
   * Defaults to ['tl', 'vi', 'th'] per DESIGN-phase1.md §Multilingual Pipeline.
   */
  lowResourceLanguages: z
    .array(z.string().min(1))
    .default(['tl', 'vi', 'th']),
});
export type GenOptions = z.infer<typeof GenOptionsSchema>;

// ---------------------------------------------------------------------------
// Utility: clamp helper (exported for use in intentMatrix.ts, etc.)
// ---------------------------------------------------------------------------

/**
 * Clamp a raw requestedTotal into the [50, 200] spec range.
 * Identical to the transform in GenOptionsSchema — exported for callers that
 * have already parsed GenOptions and need the clamped value directly.
 */
export function clampTotal(n: number): number {
  return Math.max(50, Math.min(200, n));
}
