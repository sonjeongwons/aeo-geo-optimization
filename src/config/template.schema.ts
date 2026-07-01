/**
 * src/config/template.schema.ts
 *
 * Zod schema for customer YAML templates (§5.5 / §14).
 * This is the SINGLE source of truth for what a valid customer config looks like.
 *
 * Validates:
 *   - brand name + aliases
 *   - competitor list (name + aliases)
 *   - languages with weights
 *   - questions tagged with text / language / funnel_stage / density_tier
 *   - budget caps (shape caps + USD caps)
 *
 * Used by loadTemplate.ts to parse + validate YAML and upsert DB rows.
 * Also used by genTemplate.ts to validate LLM-drafted templates before saving.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * A single brand alias entry. May be the canonical name or a transliterated /
 * romanised / diacritic form that the evidence locator must also match.
 */
export const AliasSchema = z.string().min(1);

/**
 * Brand definition.
 */
export const BrandSchema = z.object({
  /** Canonical brand name as it appears in product listings. */
  name: z.string().min(1, 'brand.name is required'),
  /**
   * Alternative forms the judge and rule-fallback should recognise.
   * Include transliterations for non-Latin scripts (e.g. emoraエモーラ, 에모라).
   */
  aliases: z.array(AliasSchema).default([]),
});

export type BrandConfig = z.infer<typeof BrandSchema>;

/**
 * One competitor entry.
 */
export const CompetitorSchema = z.object({
  name: z.string().min(1, 'competitor.name is required'),
  aliases: z.array(AliasSchema).default([]),
});

export type CompetitorConfig = z.infer<typeof CompetitorSchema>;

/**
 * Language with priority weight.
 * Weight drives the deterministic lowest-first trim when max_languages is hit.
 */
export const LanguageEntrySchema = z.object({
  /** BCP-47 language tag, e.g. "en", "ja", "ko", "zh-TW". */
  code: z.string().min(1, 'language.code is required'),
  /**
   * Priority weight (higher = more important = included first).
   * Must be a positive number. Defaults to 1.0 if omitted.
   */
  weight: z.number().positive().default(1.0),
});

export type LanguageEntry = z.infer<typeof LanguageEntrySchema>;

/**
 * Density tier values (must match DB CHECK constraint).
 */
export const DensityTierSchema = z.enum(['core', 'secondary', 'longtail']);
export type DensityTier = z.infer<typeof DensityTierSchema>;

/**
 * A single monitoring question.
 */
export const QuestionSchema = z.object({
  /** The question text in the specified language. */
  text: z.string().min(1, 'question.text is required'),
  /**
   * BCP-47 language code. Must be one of the languages listed in the
   * template's `languages` array (validated at cross-schema level).
   */
  language: z.string().min(1, 'question.language is required'),
  /**
   * Funnel stage (optional). E.g. "awareness", "consideration", "decision".
   * Helps decompose Priority Gap by stage in Phase 1+.
   */
  funnel_stage: z.string().nullable().optional(),
  /**
   * Density tier drives the sampling cadence and cost:
   *   core       — every cycle, full N=5 samples
   *   secondary  — biweekly, N=3 samples (rotated slice)
   *   longtail   — monthly, N=3 samples, cheap model only
   */
  density_tier: DensityTierSchema,
});

export type QuestionConfig = z.infer<typeof QuestionSchema>;

/**
 * Budget / shape caps for a customer.
 * All fields have sensible defaults that keep Phase 0 spend tiny.
 */
export const BudgetConfigSchema = z.object({
  /**
   * Max number of models sampled per cycle.
   * Phase 0 = 1 (Gemini only); shape cap.
   */
  max_models: z.number().int().min(1).default(1),
  /**
   * Max samples per (question × model × language) tuple.
   * Core uses up to this; secondary/longtail are lower in density.ts.
   */
  max_samples: z.number().int().min(1).max(10).default(5),
  /**
   * Max language count per cycle. Deterministic lowest-weight trim when
   * more languages are defined than this cap allows.
   */
  max_languages: z.number().int().min(1).default(14),
  /** Rolling 7-day USD spend cap. Fail-closed when exceeded. */
  weekly_usd_cap: z.number().positive().default(50),
  /** Rolling 30-day USD spend cap. Fail-closed when exceeded. */
  monthly_usd_cap: z.number().positive().default(150),
});

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

// ---------------------------------------------------------------------------
// Top-level customer template schema
// ---------------------------------------------------------------------------

/**
 * CustomerTemplate — the complete validated shape of a customer YAML file.
 *
 * Acceptance criteria checks:
 *   - brand is required (ZodError on missing brand)
 *   - languages array must be non-empty
 *   - questions array must be non-empty
 *   - competitors may be empty (a brand with no tracked competitors is valid)
 */
export const CustomerTemplateSchema = z
  .object({
    /**
     * Customer identifier. Lowercase slug, e.g. "emora", "kbeauty".
     * Becomes the `customer.slug` in the DB.
     */
    slug: z
      .string()
      .min(1, 'slug is required')
      .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with dashes'),

    /**
     * The brand being tracked.
     */
    brand: BrandSchema,

    /**
     * Tracked competitors. Used to compute SoV and brand_rank semantics.
     * May be an empty array if no competitors are tracked yet.
     */
    competitors: z.array(CompetitorSchema).default([]),

    /**
     * Languages supported by this customer, with priority weights.
     * Determines which languages are included in each cycle and in what order.
     * Must contain at least one entry.
     */
    languages: z.array(LanguageEntrySchema).min(1, 'at least one language is required'),

    /**
     * Monitoring questions. Must contain at least one question.
     * Each question must be tagged with a density_tier and language.
     */
    questions: z.array(QuestionSchema).min(1, 'at least one question is required'),

    /**
     * Budget / shape caps. Defaults are set to safe Phase-0 values.
     */
    budget: BudgetConfigSchema.default({}),
  })
  .superRefine((data, ctx) => {
    // Assert that every question.language is declared in the languages array.
    // This fails loudly at materialize time rather than silently degrading
    // (TLI-03 fix — language collapse guard).
    const declaredLanguages = new Set(data.languages.map((l) => l.code));
    for (let i = 0; i < data.questions.length; i++) {
      const q = data.questions[i]!;
      if (!declaredLanguages.has(q.language)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['questions', i, 'language'],
          message:
            `question[${i}].language "${q.language}" is not declared in the ` +
            `languages array (declared: ${[...declaredLanguages].join(', ')}).`,
        });
      }
    }
  });

export type CustomerTemplate = z.infer<typeof CustomerTemplateSchema>;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Parse and validate raw YAML-parsed data against CustomerTemplateSchema.
 * Throws a ZodError with detailed messages on failure.
 *
 * @param data - the result of js-yaml's load() call (unknown shape)
 * @returns the validated CustomerTemplate
 */
export function parseCustomerTemplate(data: unknown): CustomerTemplate {
  return CustomerTemplateSchema.parse(data);
}
