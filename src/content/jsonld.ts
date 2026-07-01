/**
 * src/content/jsonld.ts
 *
 * T13 — Pure deterministic JSON-LD builders for owned-net assets.
 *
 * These builders are PURE (no network, no LLM) and produce typed JSON-LD
 * objects validated against the zod schemas in types.ts.  They are called
 * AFTER the prose asset has passed the content gate fold (faqAsset must be
 * gate_status='passed' before faqPageJsonLd() is invoked).
 *
 * §0 guarantee: url is NEVER the customer domain.  The owned-hub url +
 * datePublished emit a typed DEFERRED TOKEN validated by JsonLdSchema.
 * Phase 3 IaC stamps the real hub URL at deploy.
 *
 * §6: JSON-LD is generated only for owned_net channel_class assets.
 *
 * Three builders:
 *   - organizationJsonLd(brief, claimSources?)  → Organization JSON-LD
 *   - faqPageJsonLd(faqAsset)                   → FAQPage JSON-LD
 *   - articleJsonLd(asset)                      → Article JSON-LD
 *
 * Each builder returns a typed BuildResult carrying both the validated body
 * (JsonLdBody) and a full ContentAsset-shaped envelope for the caller to
 * persist as a content_type='jsonld' row linked to the source by
 * phrasing_group_id.
 *
 * DESIGN-phase2.md §"JSON-LD".
 */

