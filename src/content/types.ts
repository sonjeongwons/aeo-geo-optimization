/**
 * src/content/types.ts
 *
 * T03 — Content domain types: zod-first schemas for the Phase 2 content
 * variant generator, §7 gate context/result types, and JSON-LD schema.
 *
 * All schemas use zod so they can be used as Gemini responseSchema sources
 * (via zodToGeminiSchema) and as runtime parse validators.
 *
 * Key structural invariants encoded here:
 *
 * 1. AnswerBlock.numeric_claim_ids must reference ClaimRecord.claim_id values
 *    present in the asset's claims[].  A bare numeric token with no
 *    ClaimRecord is UNREPRESENTABLE (§7#2 encoded in schema shape).
 *
 * 2. ContentGateResult.action is 'pass'|'block'|'needs_human' — NOT the
 *    measurement-gate GateResult union ('pass'|'downgrade').  These are
 *    parallel types in a parallel fold.
 *
 * 3. JsonLdSchema validates the deferred-url token ({deferred:true,
 *    role:'owned_hub'}) and rejects a literal customer-domain string — the
 *    owned hub url is resolved by Phase 3 IaC; Phase 2 never writes a
 *    customer property (§0).
 *
 * DESIGN-phase2.md §"Content Model", §"§7 Guardrail Gates", §"JSON-LD".
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Channel class (§8 deploy-channel family)
// ---------------------------------------------------------------------------

/**
 * Legal channel classes for offsite content.
 * 'community' and 'review' are INTENTIONALLY OMITTED — §7#3 structural
 * exclusion; community/review is manual-only, never auto-generated.
 */
export const ChannelClassSchema = z.enum([
  "owned_net",
  "pr_wire",
  "directory",
  "web2",
  "social",
  "entity",
]);
export type ChannelClass = z.infer<typeof ChannelClassSchema>;

// ---------------------------------------------------------------------------
// Content type + format
// ---------------------------------------------------------------------------

export const ContentTypeSchema = z.enum([
  "definition",
  "answer_block",
  "faq",
  "comparison",
  "case_study",
  "jsonld",
]);
export type ContentType = z.infer<typeof ContentTypeSchema>;

export const ContentFormatSchema = z.enum([
  "definition_sentence",
  "answer_block",
  "faq_table",
  "comparison_table",
  "case_study",
  "jsonld_org",
  "jsonld_faqpage",
  "jsonld_article",
]);
export type ContentFormat = z.infer<typeof ContentFormatSchema>;

// ---------------------------------------------------------------------------
// ClaimRecord — the §7#2/#7 atom
// ---------------------------------------------------------------------------

/**
 * Claim verification state.
 * - 'unverified': freshly extracted; no decision yet.
 * - 'verified': matched to a claim_source row with passing bound check.
 * - 'needs_human': human review required (unsigned source, superlative, etc.).
 * - 'rejected': numeric bound check failed (exceeds stated range).
 */
export const ClaimVerificationSchema = z.enum([
  "unverified",
  "verified",
  "needs_human",
  "rejected",
]);
export type ClaimVerification = z.infer<typeof ClaimVerificationSchema>;

/** Kind of customer claim extracted from content. */
export const ClaimKindSchema = z.enum([
  "numeric",
  "capability",
  "superlative",
  "comparative",
]);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;

/** Numeric bound semantics for a sourced numeric claim. */
export const NumericBoundSchema = z.enum(["exact", "upTo", "atLeast"]);
export type NumericBound = z.infer<typeof NumericBoundSchema>;

/**
 * Parsed numeric payload of a numeric claim.
 * Stored on both ClaimRecord and claim_source for typed bound comparison.
 */
export const NumericPayloadSchema = z.object({
  /** Parsed numeric value, e.g. 30 for "30%". */
  value: z.number(),
  /** Unit string, e.g. "%", "x", "ms", "users". */
  unit: z.string().min(1),
  /** Bound semantics: 'exact' | 'upTo' | 'atLeast'. */
  bound: NumericBoundSchema,
});
export type NumericPayload = z.infer<typeof NumericPayloadSchema>;

/**
 * ClaimRecord — one customer factual claim extracted from an asset body.
 *
 * claim_id is a stable UUID assigned at extraction time.
 * resolved_source_id is set by claimVerify.ts when the claim is matched to a
 * claim_source row — it stores the SPECIFIC row id (structural binding, not
 * fuzzy substring matching).
 * verification is set by claimVerify.ts; Gemini extraction NEVER sets it.
 */
