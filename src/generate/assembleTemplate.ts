/**
 * src/generate/assembleTemplate.ts
 *
 * T15 — Assemble draft template + persist as industry_template draft.
 *
 * Combines deduped + guarded DraftQuestion[] and seedCompetitors from a
 * BrandBrief into a {questions, competitors} JSONB payload, re-validates
 * every question's canonical 4-field subset against QuestionSchema and every
 * competitor against CompetitorSchema, then persists the row via the EXISTING
 * repo.insertIndustryTemplate(status='draft').
 *
 * Advisory columns (source_url, customer_slug, generated_total) are written
 * in a follow-up UPDATE so that the EXISTING insertIndustryTemplate signature
 * is unchanged (DESIGN §"Phase 0 Integration" additive-only rule).
 *
 * INVARIANTS:
 *   - Output is ALWAYS status='draft'.  Generator never emits reviewed/active.
 *   - Every question's {text, language, funnel_stage, density_tier} subset
 *     passes QuestionSchema.parse() before insert; any failure throws before
 *     the DB write so no invalid row is persisted.
 *   - Competitor records are validated against CompetitorSchema before insert.
 *   - Provenance fields (intentType, phrasingGroupId, source, briefSnapshot,
 *     generatedTotal, needsNativeReview) are present in the JSONB but are NOT
 *     part of the canonical 4-field subset — they are stripped on promotion.
 *
 * NOTE: DB imports (repo.ts, kysely.ts) are LAZY (dynamic) so that tests
 * injecting a stub _repo never trigger the pg/kysely import chain.
 *
 * DESIGN-phase1.md §"Industry-Template Store & Lifecycle",
 * §"Assemble + persist" (pipeline stage G).
 */

import { z } from 'zod';
import { QuestionSchema, CompetitorSchema } from '../config/template.schema.js';
import type { DraftQuestion, BrandBrief, SeedCompetitor } from './types.js';

// ---------------------------------------------------------------------------
// JSONB shape: the full provenance-rich question stored in industry_template
// ---------------------------------------------------------------------------

/**
 * The shape of each entry in the industry_template.questions JSONB array.
 *
 * The canonical 4-field subset {text, language, funnel_stage, density_tier}
 * is identical to QuestionSchema; the provenance fields below are EXTRA and
 * are stripped when promoting to the question table.
 */
export interface TemplateQuestionRecord {
  // ---- Canonical QuestionSchema subset (promoted to question table) --------
  text: string;
  language: string;
  funnel_stage: string | null | undefined;
  density_tier: 'core' | 'secondary' | 'longtail';

  // ---- Provenance-only (lives in JSONB; stripped on promote) ---------------
  /** Generation-time intent type; folded into density_tier on promotion. */
  intentType: string;
  /** Groups surface-phrasing variants of the same underlying intent. */
  phrasingGroupId: string;
  /**
   * How this question was sourced.
   * 'url'      — generated from a URL-diagnosis BrandBrief
   * 'industry' — generated from an industry-only BrandBrief (no URL)
   */
  source: 'url' | 'industry';
  /**
   * Snapshot of the BrandBrief fields used for generation — stored for audit
   * so the reviewer can understand context without re-running diagnosis.
   */
  briefSnapshot: {
    brandName: string;
    category: string;
    industryKey: string;
    positioning?: string;
  };
  /** Total questions generated BEFORE dedup/guardrails (over-generation count). */
  generatedTotal: number;
  /**
   * True when the question is in a low-resource language (tl, vi, th) and
   * should receive extra attention during human review (§6 DESIGN).
   */
  needsNativeReview: boolean;
}

/**
 * The shape of each entry in the industry_template.competitors JSONB array.
 * Mirrors CompetitorSchema exactly (name + aliases).
 */
export interface TemplateCompetitorRecord {
  name: string;
  aliases: string[];
}

// ---------------------------------------------------------------------------
// AssembleRepo — dependency injection port for DB operations
// ---------------------------------------------------------------------------

/**
 * Minimal repo port for dependency injection.
 * Production: implemented via lazy-imported repo.ts + kysely.ts.
 * Tests:      a simple stub that captures calls.
 */
export interface AssembleRepo {
  insertIndustryTemplate(t: {
    industry: string;
    version?: number;
    questions: unknown;
    competitors: unknown;
    status?: 'draft' | 'reviewed' | 'active';
  }): Promise<{ id: string }>;