import { randomUUID } from "crypto";
import type { BrandBrief } from "../generate/types.js";
import type { ClaimSourceRow } from "./types.js";
import {
  JsonLdBodySchema,
  type JsonLdBody,
  type ContentAsset,
  type FaqBody,
  type AnswerBlockBody,
  type CaseStudyBody,
  type DeferredUrl,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** The deferred owned-hub URL token (§0: never the customer domain). */
const OWNED_HUB_DEFERRED: DeferredUrl = {
  deferred: true,
  role: "owned_hub",
};

// ---------------------------------------------------------------------------
// BuildResult — what each builder returns
// ---------------------------------------------------------------------------

/**
 * Success result from a JSON-LD builder.
 *
 * body: the validated JsonLdBody (stored in content_asset.body).
 * asset: the full ContentAsset envelope ready for repo.insertContentAsset().
 *        channel_class is always 'owned_net' (§6).
 *        gate_status is 'pending' — the jsonLdShapeGate must still run.
 */
export interface JsonLdBuildOk {
  ok: true;
  body: JsonLdBody;
  asset: ContentAsset;
}

/** Failure result (validation error — should never occur in production). */
export interface JsonLdBuildErr {
  ok: false;
  reason: string;
}

export type JsonLdBuildResult = JsonLdBuildOk | JsonLdBuildErr;

// ---------------------------------------------------------------------------
// Helper: build a stub ContentAsset envelope for a JSON-LD body
// ---------------------------------------------------------------------------

function makeJsonLdAsset(params: {
  body: JsonLdBody;
  language: string;
  phrasing_group_id: string;
  industry: string;
  template_id: string;
  template_version: number;
  content_set_id: string;
  customer_id: string | null;
}): ContentAsset {
  return {
    id: randomUUID(),
    customer_id: params.customer_id,
    industry: params.industry,
    template_id: params.template_id,
    template_version: params.template_version,
    content_set_id: params.content_set_id,
    content_type: "jsonld",
    format: params.body.schema_type === "Organization"
      ? "jsonld_org"
      : params.body.schema_type === "FAQPage"
        ? "jsonld_faqpage"
        : "jsonld_article",
    channel_class: "owned_net",       // §6: JSON-LD is owned_net only
    language: params.language,
    phrasing_group_id: params.phrasing_group_id,
    body: params.body,
    claims: [],                        // JSON-LD body carries no extracted claims
    word_count: null,
    gate_status: "pending",           // jsonLdShapeGate runs after
    gate_report: null,
    disclosure_tag: null,             // owned_net does not require disclosure tag
    needs_native_review: false,
    regen_attempts: 0,
    provenance: null,
    created_at: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Helper: filter claim_source rows to verified entity/profile URLs only
// ---------------------------------------------------------------------------

/**
 * Return sameAs URL strings from verified claim_source rows.
 * Only 'public_url' or 'third_party_doc' rows with a non-null source_ref that
 * looks like an HTTPS URL are included.  'customer_attested' rows are excluded
 * (they haven't been independently verified).
 *
 * §JSON-LD: "sameAs (verified entity/profile URLs from claim_source ONLY,
 * never invented)".
 */
function extractSameAsUrls(claimSources: ClaimSourceRow[]): string[] {
  const urls: string[] = [];
  for (const src of claimSources) {
    if (src.source_kind === "customer_attested") continue;
    if (!src.source_ref) continue;
    // Only accept HTTPS entity/profile URLs (not document refs).
    const ref = src.source_ref.trim();
    if (ref.startsWith("https://") || ref.startsWith("http://")) {
      urls.push(ref);
    }
  }
  // Deduplicate
  return [...new Set(urls)];
}

// ---------------------------------------------------------------------------
// organizationJsonLd
// ---------------------------------------------------------------------------

/**
 * Build an Organization JSON-LD body from a BrandBrief.
 *
 * url: always the deferred owned-hub token (§0: never the customer domain).
 * sameAs: verified entity URLs from claim_source rows (public_url/third_party_doc).
 * description: BrandBrief.positioning (claim-level check deferred to gate).
 * knowsAbout: BrandBrief.category + productAttributes.
 *
 * @param brief         - BrandBrief snapshot from the active template.
 * @param claimSources  - Customer's claim_source rows for sameAs extraction.
 * @param context       - Provenance context for the content_asset envelope.
 */
export function organizationJsonLd(
  brief: BrandBrief,
  claimSources: ClaimSourceRow[],
  context: {
    industry: string;
    template_id: string;
    template_version: number;
    content_set_id: string;
    customer_id: string | null;
    phrasing_group_id: string;
    language: string;
  }
): JsonLdBuildResult {
  const sameAsUrls = extractSameAsUrls(claimSources);

  const jsonObj = {
    "@context": "https://schema.org" as const,
    "@type": "Organization" as const,
    name: brief.brandName,
    ...(brief.brandAliases.length > 0 && { alternateName: brief.brandAliases }),
    url: OWNED_HUB_DEFERRED,
    ...(sameAsUrls.length > 0 && { sameAs: sameAsUrls }),
    ...(brief.positioning !== undefined && { description: brief.positioning }),
    knowsAbout: [brief.category, ...brief.productAttributes].filter(
      (s) => s.length > 0
    ),
  };

  const body: unknown = {
    content_type: "jsonld",
    schema_type: "Organization",
    json: jsonObj,
  };

  const parsed = JsonLdBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `organizationJsonLd validation failed: ${parsed.error.message}`,
    };
  }

  const asset = makeJsonLdAsset({
    body: parsed.data,
    language: context.language,
    phrasing_group_id: context.phrasing_group_id,
    industry: context.industry,
    template_id: context.template_id,
    template_version: context.template_version,
    content_set_id: context.content_set_id,
    customer_id: context.customer_id,
  });

  return { ok: true, body: parsed.data, asset };
}

// ---------------------------------------------------------------------------
// faqPageJsonLd
// ---------------------------------------------------------------------------

/**
 * Build a FAQPage JSON-LD body from an already-gated faq ContentAsset.
 *
 * mainEntity is derived 1:1 from the FaqBody.rows of the source asset.
 * inLanguage is inherited from the source asset's language.
 *
 * The source asset MUST be gate_status='passed' (enforced by the caller in
 * assembleContentSet.ts; this builder does not re-check).
 *
 * @param faqAsset  - A content_type='faq' asset whose gate_status='passed'.
 * @param context   - Provenance context for the new jsonld content_asset.
 */
export function faqPageJsonLd(
  faqAsset: ContentAsset,
  context: {
    industry: string;
    template_id: string;
    template_version: number;
    content_set_id: string;
    customer_id: string | null;
    phrasing_group_id: string;
  }
): JsonLdBuildResult {
  if (faqAsset.body.content_type !== "faq") {
    return {
      ok: false,
      reason: `faqPageJsonLd: source asset must be content_type='faq', got '${faqAsset.body.content_type}'`,
    };
  }

  const faqBody = faqAsset.body as FaqBody;

  const mainEntity = faqBody.rows.map((row) => ({
    "@type": "Question" as const,
    name: row.q,
    acceptedAnswer: {
      "@type": "Answer" as const,
      text: row.a,
    },
  }));

  const jsonObj = {
    "@context": "https://schema.org" as const,
    "@type": "FAQPage" as const,
    mainEntity,
  };

  const body: unknown = {
    content_type: "jsonld",
    schema_type: "FAQPage",
    json: jsonObj,
  };

  const parsed = JsonLdBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `faqPageJsonLd validation failed: ${parsed.error.message}`,
    };
  }

  const asset = makeJsonLdAsset({
    body: parsed.data,
    language: faqAsset.language,       // inLanguage matches source asset
    phrasing_group_id: context.phrasing_group_id,
    industry: context.industry,
    template_id: context.template_id,
    template_version: context.template_version,
    content_set_id: context.content_set_id,
    customer_id: context.customer_id,
  });

  return { ok: true, body: parsed.data, asset };
}