export const ClaimRecordSchema = z.object({
  /** Stable UUID assigned at extraction. */
  claim_id: z.string().uuid(),
  /** Verbatim claim text as it appears in the asset. */
  claim_text: z.string().min(1),
  /** Claim category. */
  claim_kind: ClaimKindSchema,
  /** Present only for numeric claims; parsed from the claim_text. */
  numeric: NumericPayloadSchema.optional(),
  /**
   * Character-offset span [start, end) within the asset body text.
   * Used by the backstop scan to correlate regex matches to claims.
   */
  span: z.object({
    start: z.number().int().min(0),
    end: z.number().int().positive(),
  }),
  /**
   * FK-by-convention to claim_source.id — set by claimVerify.ts on resolution.
   * NULL = not yet resolved against any claim_source row.
   */
  resolved_source_id: z.string().uuid().nullable(),
  /**
   * Verification state — set by claimVerify.ts ONLY.
   * Gemini extraction always leaves this as 'unverified'.
   */
  verification: ClaimVerificationSchema,
});
export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

// ---------------------------------------------------------------------------
// ClaimSourceRow — the external claim_source registry row shape
// ---------------------------------------------------------------------------

/**
 * Source kind for a claim in the claim_source registry.
 */
export const SourceKindSchema = z.enum([
  "customer_attested",
  "public_url",
  "third_party_doc",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/**
 * ClaimSourceRow — shape of a claim_source table row returned from the DB.
 * Mirrors the migration 0009 DDL.  Populated by seedClaimSourcesFromBrief
 * and human sign-off via reviewClaims.ts.
 */
export const ClaimSourceRowSchema = z.object({
  id: z.string().uuid(),
  customer_id: z.string().uuid(),
  claim_text: z.string().min(1),
  claim_kind: ClaimKindSchema,
  /** Present for numeric claims; null for capability/superlative/comparative. */
  numeric_value: z.string().nullable(),   // PgNumeric comes back as string
  numeric_unit: z.string().nullable(),
  numeric_bound: NumericBoundSchema.nullable(),
  source_kind: SourceKindSchema,
  /** URL or document reference; null for customer_attested rows. */
  source_ref: z.string().nullable(),
  /** Set by human sign-off; null until signed. */
  verified_by: z.string().nullable(),
  verified_at: z.date().nullable(),
  created_at: z.date(),
});
export type ClaimSourceRow = z.infer<typeof ClaimSourceRowSchema>;

// ---------------------------------------------------------------------------
// ContentBody — discriminated union on content_type
// ---------------------------------------------------------------------------

/**
 * DefinitionSentence — a short definitional phrase targeting a topic hub.
 * Same meaning generated in multiple surface phrasings across channels.
 */
export const DefinitionSentenceBodySchema = z.object({
  content_type: z.literal("definition"),
  /** The definition text in the asset's native language. */
  text: z.string().min(1),
  /**
   * Semantic key that links siblings across channels/phrasings.
   * The phrasingVariationGate checks across all same-language assets so
   * boilerplate copy-paste at the phrasing level is caught regardless of
   * whether the meaning_key differs.
   */
  meaning_key: z.string().min(1),
});
export type DefinitionSentenceBody = z.infer<typeof DefinitionSentenceBodySchema>;

/**
 * AnswerBlock — 134-167 word self-contained answer with verifiable claims.
 *
 * Structural §7#2 invariant: numeric_claim_ids[] is a NON-EMPTY list when any
 * numeric token appears in text. Every entry MUST reference a claim_id in the
 * asset's claims[].  A bare numeric token with no corresponding ClaimRecord is
 * UNREPRESENTABLE — the gate enforces this at runtime, and the schema shape
 * communicates the intent.
 *
 * length_units is the per-script length count (word count for Latin,
 * character count for CJK/Thai) computed by wordCount.ts — NEVER the LLM's
 * self-reported count.
 */
export const AnswerBlockBodySchema = z.object({
  content_type: z.literal("answer_block"),
  /** The answer text in the asset's native language (134-167 word band enforced by wordCount.ts). */
  text: z.string().min(1),
  /**
   * Per-script length unit count: word tokens for Latin/Cyrillic scripts;
   * character count for ja/ko/zh/th. Computed by wordCount.ts, stored for
   * audit and re-check without re-parsing.
   */
  length_units: z.number().int().positive(),
  /**
   * claim_id values referencing ClaimRecord entries in asset.claims[].
   * MUST be present (non-empty) whenever a numeric token appears in text.
   * This makes a bare numeric with no claim UNREPRESENTABLE.
   */
  numeric_claim_ids: z.array(z.string().uuid()),
  /**
   * claim_source row ids that this answer block draws on.
   * Informational; the structural binding is through resolved_source_id on each
   * ClaimRecord, not this list.
   */
  source_ids: z.array(z.string().uuid()),
});
export type AnswerBlockBody = z.infer<typeof AnswerBlockBodySchema>;

/**
 * One FAQ row: question, answer, and the claim_ids referenced by the answer.
 */
export const FaqRowSchema = z.object({
  q: z.string().min(1),
  a: z.string().min(1),
  /** claim_ids of ClaimRecord entries referenced by this answer. */
  answer_claim_ids: z.array(z.string().uuid()),
});
export type FaqRow = z.infer<typeof FaqRowSchema>;

/**
 * FAQ table body: 3-8 Q/A rows, AI-extractable structure.
 */
export const FaqBodySchema = z.object({
  content_type: z.literal("faq"),
  /** 3-8 Q/A pairs (§6 "FAQ / 비교 / 케이스"). */
  rows: z.array(FaqRowSchema).min(3).max(8),
});
export type FaqBody = z.infer<typeof FaqBodySchema>;

/**
 * One cell in a comparison table.
 * claim_id null => no verifiable claim for this cell; gate blocks numeric values
 * in cells without a claim_id.
 */
export const ComparisonCellSchema = z.object({
  value: z.string(),
  /** FK to a ClaimRecord.claim_id when the cell contains a verifiable value. */
  claim_id: z.string().uuid().nullable(),
});
export type ComparisonCell = z.infer<typeof ComparisonCellSchema>;

/**
 * One row in a comparison table.
 */
export const ComparisonRowSchema = z.object({
  /** Entity name (our brand or a competitor). Competitors from template.competitors. */
  entity: z.string().min(1),
  cells: z.array(ComparisonCellSchema),
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;

/**
 * Comparison table body: column headers + entity rows.
 * Competitors come from template.competitors, NEVER scraped (§12).
 */
export const ComparisonBodySchema = z.object({
  content_type: z.literal("comparison"),
  /** Column header labels, e.g. ["Feature", "EMORA", "Character.AI"]. */
  columns: z.array(z.string().min(1)).min(2),
  rows: z.array(ComparisonRowSchema).min(1),
});
export type ComparisonBody = z.infer<typeof ComparisonBodySchema>;

/**
 * One metric in a case study: before/after with a claim_id.
 */
export const CaseStudyMetricSchema = z.object({
  label: z.string().min(1),
  before: z.string(),
  after: z.string(),
  /** FK to ClaimRecord.claim_id for the quantified improvement. */
  claim_id: z.string().uuid().nullable(),
});
export type CaseStudyMetric = z.infer<typeof CaseStudyMetricSchema>;

/**
 * Case study body: situation/action/result narrative + quantified metrics.
 */
export const CaseStudyBodySchema = z.object({
  content_type: z.literal("case_study"),
  situation: z.string().min(1),
  action: z.string().min(1),
  result: z.string().min(1),
  metrics: z.array(CaseStudyMetricSchema),
});
export type CaseStudyBody = z.infer<typeof CaseStudyBodySchema>;

// ---------------------------------------------------------------------------
// JSON-LD schemas — deferred-url token + per-@type validated shapes
// ---------------------------------------------------------------------------

/**
 * Deferred URL token — emitted by Phase 2 when the owned hub URL does not
 * exist yet (provisioned by Phase 3 IaC).  JsonLdSchema validates this token
 * shape explicitly so Phase 2 cannot claim a fully deploy-ready URL.
 *
 * The §0 guarantee (url is NEVER the customer domain) is preserved because
 * the customer domain is structurally never written — Phase 3 stamps the real
 * hub url at deploy.
 */
export const DeferredUrlSchema = z.object({
  deferred: z.literal(true),
  /** Role tag so Phase 3 knows which slot to fill. */
  role: z.enum(["owned_hub", "social_profile", "entity_page"]),
});
export type DeferredUrl = z.infer<typeof DeferredUrlSchema>;

/**
 * A url field in JSON-LD: either a deferred token or a verified entity URL
 * from claim_source.  A literal customer-domain string is REJECTED.
 *
 * The customer domain is the url the customer OWNS — it is structurally
 * excluded from Phase 2 output (§0).
 */
export const JsonLdUrlSchema = z.union([
  DeferredUrlSchema,
  // Verified entity/profile URL from claim_source (e.g. Wikidata, Crunchbase).
  // Must NOT be the customer domain — enforced at runtime by jsonLdShape gate.
  z.string().url(),
]);
export type JsonLdUrl = z.infer<typeof JsonLdUrlSchema>;

/**
 * Organization JSON-LD body (schema.org/Organization).
 * Built deterministically by jsonld.ts; validated here.
 */
export const OrganizationJsonLdSchema = z.object({
  "@context": z.literal("https://schema.org"),
  "@type": z.literal("Organization"),
  name: z.string().min(1),
  /** Alternative brand name forms including transliterations. */
  alternateName: z.array(z.string().min(1)).optional(),
  /** Deferred owned-hub token (NEVER the customer domain). */
  url: DeferredUrlSchema,
  /** Only verified entity URLs from claim_source; never invented. */
  sameAs: z.array(z.string().url()).optional(),
  description: z.string().optional(),
  knowsAbout: z.array(z.string().min(1)).optional(),
});
export type OrganizationJsonLd = z.infer<typeof OrganizationJsonLdSchema>;

/**
 * FAQPage JSON-LD body (schema.org/FAQPage).
 * mainEntity is derived 1:1 from an already-gated faq asset.
 */
export const FaqPageJsonLdSchema = z.object({
  "@context": z.literal("https://schema.org"),
  "@type": z.literal("FAQPage"),
  mainEntity: z.array(
    z.object({
      "@type": z.literal("Question"),
      name: z.string().min(1),
      acceptedAnswer: z.object({
        "@type": z.literal("Answer"),
        text: z.string().min(1),
      }),
    })
  ).min(1),
});
export type FaqPageJsonLd = z.infer<typeof FaqPageJsonLdSchema>;

/**
 * Article JSON-LD body (schema.org/Article).
 * datePublished is null when the owned hub is not yet provisioned.
 * author/publisher are the owned-net Organization (deferred url).
 */
export const ArticleJsonLdSchema = z.object({
  "@context": z.literal("https://schema.org"),
  "@type": z.literal("Article"),
  headline: z.string().min(1),
  articleBody: z.string().min(1),
  /** BCP-47 language code matching the source asset's language. */
  inLanguage: z.string().min(1),
  /** null until Phase 3 IaC stamps the publish date. */
  datePublished: z.null(),
  author: z.object({
    "@type": z.literal("Organization"),
    name: z.string().min(1),
    url: DeferredUrlSchema,
  }).optional(),
  publisher: z.object({
    "@type": z.literal("Organization"),
    name: z.string().min(1),
    url: DeferredUrlSchema,
  }).optional(),
});
export type ArticleJsonLd = z.infer<typeof ArticleJsonLdSchema>;

/**
 * JsonLdSchema — discriminated union on @type.
 * Accepts the deferred-url token shape and rejects a customer-domain url.
 *
 * Acceptance criteria:
 *   - {url:{deferred:true,role:'owned_hub'},datePublished:null} → valid for Article
 *   - A literal customer-domain url string in url field → rejected by DeferredUrlSchema
 *     (must be either a deferred token OR a validated entity URL, not the customer domain)
 */
export const JsonLdSchema = z.discriminatedUnion("@type", [
  OrganizationJsonLdSchema,
  FaqPageJsonLdSchema,
  ArticleJsonLdSchema,
]);
export type JsonLd = z.infer<typeof JsonLdSchema>;

// ---------------------------------------------------------------------------
// JsonLd content_asset body wrapper
// ---------------------------------------------------------------------------

/**
 * JSON-LD body as stored in content_asset.body for content_type='jsonld'.
 */
export const JsonLdBodySchema = z.object({
  content_type: z.literal("jsonld"),
  /** schema_type mirrors the @type discriminant for fast filtering. */
  schema_type: z.enum(["Organization", "FAQPage", "Article"]),
  /** The JSON-LD object, validated by JsonLdSchema. */
  json: JsonLdSchema,
});
export type JsonLdBody = z.infer<typeof JsonLdBodySchema>;

// ---------------------------------------------------------------------------
// ContentBody — discriminated union on content_type
// ---------------------------------------------------------------------------

/**
 * ContentBody discriminated union.
 * The `content_type` literal is the discriminant key; Zod's discriminatedUnion
 * uses it to select the correct parser.
 */
export const ContentBodySchema = z.discriminatedUnion("content_type", [
  DefinitionSentenceBodySchema,
  AnswerBlockBodySchema,
  FaqBodySchema,
  ComparisonBodySchema,
  CaseStudyBodySchema,
  JsonLdBodySchema,
]);
export type ContentBody = z.infer<typeof ContentBodySchema>;

// ---------------------------------------------------------------------------
// FORMAT_BODY_SCHEMA_MAP — per-format concrete body schema accessor
// ---------------------------------------------------------------------------

/**
 * Maps each ContentFormat to its CONCRETE zod body schema.
 *
 * Used for storage validation (ContentBodySchema.safeParse) and gate checks.
 * NOT used as Gemini responseSchema — use LEAN_GEN_SCHEMA_MAP for that.
 *
 * The three jsonld_* formats share JsonLdBodySchema because they are all
 * discriminated by schema_type inside the json field.
 */
export const FORMAT_BODY_SCHEMA_MAP: Record<ContentFormat, z.ZodTypeAny> = {
  definition_sentence: DefinitionSentenceBodySchema,
  answer_block: AnswerBlockBodySchema,
  faq_table: FaqBodySchema,
  comparison_table: ComparisonBodySchema,
  case_study: CaseStudyBodySchema,
  jsonld_org: JsonLdBodySchema,
  jsonld_faqpage: JsonLdBodySchema,
  jsonld_article: JsonLdBodySchema,
};

// ---------------------------------------------------------------------------
// LEAN generation schemas — ONLY the fields the LLM should author
// ---------------------------------------------------------------------------

/**
 * Lean schema for definition_sentence generation.
 * The LLM authors only `text`; `meaning_key` is derived code-side.
 */
export const LeanDefinitionSchema = z.object({
  content_type: z.literal("definition"),
  /** The definition text in the asset's native language. */
  text: z.string().min(1),
});
export type LeanDefinition = z.infer<typeof LeanDefinitionSchema>;

/**
 * Lean schema for answer_block generation.
 * The LLM authors only the prose `text`; `length_units`, `numeric_claim_ids`,
 * and `source_ids` are derived/initialized code-side after generation.
 */
export const LeanAnswerBlockSchema = z.object({
  content_type: z.literal("answer_block"),
  /**
   * The answer prose in the asset's native language (134-167 word band
   * enforced by wordCount.ts after generation).  The LLM should NOT emit
   * claim IDs, length counts, or source arrays — those are set code-side.
   */
  text: z.string().min(1),
});
export type LeanAnswerBlock = z.infer<typeof LeanAnswerBlockSchema>;

/**
 * Lean FAQ row: only the author fields q and a.
 * `answer_claim_ids` is set to [] code-side (populated by claimExtract).
 */
export const LeanFaqRowSchema = z.object({
  q: z.string().min(1),
  a: z.string().min(1),
});
export type LeanFaqRow = z.infer<typeof LeanFaqRowSchema>;

/**
 * Lean schema for faq_table generation.
 * The LLM authors only q/a pairs; `answer_claim_ids` is filled code-side.
 */
export const LeanFaqSchema = z.object({
  content_type: z.literal("faq"),
  rows: z.array(LeanFaqRowSchema).min(3).max(8),
});
export type LeanFaq = z.infer<typeof LeanFaqSchema>;

/**
 * Lean comparison cell: only the cell value.
 * `claim_id` is set to null code-side (populated by claimVerify after extraction).
 */
export const LeanComparisonCellSchema = z.object({
  value: z.string(),
});
export type LeanComparisonCell = z.infer<typeof LeanComparisonCellSchema>;

/**
 * Lean comparison row: entity name + cells (value only, no claim_id).
 */
export const LeanComparisonRowSchema = z.object({
  entity: z.string().min(1),
  cells: z.array(LeanComparisonCellSchema),
});
export type LeanComparisonRow = z.infer<typeof LeanComparisonRowSchema>;

/**
 * Lean schema for comparison_table generation.
 * The LLM authors columns + entity/cell values; `claim_id` is set to null code-side.
 */
export const LeanComparisonSchema = z.object({
  content_type: z.literal("comparison"),
  columns: z.array(z.string().min(1)).min(2),
  rows: z.array(LeanComparisonRowSchema).min(1),
});
export type LeanComparison = z.infer<typeof LeanComparisonSchema>;

/**
 * Lean case study metric: author-visible label/before/after only.
 * `claim_id` is set to null code-side (populated by claimVerify after extraction).
 */
export const LeanCaseStudyMetricSchema = z.object({
  label: z.string().min(1),
  before: z.string(),
  after: z.string(),
});
export type LeanCaseStudyMetric = z.infer<typeof LeanCaseStudyMetricSchema>;

/**
 * Lean schema for case_study generation.
 * The LLM authors situation/action/result + metric labels/before/after.
 * `claim_id` per metric is set to null code-side.
 */
export const LeanCaseStudySchema = z.object({
  content_type: z.literal("case_study"),
  situation: z.string().min(1),
  action: z.string().min(1),
  result: z.string().min(1),
  metrics: z.array(LeanCaseStudyMetricSchema),
});
export type LeanCaseStudy = z.infer<typeof LeanCaseStudySchema>;

/**
 * Discriminated union of all lean generation schemas.
 * Used as the Gemini responseSchema for each per-format LLM call.
 * jsonld_* formats are EXCLUDED — they are built deterministically by jsonld.ts.
 */
export const LeanContentBodySchema = z.discriminatedUnion("content_type", [
  LeanDefinitionSchema,
  LeanAnswerBlockSchema,
  LeanFaqSchema,
  LeanComparisonSchema,
  LeanCaseStudySchema,
]);
export type LeanContentBody = z.infer<typeof LeanContentBodySchema>;

/**
 * LEAN_GEN_SCHEMA_MAP — maps each LLM-generatable ContentFormat to its lean schema.
 *
 * Used by generateContentForLanguage as the Gemini responseSchema for each
 * per-format call.  Only the fields the LLM should author are included.
 * jsonld_* formats are NOT in this map — they must NEVER be sent to the LLM.
 *
 * The lean schemas are deliberately free of:
 *   - UUID fields (numeric_claim_ids, source_ids, answer_claim_ids, claim_id)
 *   - Derived counts (length_units)
 *   - Internal keys (meaning_key)
 *
 * These are filled code-side by buildStorageBody() after generation.
 */
export const LLM_GENERATABLE_FORMATS = [
  "definition_sentence",
  "answer_block",
  "faq_table",
  "comparison_table",
  "case_study",
] as const satisfies ContentFormat[];

export type LlmGeneratableFormat = (typeof LLM_GENERATABLE_FORMATS)[number];

export const LEAN_GEN_SCHEMA_MAP: Record<LlmGeneratableFormat, z.ZodTypeAny> = {
  definition_sentence: LeanDefinitionSchema,
  answer_block: LeanAnswerBlockSchema,
  faq_table: LeanFaqSchema,
  comparison_table: LeanComparisonSchema,
  case_study: LeanCaseStudySchema,
};

// ---------------------------------------------------------------------------
// buildStorageBodyWithLength — construct a full storage ContentBody from lean LLM output
// ---------------------------------------------------------------------------

/**
 * buildStorageBodyWithLength — convert a lean LLM-authored body into the full
 * ContentBody storage shape validated by ContentBodySchema.
 *
 * Fills in all post-generation / derived fields the LLM must NOT author:
 *   - definition_sentence: meaning_key ← phrasingGroupId
 *   - answer_block: length_units ← pre-computed by computeLengthUnits()
 *                  numeric_claim_ids ← [] (populated by claimExtract downstream)
 *                  source_ids ← [] (populated by claimVerify downstream)
 *   - faq: rows[].answer_claim_ids ← [] (populated by claimExtract downstream)
 *   - comparison: rows[].cells[].claim_id ← null (populated by claimVerify downstream)
 *   - case_study: metrics[].claim_id ← null (populated by claimVerify downstream)
 *
 * Returns a ContentBody that passes ContentBodySchema.safeParse().
 *
 * The `lengthUnits` parameter is pre-computed by the caller (generateContentForLanguage)
 * using computeLengthUnits(text, language) from wordCount.ts, keeping this module
 * free of a wordCount.ts import.
 *
 * @param lean        - Lean LLM output (validated by LeanContentBodySchema).
 * @param phrasingGroupId - Used as meaning_key for definition_sentence.
 * @param lengthUnits - Pre-computed per-script length units (pass 0 for non-answer_block).
 */
export function buildStorageBodyWithLength(
  lean: LeanContentBody,
  phrasingGroupId: string,
  lengthUnits: number
): ContentBody {
  switch (lean.content_type) {
    case "definition": {
      const body: DefinitionSentenceBody = {
        content_type: "definition",
        text: lean.text,
        // meaning_key is the phrasingGroupId — stable semantic key grouping
        // variants of the same meaning across channels.
        meaning_key: phrasingGroupId,
      };
      return body;
    }

    case "answer_block": {
      const body: AnswerBlockBody = {
        content_type: "answer_block",
        text: lean.text,
        // length_units is the per-script count computed by wordCount.ts.
        // The caller passes this so types.ts does not import wordCount.ts.
        length_units: lengthUnits,
        // Empty at generation time; populated by claimExtract.ts downstream.
        numeric_claim_ids: [],
        // Empty at generation time; populated by claimVerify.ts downstream.
        source_ids: [],
      };
      return body;
    }

    case "faq": {
      const body: FaqBody = {
        content_type: "faq",
        rows: lean.rows.map((r) => ({
          q: r.q,
          a: r.a,
          // Empty at generation time; populated by claimExtract.ts downstream.
          answer_claim_ids: [],
        })),
      };
      return body;
    }

    case "comparison": {
      const body: ComparisonBody = {
        content_type: "comparison",
        columns: lean.columns,
        rows: lean.rows.map((r) => ({
          entity: r.entity,
          cells: r.cells.map((c) => ({
            value: c.value,
            // null at generation time; populated by claimVerify.ts downstream.
            claim_id: null,
          })),
        })),
      };
      return body;
    }

    case "case_study": {
      const body: CaseStudyBody = {
        content_type: "case_study",
        situation: lean.situation,
        action: lean.action,
        result: lean.result,
        metrics: lean.metrics.map((m) => ({
          label: m.label,
          before: m.before,
          after: m.after,
          // null at generation time; populated by claimVerify.ts downstream.
          claim_id: null,
        })),
      };
      return body;
    }

    default: {
      // TypeScript exhaustiveness check
      const _never: never = lean;
      throw new Error(`buildStorageBodyWithLength: unhandled content_type in lean body: ${JSON.stringify(_never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// ContentAsset envelope
// ---------------------------------------------------------------------------

/**
 * ContentAsset — the unit gated and queued in Phase 2.
 *
 * This is the in-memory / serialized representation. The DB row shape is in
 * schema.ts (T02). The zod schema here is used for parse-time validation and
 * as the response schema source for Gemini structured output.
 */
export const ContentAssetSchema = z.object({
  /** UUID, generated at insert time. */
  id: z.string().uuid(),
  /** NULL for owned-net generic assets (matches llm_call NULL-customer convention). */
  customer_id: z.string().uuid().nullable(),
  industry: z.string().min(1),
  /** FK to industry_template.id. */
  template_id: z.string().uuid(),
  template_version: z.number().int().positive(),
  /** Groups all assets from one generation run. */
  content_set_id: z.string().uuid(),
  content_type: ContentTypeSchema,
  format: ContentFormatSchema,
  channel_class: ChannelClassSchema,
  /** BCP-47 language code; one of the 18 supported languages. */
  language: z.string().min(1),
  /**
   * Groups variants of the SAME MEANING across channels/languages.
   * NOT the dedup scope — phrasingVariationGate checks ALL same-language assets.
   */
  phrasing_group_id: z.string().min(1),
  /** Parsed and typed body; discriminated by content_type. */
  body: ContentBodySchema,
  /**
   * Extracted customer factual claims.  Every numeric token in body text MUST
   * appear here as a ClaimRecord.  Set by claimExtract.ts; verification is set
   * by claimVerify.ts.
   */
  claims: z.array(ClaimRecordSchema),
  /** Per-script length unit count (words for Latin, chars for CJK/Thai). */
  word_count: z.number().int().min(0).nullable(),
  /** Terminal gate status after runContentGates(). */
  gate_status: z.enum(["pending", "passed", "blocked", "needs_human"]),
  /**
   * All gate verdicts for §12 audit trail.
   * Set by runContentGates() — one entry per gate, non-short-circuit.
   */
  gate_report: z.array(
    z.object({
      gate: z.string().min(1),
      action: z.enum(["pass", "block", "needs_human"]),
      reason: z.string().optional(),
    })
  ).nullable(),
  /**
   * Sponsorship/affiliation disclosure tag (from controlled vocabulary).
   * Required for pr_wire/directory/web2/social channel classes.
   */
  disclosure_tag: z.string().nullable(),
  /**
   * True when the language is low-resource (tl/vi/th default) and the asset
   * should be routed toward needs_human downstream.
   */
  needs_native_review: z.boolean(),
  /** Number of regeneration attempts; bounded per-run to control cost. */
  regen_attempts: z.number().int().min(0),
  /** Provenance snapshot: brief hash, model, generated_at. */
  provenance: z.object({
    brief_hash: z.string().optional(),
    model: z.string().optional(),
    generated_at: z.string().datetime().optional(),
  }).nullable(),
  created_at: z.date(),
});
export type ContentAsset = z.infer<typeof ContentAssetSchema>;

// ---------------------------------------------------------------------------
// ContentCell — one cell in the ContentMatrix (coverage+cost contract)
// ---------------------------------------------------------------------------

/**
 * ContentCell — the plan atom for one (contentType × format × language ×
 * channel_class × phrasing variant) combination.
 *
 * Built by contentMatrix.ts (PURE, BEFORE any token spend).  Mirrors
 * IntentCellSchema from generate/types.ts.
 */
export const ContentCellSchema = z.object({
  contentType: ContentTypeSchema,
  format: ContentFormatSchema,
  /** BCP-47 language code. */
  language: z.string().min(1),
  channel_class: ChannelClassSchema,
  /**
   * Number of phrasing variants to generate for this cell.
   * Over-generated at 1.3x (OVER_GEN_FACTOR) to give the dedup gate room.
   */
  targetVariants: z.number().int().positive(),
  /**
   * Seed string for phrasing variation (e.g. hash of meaning_key + cell coords).
   * Passed to the generation prompt to encourage distinct phrasings.
   */
  phrasingGroupSeed: z.string().min(1),
});
export type ContentCell = z.infer<typeof ContentCellSchema>;

// ---------------------------------------------------------------------------
// ContentGenOptions — generation run configuration
// ---------------------------------------------------------------------------

/**
 * ContentGenOptions — options passed to the multilingual content generation
 * pipeline.  Mirrors GenOptionsSchema from generate/types.ts.
 */
export const ContentGenOptionsSchema = z.object({
  /**
   * Per-run USD ceiling.  Defaults to CONTENT_RUN_CEILING_USD env var (~$2).
   * Content blocks dwarf question generation in token cost, so the $0.50 qgen
   * default is NOT used here.
   */
  runCeilingUsd: z.number().positive().default(2),

  /** Optional model ID override. Defaults to gemini-2.5-flash. */
  modelId: z.string().optional(),

  /**
   * Low-resource language codes that require native review.
   * Assets in these languages get needs_native_review=true and are routed
   * toward needs_human downstream.
   * Default: ['tl', 'vi', 'th'] per DESIGN-phase2.md §Multilingual.
   */
  lowResourceLanguages: z.array(z.string().min(1)).default(["tl", "vi", "th"]),

  /**
   * Maximum total assets per run (from budget.max_content_assets_per_run or
   * a customer-specific override).
   */
  maxAssetsPerRun: z.number().int().positive().optional(),

  /** Maximum number of formats per run (from budget.max_formats). */
  maxFormats: z.number().int().positive().optional(),
});
export type ContentGenOptions = z.infer<typeof ContentGenOptionsSchema>;

// ---------------------------------------------------------------------------
// ContentGateContext — context passed to content gate fold
// ---------------------------------------------------------------------------

/**
 * ContentGateContext — passed to runContentGates() and each ContentGate.apply().
 *
 * DIFFERENT from the measurement GateContext (which carries MutableVerdict +
 * brand_mentioned/brand_rank).  This context is asset-shaped: it carries the
 * ContentAsset, sibling assets for phrasing-variation dedup, brand aliases
 * for name normalization, and the claim_source registry rows for verification.
 *
 * DESIGN-phase2.md §"§7 Guardrail Gates" / "RESOLVED GATE-INTERFACE CONTRADICTION".
 */
export interface ContentGateContext {
  /** The content asset being gated. */
  asset: ContentAsset;
  /**
   * All other same-language assets in the content set, including already-passed
   * assets.  Used by phrasingVariationGate to check cross-meaning boilerplate.
   * Cross-language pairs are EXEMPT (dedup.ts verified rule).
   */
  siblings: ContentAsset[];
  /** Brand name + aliases for mention normalization in gate checks. */
  brandAliases: string[];
  /**
   * All claim_source rows for the customer.
   * Used by claimVerificationGate to resolve ClaimRecord.resolved_source_id.
   */
  claimSources: ClaimSourceRow[];
}

// ---------------------------------------------------------------------------
// ContentGateResult — result returned by a single content gate
// ---------------------------------------------------------------------------

/**
 * ContentGateResult — result returned by ContentGate.apply().
 *
 * DIFFERENT from the measurement GateResult union ('pass'|'downgrade').
 * Content gates can block outright OR route to human review — the measurement
 * pipeline has no 'block' or 'needs_human' action.
 *
 * Used by runContentGates() to collect all verdicts into gate_report (NON-
 * short-circuit) and derive terminal gate_status.
 *
 * Precedence: block > needs_human > pass.
 */
export interface ContentGateResult {
  /** Outcome action. */
  action: "pass" | "block" | "needs_human";
  /** Gate name, for gate_report audit trail (§12). */
  gate: string;
  /** Human-readable reason; present for block/needs_human, optional for pass. */
  reason?: string;
}