  updateAdvisoryCols(
    id: string,
    cols: {
      generated_total: number;
      source_url?: string;
      customer_slug?: string;
      /** Full BrandBrief (jsonb) — Track 2 multilingual/claim-seed persistence. */
      brief_snapshot?: unknown;
    },
  ): Promise<void>;

  /**
   * Return max(version)+1 for the given industry (or 1 when no rows exist yet).
   * Used to avoid a unique-constraint collision on uq_industry_template_version
   * when a second template is generated for the same industry (TLI-02 fix).
   */
  nextTemplateVersion(industry: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// AssembleOptions — inputs to the assembler
// ---------------------------------------------------------------------------

/**
 * Options for assembleTemplate().
 */
export interface AssembleOptions {
  /** Deduped, guardrail-filtered DraftQuestion[] from the generation pipeline. */
  questions: DraftQuestion[];

  /**
   * Seed competitors from the BrandBrief (name + aliases).
   * Validated against CompetitorSchema before insert.
   */
  seedCompetitors: SeedCompetitor[];

  /** The BrandBrief used for generation — snapshotted for reviewer context. */
  brief: BrandBrief;

  /**
   * Total questions generated BEFORE dedup/guardrails.
   * Stored as a provenance field (generated_total advisory column + JSONB).
   */
  generatedTotal: number;

  /**
   * Low-resource language codes requiring native review (default: ['tl','vi','th']).
   * Questions in these languages get needsNativeReview=true in JSONB.
   */
  lowResourceLanguages?: string[];

  /**
   * Optional source URL that was diagnosed to produce the BrandBrief.
   * Stored in the source_url advisory column.
   */
  sourceUrl?: string;

  /**
   * Optional customer slug that initiated generation.
   * Stored in the customer_slug advisory column.
   */
  customerSlug?: string;

  /**
   * Source mode: 'url' when a URL was diagnosed, 'industry' otherwise.
   */
  source: 'url' | 'industry';

  /**
   * Optional injectable repo port for testing.
   * If not provided, the production repo functions are used via lazy imports.
   * Injecting a stub here avoids the pg/kysely import chain in unit tests.
   */
  _repo?: AssembleRepo;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result returned by assembleTemplate() on success.
 */
export interface AssembleResult {
  /** The newly inserted industry_template row id (UUID). */
  templateId: string;

  /**
   * The assembled JSONB questions array (as validated + stored).
   * Useful for downstream callers or tests.
   */
  questionsPayload: TemplateQuestionRecord[];

  /**
   * The assembled JSONB competitors array (as validated + stored).
   */
  competitorsPayload: TemplateCompetitorRecord[];

  /**
   * Number of questions in the payload (post-dedup, post-guardrails).
   */
  questionCount: number;
}

// ---------------------------------------------------------------------------
// Validation helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Validate the canonical 4-field subset of a DraftQuestion against
 * QuestionSchema.  Throws a descriptive Error on failure.
 *
 * This is a FULL QuestionSchema.parse() so any future additions to
 * QuestionSchema are automatically caught here.
 *
 * @param q     - The DraftQuestion to validate.
 * @param index - The 0-based index in the input array (for error messages).
 */
export function validateCanonicalSubset(q: DraftQuestion, index: number): void {
  const subset = {
    text: q.text,
    language: q.language,
    funnel_stage: q.funnel_stage,
    density_tier: q.density_tier,
  };

  const result = QuestionSchema.safeParse(subset);
  if (!result.success) {
    throw new Error(
      `Question[${index}] failed canonical QuestionSchema validation: ` +
        result.error.message +
        `\n  text="${q.text}" lang="${q.language}"`,
    );
  }
}

/**
 * Validate a competitor record against CompetitorSchema before insert.
 * Throws a descriptive Error on failure.
 *
 * @param comp  - The SeedCompetitor to validate.
 * @param index - The 0-based index in the input array (for error messages).
 */
export function validateCompetitor(comp: SeedCompetitor, index: number): void {
  const result = CompetitorSchema.safeParse(comp);
  if (!result.success) {
    throw new Error(
      `Competitor[${index}] failed CompetitorSchema validation: ` +
        result.error.message +
        `\n  name="${comp.name}"`,
    );
  }
}

/**
 * Build the BriefSnapshot from a BrandBrief.
 * Exported for tests that want to verify the snapshot shape independently.
 */
export function buildBriefSnapshot(
  brief: BrandBrief,
): TemplateQuestionRecord['briefSnapshot'] {
  return {
    brandName: brief.brandName,
    category: brief.category,
    industryKey: brief.industryKey,
    ...(brief.positioning !== undefined ? { positioning: brief.positioning } : {}),
  };
}

/**
 * Build the questions JSONB payload from deduped DraftQuestion[] and metadata.
 * All questions are validated before this is called; this function is PURE.
 *
 * Exported for testing so callers can inspect the payload shape without DB.
 */
export function buildQuestionsPayload(
  questions: DraftQuestion[],
  brief: BrandBrief,
  generatedTotal: number,
  source: 'url' | 'industry',
  lowResourceLanguages: string[],
): TemplateQuestionRecord[] {
  const lowResSet = new Set(lowResourceLanguages.map((l) => l.toLowerCase()));
  const briefSnapshot = buildBriefSnapshot(brief);

  return questions.map((q) => ({
    // ---- Canonical subset ----
    text: q.text,
    language: q.language,
    funnel_stage: q.funnel_stage,
    density_tier: q.density_tier,

    // ---- Provenance ----
    intentType: q.intentType,
    phrasingGroupId: q.phrasingGroupId,
    source,
    briefSnapshot,
    generatedTotal,
    needsNativeReview: lowResSet.has(q.language.toLowerCase()),
  }));
}

/**
 * Build the competitors JSONB payload from seed competitors.
 * Pure function, exported for testing.
 */
export function buildCompetitorsPayload(
  seedCompetitors: SeedCompetitor[],
): TemplateCompetitorRecord[] {
  return seedCompetitors.map((c) => ({
    name: c.name,
    aliases: c.aliases,
  }));
}

// ---------------------------------------------------------------------------
// Default production repo implementation (lazy imports to avoid pg in tests)
// ---------------------------------------------------------------------------

/**
 * Production repo implementation using the real DB functions.
 * Used when _repo is not injected.
 *
 * DB imports are LAZY (dynamic) so that tests injecting a stub _repo never
 * trigger the pg/kysely import chain (which fails in the Vitest ESM sandbox).
 */
function makeProductionRepo(): AssembleRepo {
  return {
    async insertIndustryTemplate(t) {
      // Lazy import: only resolves when actually called in production
      const { insertIndustryTemplate } = await import('../db/repo.js');
      return insertIndustryTemplate(t);
    },

    async nextTemplateVersion(industry) {
      // Lazy import: only resolves when actually called in production
      const { nextTemplateVersion } = await import('../db/repo.js');
      return nextTemplateVersion(industry);
    },

    async updateAdvisoryCols(id, cols) {
      // Lazy import: only resolves when actually called in production
      const { getDb } = await import('../db/kysely.js');
      const { sql } = await import('kysely');

      const updateValues: Record<string, unknown> = {
        generated_total: cols.generated_total,
      };
      if (cols.source_url !== undefined) {
        updateValues['source_url'] = cols.source_url;
      }
      if (cols.customer_slug !== undefined) {
        updateValues['customer_slug'] = cols.customer_slug;
      }
      if (cols.brief_snapshot !== undefined) {
        // Serialize the full brief explicitly + ::jsonb cast (same pattern as
        // insertIndustryTemplate) so node-postgres does not mis-encode the object.
        updateValues['brief_snapshot'] = sql`${JSON.stringify(cols.brief_snapshot)}::jsonb`;
      }

      await getDb()
        .updateTable('industry_template')
        .set(updateValues as { generated_total: number })
        .where('id', '=', id)
        .execute();
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Assemble a draft industry_template from deduped/guarded questions and
 * seed competitors, validate the canonical subsets, and persist as a new
 * draft row via the EXISTING repo.insertIndustryTemplate().
 *
 * NEVER emits status='reviewed' or status='active'.
 *
 * @param opts - AssembleOptions with questions, competitors, brief, etc.
 * @returns AssembleResult with the new templateId and assembled payloads.
 * @throws Error if any question's canonical subset fails QuestionSchema
 *         or any competitor fails CompetitorSchema (before any DB write).
 */
export async function assembleTemplate(opts: AssembleOptions): Promise<AssembleResult> {
  const {
    questions,
    seedCompetitors,
    brief,
    generatedTotal,
    lowResourceLanguages = ['tl', 'vi', 'th'],
    sourceUrl,
    customerSlug,
    source,
    _repo,
  } = opts;

  const repo: AssembleRepo = _repo ?? makeProductionRepo();

  // ---- Step 1: Validate canonical subsets (all-or-nothing before DB write) ---
  // Throws immediately on first failure — no partial inserts.

  for (let i = 0; i < questions.length; i++) {
    validateCanonicalSubset(questions[i]!, i);
  }

  for (let i = 0; i < seedCompetitors.length; i++) {
    validateCompetitor(seedCompetitors[i]!, i);
  }

  // ---- Step 2: Build JSONB payloads ----------------------------------------

  const questionsPayload = buildQuestionsPayload(
    questions,
    brief,
    generatedTotal,
    source,
    lowResourceLanguages,
  );

  const competitorsPayload = buildCompetitorsPayload(seedCompetitors);

  // ---- Step 3: Compute next version to avoid uq_industry_template_version ----
  // A second template for the same industry would collide on version=1 (the DB
  // default).  Compute max(existing)+1 explicitly before the insert (TLI-02 fix).

  const version = await repo.nextTemplateVersion(brief.industryKey);

  // ---- Step 4: Persist via EXISTING insertIndustryTemplate -----------------
  // status is always 'draft' — generator never emits reviewed/active.

  const { id: templateId } = await repo.insertIndustryTemplate({
    industry: brief.industryKey,
    version,
    questions: questionsPayload,
    competitors: competitorsPayload,
    status: 'draft',
  });

  // ---- Step 5: Set advisory columns (additive UPDATE) ----------------------
  // source_url, customer_slug, and generated_total are Phase 1 advisory columns
  // added in migration 0007_phase1_templatestore.sql.  We write them in a
  // separate UPDATE so Phase 0's insertIndustryTemplate signature is unchanged.

  const advisoryCols: {
    generated_total: number;
    source_url?: string;
    customer_slug?: string;
    brief_snapshot?: unknown;
  } = {
    generated_total: generatedTotal,
    // Track 2: persist the FULL diagnosed brief so gen-content's briefFromTemplate
    // can rebuild productAttributes (→ claim_source seed) + detectedLanguages
    // (→ multilingual content matrix) instead of falling back to en-only scalars.
    brief_snapshot: brief,
  };
  if (sourceUrl !== undefined) {
    advisoryCols.source_url = sourceUrl;
  }
  if (customerSlug !== undefined) {
    advisoryCols.customer_slug = customerSlug;
  }

  await repo.updateAdvisoryCols(templateId, advisoryCols);

  // ---- Return result -------------------------------------------------------
  return {
    templateId,
    questionsPayload,
    competitorsPayload,
    questionCount: questions.length,
  };
}

// ---------------------------------------------------------------------------
// Re-export types for downstream callers (T16 materialize, T18 gen-template)
// ---------------------------------------------------------------------------

export type { SeedCompetitor };

// ---------------------------------------------------------------------------
// Zod schemas for JSONB records (used by tests + T16 re-validation)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the full TemplateQuestionRecord (JSONB entry).
 * The canonical subset {text, language, funnel_stage, density_tier} is a
 * strict subset of this schema and always validates against QuestionSchema.
 */
export const TemplateQuestionRecordSchema = z.object({
  // Canonical subset
  text: z.string().min(1),
  language: z.string().min(1),
  funnel_stage: z.string().nullable().optional(),
  density_tier: z.enum(['core', 'secondary', 'longtail']),

  // Provenance
  intentType: z.string().min(1),
  phrasingGroupId: z.string().min(1),
  source: z.enum(['url', 'industry']),
  briefSnapshot: z.object({
    brandName: z.string().min(1),
    category: z.string().min(1),
    industryKey: z.string().min(1),
    positioning: z.string().optional(),
  }),
  generatedTotal: z.number().int().nonnegative(),
  needsNativeReview: z.boolean(),
});

/**
 * Zod schema for TemplateCompetitorRecord (JSONB entry).
 */
export const TemplateCompetitorRecordSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()),
});
