/**
 * test/jsonld-deferred-url.test.ts
 *
 * T13 — Tests for the deferred-url token and §0 structural guarantees.
 *
 * Acceptance criteria exercised:
 *   - JsonLdSchema accepts {url:{deferred:true,role:'owned_hub'}} for Organization.
 *   - JsonLdSchema accepts {datePublished:null} for Article.
 *   - JsonLdSchema REJECTS a literal customer-domain url string in the url field.
 *   - Organization.url is the deferred owned-hub token, never the customer domain.
 *   - faqPageJsonLd mainEntity is 1:1 from an already-gated faq asset.
 *   - inLanguage matches the source asset language.
 *
 * DESIGN-phase2.md §"JSON-LD" / §"OWNED-HUB-URL SEAM".
 */

import { describe, it, expect } from "vitest";
import {
  JsonLdSchema,
  DeferredUrlSchema,
  OrganizationJsonLdSchema,
  ArticleJsonLdSchema,
  type ContentAsset,
  type FaqBody,
  type ClaimSourceRow,
} from "../src/content/types.js";
import {
  organizationJsonLd,
  faqPageJsonLd,
  articleJsonLd,
} from "../src/content/jsonld.js";
import type { BrandBrief } from "../src/generate/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BRIEF: BrandBrief = {
  brandName: "EMORA",
  brandAliases: ["エモーラ", "에모라"],
  category: "AI companion app",
  industryKey: "ai-companion",
  positioning: "EMORA differentiates via long-term emotional memory.",
  icp: ["adult users seeking connection"],
  productAttributes: ["voice chat", "emotion tracking", "multilingual"],
  seedCompetitors: [{ name: "Character.AI", aliases: ["CAI"] }],
  detectedLanguages: [{ code: "en", weight: 1.0, rationale: "primary" }],
  confidence: 0.9,
};

const CTX = {
  industry: "ai-companion",
  template_id: "00000000-0000-0000-0000-000000000001",
  template_version: 1,
  content_set_id: "00000000-0000-0000-0000-000000000002",
  customer_id: "00000000-0000-0000-0000-000000000003",
  phrasing_group_id: "pg-org-en",
  language: "en",
};

const CLAIM_SOURCES: ClaimSourceRow[] = [
  {
    id: "00000000-0000-0000-0000-000000000010",
    customer_id: CTX.customer_id,
    claim_text: "Wikidata entity",
    claim_kind: "capability",
    numeric_value: null,
    numeric_unit: null,
    numeric_bound: null,
    source_kind: "public_url",
    source_ref: "https://www.wikidata.org/wiki/Q12345",
    verified_by: "admin",
    verified_at: new Date("2026-01-01"),
    created_at: new Date("2026-01-01"),
  },
];

function makeFaqAsset(language = "en"): ContentAsset {
  const body: FaqBody = {
    content_type: "faq",
    rows: [
      { q: "What is EMORA?", a: "EMORA is an AI companion app.", answer_claim_ids: [] },
      { q: "Is EMORA free?", a: "EMORA offers a free tier.", answer_claim_ids: [] },
      { q: "What languages?", a: "EMORA supports 14 languages.", answer_claim_ids: [] },
    ],
  };
  return {
    id: "00000000-0000-0000-0000-000000000020",
    customer_id: CTX.customer_id,
    industry: CTX.industry,
    template_id: CTX.template_id,
    template_version: CTX.template_version,
    content_set_id: CTX.content_set_id,
    content_type: "faq",
    format: "faq_table",
    channel_class: "owned_net",
    language,
    phrasing_group_id: "pg-faq-en",
    body,
    claims: [],
    word_count: null,
    gate_status: "passed",
    gate_report: null,
    disclosure_tag: null,
    needs_native_review: false,
    regen_attempts: 0,
    provenance: null,
    created_at: new Date(),
  };
}

function makeAnswerBlockAsset(language = "ja"): ContentAsset {
  return {
    id: "00000000-0000-0000-0000-000000000030",
    customer_id: CTX.customer_id,
    industry: CTX.industry,
    template_id: CTX.template_id,
    template_version: CTX.template_version,
    content_set_id: CTX.content_set_id,
    content_type: "answer_block",
    format: "answer_block",
    channel_class: "owned_net",
    language,
    phrasing_group_id: "pg-ab-ja",
    body: {
      content_type: "answer_block",
      text: "EMORAはAIコンパニオンアプリです。長期的な感情記憶と多言語サポートを提供します。",
      length_units: 42,
      numeric_claim_ids: [],
      source_ids: [],
    },
    claims: [],
    word_count: 42,
    gate_status: "passed",
    gate_report: null,
    disclosure_tag: null,
    needs_native_review: false,
    regen_attempts: 0,
    provenance: null,
    created_at: new Date(),
  };
}