// ---------------------------------------------------------------------------
// articleJsonLd
// ---------------------------------------------------------------------------

/**
 * Build an Article JSON-LD body from an already-gated answer_block or
 * case_study ContentAsset.
 *
 * headline:     derived from the source asset's phrasing_group_id (a short
 *               human-readable seed) or a trimmed prefix of the body text.
 * articleBody:  the prose text from the source asset.
 * inLanguage:   matches the source asset's language (§T13 acceptance criterion).
 * datePublished: null (Phase 3 IaC stamps the real date at deploy).
 * author/publisher: the owned-net Organization with DEFERRED url (§0).
 *
 * The source asset MUST be gate_status='passed'.
 *
 * @param sourceAsset - A content_type='answer_block' or 'case_study' asset.
 * @param brief       - BrandBrief for author/publisher name.
 * @param context     - Provenance context for the new jsonld content_asset.
 */
export function articleJsonLd(
  sourceAsset: ContentAsset,
  brief: BrandBrief,
  context: {
    industry: string;
    template_id: string;
    template_version: number;
    content_set_id: string;
    customer_id: string | null;
    phrasing_group_id: string;
  }
): JsonLdBuildResult {
  const { body } = sourceAsset;

  // Extract prose text and headline from the source body.
  let articleBody: string;
  let headline: string;

  if (body.content_type === "answer_block") {
    const ab = body as AnswerBlockBody;
    articleBody = ab.text;
    headline = buildHeadline(ab.text, sourceAsset.phrasing_group_id);
  } else if (body.content_type === "case_study") {
    const cs = body as CaseStudyBody;
    // Concatenate the SAR narrative as the article body.
    articleBody = [cs.situation, cs.action, cs.result].join("\n\n");
    headline = buildHeadline(cs.situation, sourceAsset.phrasing_group_id);
  } else {
    return {
      ok: false,
      reason: `articleJsonLd: source asset must be content_type='answer_block' or 'case_study', got '${body.content_type}'`,
    };
  }

  const orgStub = {
    "@type": "Organization" as const,
    name: brief.brandName,
    url: OWNED_HUB_DEFERRED,
  };

  const jsonObj = {
    "@context": "https://schema.org" as const,
    "@type": "Article" as const,
    headline,
    articleBody,
    inLanguage: sourceAsset.language,
    datePublished: null,
    author: orgStub,
    publisher: orgStub,
  };

  const body2: unknown = {
    content_type: "jsonld",
    schema_type: "Article",
    json: jsonObj,
  };

  const parsed = JsonLdBodySchema.safeParse(body2);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `articleJsonLd validation failed: ${parsed.error.message}`,
    };
  }

  const asset = makeJsonLdAsset({
    body: parsed.data,
    language: sourceAsset.language,   // inLanguage matches source
    phrasing_group_id: context.phrasing_group_id,
    industry: context.industry,
    template_id: context.template_id,
    template_version: context.template_version,
    content_set_id: context.content_set_id,
    customer_id: context.customer_id,
  });

  return { ok: true, body: parsed.data, asset };
}

// ---------------------------------------------------------------------------
// Internal helper: derive a short headline from prose text
// ---------------------------------------------------------------------------

/**
 * Derive a headline string from the first sentence or first 80 chars of
 * prose text, falling back to the phrasing_group_id if the text is too short.
 *
 * This is purely deterministic (no LLM) and capped at 120 characters.
 */
function buildHeadline(text: string, phrasingGroupId: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return phrasingGroupId;

  // Try first sentence (end at . / ! / ? / 。/ ！ / ？)
  const sentenceEnd = trimmed.search(/[.!?。！？]/);
  if (sentenceEnd > 10 && sentenceEnd <= 120) {
    return trimmed.slice(0, sentenceEnd + 1).trim();
  }

  // Fall back to first 80 chars, trimmed to nearest word boundary
  const slice = trimmed.slice(0, 80);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 20 ? slice.slice(0, lastSpace) : slice).trim();
}