// ---------------------------------------------------------------------------
// 1. DeferredUrlSchema validation
// ---------------------------------------------------------------------------

describe("DeferredUrlSchema", () => {
  it("accepts {deferred:true, role:'owned_hub'}", () => {
    const r = DeferredUrlSchema.safeParse({ deferred: true, role: "owned_hub" });
    expect(r.success).toBe(true);
  });

  it("accepts {deferred:true, role:'social_profile'}", () => {
    const r = DeferredUrlSchema.safeParse({ deferred: true, role: "social_profile" });
    expect(r.success).toBe(true);
  });

  it("rejects a literal string url", () => {
    const r = DeferredUrlSchema.safeParse("https://emora.ai");
    expect(r.success).toBe(false);
  });

  it("rejects {deferred:false}", () => {
    const r = DeferredUrlSchema.safeParse({ deferred: false, role: "owned_hub" });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown role", () => {
    const r = DeferredUrlSchema.safeParse({ deferred: true, role: "customer_site" });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. JsonLdSchema — Organization with deferred url
// ---------------------------------------------------------------------------

describe("JsonLdSchema — Organization deferred url", () => {
  it("accepts a valid Organization with deferred url", () => {
    const r = JsonLdSchema.safeParse({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "EMORA",
      url: { deferred: true, role: "owned_hub" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an Organization with a literal customer-domain url", () => {
    // The url field in OrganizationJsonLdSchema requires DeferredUrlSchema,
    // not a string — so a literal customer domain is rejected.
    const r = OrganizationJsonLdSchema.safeParse({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "EMORA",
      url: "https://emora.ai",   // customer domain — must be rejected
    });
    expect(r.success).toBe(false);
  });

  it("rejects an Organization without a url field", () => {
    const r = JsonLdSchema.safeParse({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "EMORA",
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. JsonLdSchema — Article with datePublished:null
// ---------------------------------------------------------------------------

describe("JsonLdSchema — Article datePublished:null", () => {
  it("accepts an Article with datePublished:null and deferred author url", () => {
    const r = JsonLdSchema.safeParse({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "About EMORA",
      articleBody: "EMORA is an AI companion app with emotional memory.",
      inLanguage: "en",
      datePublished: null,
      author: {
        "@type": "Organization",
        name: "EMORA",
        url: { deferred: true, role: "owned_hub" },
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an Article with a non-null datePublished", () => {
    const r = ArticleJsonLdSchema.safeParse({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "About EMORA",
      articleBody: "EMORA is an AI companion app.",
      inLanguage: "en",
      datePublished: "2026-01-01",   // must be null per deferred-url design
    });
    expect(r.success).toBe(false);
  });

  it("rejects an Article missing headline", () => {
    const r = ArticleJsonLdSchema.safeParse({
      "@context": "https://schema.org",
      "@type": "Article",
      articleBody: "EMORA is an AI companion app.",
      inLanguage: "en",
      datePublished: null,
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. organizationJsonLd — §0 deferred-url guarantee
// ---------------------------------------------------------------------------

describe("organizationJsonLd — deferred-url §0 guarantee", () => {
  it("produces an ok result with a valid Organization body", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.body.content_type).toBe("jsonld");
    expect(result.body.schema_type).toBe("Organization");
  });

  it("Organization.url is the deferred owned-hub token, not the customer domain", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const org = result.body.json;
    expect(org["@type"]).toBe("Organization");
    if (org["@type"] !== "Organization") return;

    // url must be the deferred token, never a string
    expect(typeof org.url).toBe("object");
    expect(org.url).toMatchObject({ deferred: true, role: "owned_hub" });
    // url must NOT be the customer domain string
    expect(typeof org.url).not.toBe("string");
  });

  it("asset channel_class is owned_net (§6)", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.channel_class).toBe("owned_net");
  });

  it("asset format is jsonld_org", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.format).toBe("jsonld_org");
  });

  it("asset content_type is jsonld", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.content_type).toBe("jsonld");
  });

  it("asset gate_status is pending (not pre-passed)", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.gate_status).toBe("pending");
  });

  it("includes sameAs from verified public_url claim_sources only", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const org = result.body.json;
    if (org["@type"] !== "Organization") return;
    expect(org.sameAs).toContain("https://www.wikidata.org/wiki/Q12345");
  });

  it("excludes customer_attested sources from sameAs", () => {
    const attestedOnly: ClaimSourceRow[] = [
      {
        id: "00000000-0000-0000-0000-000000000099",
        customer_id: CTX.customer_id,
        claim_text: "We are great",
        claim_kind: "superlative",
        numeric_value: null,
        numeric_unit: null,
        numeric_bound: null,
        source_kind: "customer_attested",
        source_ref: "https://emora.ai/about",
        verified_by: null,
        verified_at: null,
        created_at: new Date(),
      },
    ];
    const result = organizationJsonLd(BRIEF, attestedOnly, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const org = result.body.json;
    if (org["@type"] !== "Organization") return;
    // sameAs should be absent or empty (customer_attested excluded)
    expect(org.sameAs == null || org.sameAs.length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. faqPageJsonLd — 1:1 from faq asset, inLanguage matches
// ---------------------------------------------------------------------------

describe("faqPageJsonLd — mainEntity 1:1, inLanguage matches", () => {
  it("produces an ok result with FAQPage body", () => {
    const faqAsset = makeFaqAsset("en");
    const result = faqPageJsonLd(faqAsset, { ...CTX, phrasing_group_id: "pg-faq-jsonld-en" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.body.schema_type).toBe("FAQPage");
  });

  it("mainEntity length matches faq rows (1:1 derivation)", () => {
    const faqAsset = makeFaqAsset("en");
    const result = faqPageJsonLd(faqAsset, { ...CTX, phrasing_group_id: "pg-faq-jsonld-en" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const faqPage = result.body.json;
    if (faqPage["@type"] !== "FAQPage") return;
    const bodyRows = (faqAsset.body as FaqBody).rows;
    expect(faqPage.mainEntity.length).toBe(bodyRows.length);
  });

  it("mainEntity question/answer texts match the faq rows exactly", () => {
    const faqAsset = makeFaqAsset("en");
    const result = faqPageJsonLd(faqAsset, { ...CTX, phrasing_group_id: "pg-faq-jsonld-en" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const faqPage = result.body.json;
    if (faqPage["@type"] !== "FAQPage") return;
    const rows = (faqAsset.body as FaqBody).rows;
    faqPage.mainEntity.forEach((entity, i) => {
      expect(entity.name).toBe(rows[i]!.q);
      expect(entity.acceptedAnswer.text).toBe(rows[i]!.a);
    });
  });

  it("inLanguage on the asset matches the source faq asset language", () => {
    const faqAsset = makeFaqAsset("ko");
    const result = faqPageJsonLd(faqAsset, { ...CTX, phrasing_group_id: "pg-faq-jsonld-ko", language: "ko" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.asset.language).toBe("ko");
  });

  it("fails with a descriptive error if source is not a faq asset", () => {
    const notFaq = makeAnswerBlockAsset("en");
    const result = faqPageJsonLd(notFaq, { ...CTX, phrasing_group_id: "pg-bad" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("faq");
  });
});

// ---------------------------------------------------------------------------
// 6. articleJsonLd — inLanguage matches, datePublished null
// ---------------------------------------------------------------------------

describe("articleJsonLd — inLanguage matches, deferred url", () => {
  it("produces an ok result from an answer_block asset", () => {
    const abAsset = makeAnswerBlockAsset("ja");
    const result = articleJsonLd(abAsset, BRIEF, { ...CTX, phrasing_group_id: "pg-art-ja" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.body.schema_type).toBe("Article");
  });

  it("inLanguage matches the source asset language", () => {
    const abAsset = makeAnswerBlockAsset("ja");
    const result = articleJsonLd(abAsset, BRIEF, { ...CTX, phrasing_group_id: "pg-art-ja" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.inLanguage).toBe("ja");
    expect(result.asset.language).toBe("ja");
  });

  it("datePublished is null (deferred — not yet provisioned)", () => {
    const abAsset = makeAnswerBlockAsset("en");
    const result = articleJsonLd(abAsset, BRIEF, { ...CTX, phrasing_group_id: "pg-art-en" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.datePublished).toBeNull();
  });

  it("author.url is the deferred owned-hub token (§0)", () => {
    const abAsset = makeAnswerBlockAsset("en");
    const result = articleJsonLd(abAsset, BRIEF, { ...CTX, phrasing_group_id: "pg-art-en" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.author?.url).toMatchObject({ deferred: true, role: "owned_hub" });
  });

  it("asset language matches source when source language is ko", () => {
    const abAsset = makeAnswerBlockAsset("ko");
    const result = articleJsonLd(abAsset, BRIEF, { ...CTX, phrasing_group_id: "pg-art-ko" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.language).toBe("ko");
  });

  it("fails with descriptive error if source is not answer_block or case_study", () => {
    const faqAsset = makeFaqAsset("en");
    const result = articleJsonLd(faqAsset, BRIEF, { ...CTX, phrasing_group_id: "pg-bad" });
    expect(result.ok).toBe(false);
  });
});
