/**
 * test/jsonld-builders.test.ts
 *
 * T13 — Comprehensive builder tests for the pure deterministic JSON-LD module.
 *
 * Acceptance criteria:
 *   - Builders are pure (no network/LLM) and validate against JsonLdSchema.
 *   - Organization.url is the deferred owned-hub token, never the customer domain.
 *   - FAQPage mainEntity is derived 1:1 from an already-gated faq asset.
 *   - inLanguage matches the source asset language.
 *   - articleJsonLd works for both answer_block and case_study source types.
 *   - asset content_type='jsonld', format is correct, channel_class='owned_net'.
 *   - gate_status='pending' (jsonLdShapeGate must still run).
 *
 * DESIGN-phase2.md §"JSON-LD".
 */

import { describe, it, expect } from "vitest";
import {
  JsonLdSchema,
  type ContentAsset,
  type FaqBody,
  type AnswerBlockBody,
  type CaseStudyBody,
  type ClaimSourceRow,
} from "../src/content/types.js";
import {
  organizationJsonLd,
  faqPageJsonLd,
  articleJsonLd,
} from "../src/content/jsonld.js";
import type { BrandBrief } from "../src/generate/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BRIEF: BrandBrief = {
  brandName: "K-Beauty Care",
  brandAliases: ["K뷰티케어", "Kビューティケア"],
  category: "AI skin analysis / skincare recommendation",
  industryKey: "kbeauty",
  positioning:
    "K-Beauty Care offers no-download, privacy-first AI skin analysis.",
  icp: ["beauty enthusiasts", "skincare newbies"],
  productAttributes: [
    "on-device AI",
    "no download required",
    "free tier",
    "web app",
  ],
  seedCompetitors: [
    { name: "YouCam", aliases: [] },
    { name: "SkinVerse", aliases: [] },
  ],
  detectedLanguages: [
    { code: "en", weight: 1.0, rationale: "primary" },
    { code: "id", weight: 0.8, rationale: "hreflang" },
    { code: "th", weight: 0.5, rationale: "traffic" },
  ],
  confidence: 0.88,
};

const BASE_CTX = {
  industry: "kbeauty",
  template_id: "10000000-0000-0000-0000-000000000001",
  template_version: 2,
  content_set_id: "10000000-0000-0000-0000-000000000002",
  customer_id: "10000000-0000-0000-0000-000000000003",
  phrasing_group_id: "pg-org-en",
  language: "en",
};

const CLAIM_SOURCES: ClaimSourceRow[] = [
  {
    id: "10000000-0000-0000-0000-000000000010",
    customer_id: BASE_CTX.customer_id,
    claim_text: "Crunchbase entity",
    claim_kind: "capability",
    numeric_value: null,
    numeric_unit: null,
    numeric_bound: null,
    source_kind: "public_url",
    source_ref: "https://www.crunchbase.com/organization/k-beauty-care",
    verified_by: "admin",
    verified_at: new Date("2026-01-15"),
    created_at: new Date("2026-01-01"),
  },
  {
    id: "10000000-0000-0000-0000-000000000011",
    customer_id: BASE_CTX.customer_id,
    claim_text: "AlternativeTo listing",
    claim_kind: "capability",
    numeric_value: null,
    numeric_unit: null,
    numeric_bound: null,
    source_kind: "public_url",
    source_ref: "https://alternativeto.net/software/k-beauty-care/",
    verified_by: "admin",
    verified_at: new Date("2026-01-15"),
    created_at: new Date("2026-01-01"),
  },
  {
    // customer_attested — should be EXCLUDED from sameAs
    id: "10000000-0000-0000-0000-000000000012",
    customer_id: BASE_CTX.customer_id,
    claim_text: "Best in class",
    claim_kind: "superlative",
    numeric_value: null,
    numeric_unit: null,
    numeric_bound: null,
    source_kind: "customer_attested",
    source_ref: null,
    verified_by: null,
    verified_at: null,
    created_at: new Date("2026-01-01"),
  },
];

function makeFaqAsset(language: string, rowCount = 4): ContentAsset {
  const rows: FaqBody["rows"] = Array.from({ length: rowCount }, (_, i) => ({
    q: `Question ${i + 1} in ${language}`,
    a: `Answer ${i + 1} in ${language}`,
    answer_claim_ids: [],
  }));
  const body: FaqBody = { content_type: "faq", rows };
  return {
    id: `20000000-0000-0000-0000-00000000000${language.slice(0, 1)}`,
    customer_id: BASE_CTX.customer_id,
    industry: BASE_CTX.industry,
    template_id: BASE_CTX.template_id,
    template_version: BASE_CTX.template_version,
    content_set_id: BASE_CTX.content_set_id,
    content_type: "faq",
    format: "faq_table",
    channel_class: "owned_net",
    language,
    phrasing_group_id: `pg-faq-${language}`,
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

function makeAnswerBlockAsset(language: string, text: string): ContentAsset {
  const body: AnswerBlockBody = {
    content_type: "answer_block",
    text,
    length_units: text.split(/\s+/).length,
    numeric_claim_ids: [],
    source_ids: [],
  };
  return {
    id: `30000000-0000-0000-0000-00000000${language.padStart(4, "0")}`,
    customer_id: BASE_CTX.customer_id,
    industry: BASE_CTX.industry,
    template_id: BASE_CTX.template_id,
    template_version: BASE_CTX.template_version,
    content_set_id: BASE_CTX.content_set_id,
    content_type: "answer_block",
    format: "answer_block",
    channel_class: "owned_net",
    language,
    phrasing_group_id: `pg-ab-${language}`,
    body,
    claims: [],
    word_count: body.length_units,
    gate_status: "passed",
    gate_report: null,
    disclosure_tag: null,
    needs_native_review: false,
    regen_attempts: 0,
    provenance: null,
    created_at: new Date(),
  };
}

function makeCaseStudyAsset(language: string): ContentAsset {
  const body: CaseStudyBody = {
    content_type: "case_study",
    situation:
      "A skincare brand needed to reach mobile-first users in Southeast Asia.",
    action:
      "K-Beauty Care deployed its on-device AI skin analysis with no app download.",
    result:
      "Users completed a skin analysis in under 30 seconds with no data leaving the device.",
    metrics: [
      {
        label: "Analysis completion rate",
        before: "42%",
        after: "87%",
        claim_id: null,
      },
    ],
  };
  return {
    id: `40000000-0000-0000-0000-00000000${language.padStart(4, "0")}`,
    customer_id: BASE_CTX.customer_id,
    industry: BASE_CTX.industry,
    template_id: BASE_CTX.template_id,
    template_version: BASE_CTX.template_version,
    content_set_id: BASE_CTX.content_set_id,
    content_type: "case_study",
    format: "case_study",
    channel_class: "owned_net",
    language,
    phrasing_group_id: `pg-cs-${language}`,
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

// ---------------------------------------------------------------------------
// 1. organizationJsonLd
// ---------------------------------------------------------------------------

describe("organizationJsonLd — pure builder", () => {
  it("returns ok:true and a valid JsonLdBody", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Body validates against JsonLdSchema
    const parsed = JsonLdSchema.safeParse(result.body.json);
    expect(parsed.success).toBe(true);
  });

  it("schema_type is 'Organization'", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.schema_type).toBe("Organization");
  });

  it("@type is 'Organization'", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.json["@type"]).toBe("Organization");
  });

  it("name matches brief.brandName", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const org = result.body.json;
    if (org["@type"] !== "Organization") return;
    expect(org.name).toBe("K-Beauty Care");
  });

  it("alternateName includes brandAliases", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const org = result.body.json;
    if (org["@type"] !== "Organization") return;
    expect(org.alternateName).toContain("K뷰티케어");
    expect(org.alternateName).toContain("Kビューティケア");
  });

  it("url is the deferred owned-hub token", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const org = result.body.json;
    if (org["@type"] !== "Organization") return;
    expect(org.url).toEqual({ deferred: true, role: "owned_hub" });
  });

  it("url is NOT a string (never the customer domain)", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const org = result.body.json;
    if (org["@type"] !== "Organization") return;
    expect(typeof org.url).not.toBe("string");
  });

  it("sameAs contains verified public_url sources", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const org = result.body.json;
    if (org["@type"] !== "Organization") return;
    expect(org.sameAs).toContain(
      "https://www.crunchbase.com/organization/k-beauty-care"
    );
    expect(org.sameAs).toContain(
      "https://alternativeto.net/software/k-beauty-care/"
    );
  });

  it("sameAs does NOT contain customer_attested sources", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const org = result.body.json;
    if (org["@type"] !== "Organization") return;
    // The customer_attested row has source_ref=null, so it cannot appear
    expect(org.sameAs?.every((u) => u.startsWith("http"))).toBe(true);
  });

  it("knowsAbout includes category and productAttributes", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const org = result.body.json;
    if (org["@type"] !== "Organization") return;
    expect(org.knowsAbout).toContain("AI skin analysis / skincare recommendation");
    expect(org.knowsAbout).toContain("on-device AI");
    expect(org.knowsAbout).toContain("no download required");
  });

  it("asset content_type='jsonld', format='jsonld_org'", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.content_type).toBe("jsonld");
    expect(result.asset.format).toBe("jsonld_org");
  });

  it("asset channel_class='owned_net'", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.channel_class).toBe("owned_net");
  });

  it("asset gate_status='pending'", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.gate_status).toBe("pending");
  });

  it("works with empty claimSources (no sameAs)", () => {
    const result = organizationJsonLd(BRIEF, [], BASE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const org = result.body.json;
    if (org["@type"] !== "Organization") return;
    // sameAs should be absent or empty
    expect(org.sameAs == null || org.sameAs.length === 0).toBe(true);
    // url is still the deferred token
    expect(org.url).toEqual({ deferred: true, role: "owned_hub" });
  });

  it("works with a brief that has no positioning (optional field)", () => {
    const briefNoPos: BrandBrief = { ...BRIEF, positioning: undefined };
    const result = organizationJsonLd(briefNoPos, [], BASE_CTX);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. faqPageJsonLd
// ---------------------------------------------------------------------------

describe("faqPageJsonLd — 1:1 from faq asset, inLanguage matches", () => {
  it("returns ok:true and validates against JsonLdSchema", () => {
    const faqAsset = makeFaqAsset("en");
    const result = faqPageJsonLd(faqAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-faq-jsonld-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JsonLdSchema.safeParse(result.body.json);
    expect(parsed.success).toBe(true);
  });

  it("schema_type is 'FAQPage'", () => {
    const faqAsset = makeFaqAsset("en");
    const result = faqPageJsonLd(faqAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-faq-jsonld-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.schema_type).toBe("FAQPage");
  });

  it("mainEntity length equals the source faq rows count", () => {
    const faqAsset = makeFaqAsset("en", 5);
    const result = faqPageJsonLd(faqAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-faq-jsonld-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const faqPage = result.body.json;
    if (faqPage["@type"] !== "FAQPage") return;
    expect(faqPage.mainEntity).toHaveLength(5);
  });

  it("mainEntity[i].name === faqRows[i].q", () => {
    const faqAsset = makeFaqAsset("en", 3);
    const result = faqPageJsonLd(faqAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-faq-jsonld-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const faqPage = result.body.json;
    if (faqPage["@type"] !== "FAQPage") return;
    const rows = (faqAsset.body as FaqBody).rows;
    for (let i = 0; i < rows.length; i++) {
      expect(faqPage.mainEntity[i]!.name).toBe(rows[i]!.q);
    }
  });

  it("mainEntity[i].acceptedAnswer.text === faqRows[i].a", () => {
    const faqAsset = makeFaqAsset("en", 3);
    const result = faqPageJsonLd(faqAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-faq-jsonld-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const faqPage = result.body.json;
    if (faqPage["@type"] !== "FAQPage") return;
    const rows = (faqAsset.body as FaqBody).rows;
    for (let i = 0; i < rows.length; i++) {
      expect(faqPage.mainEntity[i]!.acceptedAnswer.text).toBe(rows[i]!.a);
    }
  });

  it("asset.language matches source faq asset language (en)", () => {
    const faqAsset = makeFaqAsset("en");
    const result = faqPageJsonLd(faqAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-faq-jsonld-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.language).toBe("en");
  });

  it("asset.language matches source faq asset language (id)", () => {
    const faqAsset = makeFaqAsset("id");
    const result = faqPageJsonLd(faqAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-faq-jsonld-id",
      language: "id",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.language).toBe("id");
  });

  it("asset format is 'jsonld_faqpage'", () => {
    const faqAsset = makeFaqAsset("en");
    const result = faqPageJsonLd(faqAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-faq-jsonld-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.format).toBe("jsonld_faqpage");
  });

  it("asset channel_class is 'owned_net'", () => {
    const faqAsset = makeFaqAsset("en");
    const result = faqPageJsonLd(faqAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-faq-jsonld-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.channel_class).toBe("owned_net");
  });

  it("asset gate_status is 'pending'", () => {
    const faqAsset = makeFaqAsset("en");
    const result = faqPageJsonLd(faqAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-faq-jsonld-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.gate_status).toBe("pending");
  });

  it("returns ok:false for a non-faq source asset", () => {
    const abAsset = makeAnswerBlockAsset("en", "This is an answer block text.");
    const result = faqPageJsonLd(abAsset, {
      ...BASE_CTX,
      phrasing_group_id: "pg-bad",
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. articleJsonLd — from answer_block
// ---------------------------------------------------------------------------

describe("articleJsonLd — from answer_block asset", () => {
  const ARTICLE_TEXT =
    "K-Beauty Care provides an on-device AI skin analysis with no download required. " +
    "Users get instant results in their browser. The app is free to use with no signup. " +
    "Built with privacy-first architecture, no data leaves the device.";

  it("returns ok:true and validates against JsonLdSchema", () => {
    const asset = makeAnswerBlockAsset("en", ARTICLE_TEXT);
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JsonLdSchema.safeParse(result.body.json);
    expect(parsed.success).toBe(true);
  });

  it("schema_type is 'Article'", () => {
    const asset = makeAnswerBlockAsset("en", ARTICLE_TEXT);
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.schema_type).toBe("Article");
  });

  it("inLanguage is 'en' matching the source asset", () => {
    const asset = makeAnswerBlockAsset("en", ARTICLE_TEXT);
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.inLanguage).toBe("en");
  });

  it("inLanguage is 'th' when source asset is Thai", () => {
    const asset = makeAnswerBlockAsset("th", "K-Beauty Care ให้บริการวิเคราะห์ผิวด้วย AI");
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-th",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.language).toBe("th");
    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.inLanguage).toBe("th");
  });

  it("datePublished is null", () => {
    const asset = makeAnswerBlockAsset("en", ARTICLE_TEXT);
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.datePublished).toBeNull();
  });

  it("author.url is the deferred token (§0: never customer domain)", () => {
    const asset = makeAnswerBlockAsset("en", ARTICLE_TEXT);
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.author?.url).toEqual({ deferred: true, role: "owned_hub" });
    expect(typeof article.author?.url).not.toBe("string");
  });

  it("publisher.url is the deferred token", () => {
    const asset = makeAnswerBlockAsset("en", ARTICLE_TEXT);
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.publisher?.url).toEqual({ deferred: true, role: "owned_hub" });
  });

  it("author.name matches brief.brandName", () => {
    const asset = makeAnswerBlockAsset("en", ARTICLE_TEXT);
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.author?.name).toBe("K-Beauty Care");
  });

  it("asset format is 'jsonld_article'", () => {
    const asset = makeAnswerBlockAsset("en", ARTICLE_TEXT);
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.format).toBe("jsonld_article");
  });

  it("asset channel_class is 'owned_net'", () => {
    const asset = makeAnswerBlockAsset("en", ARTICLE_TEXT);
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.channel_class).toBe("owned_net");
  });

  it("asset gate_status is 'pending'", () => {
    const asset = makeAnswerBlockAsset("en", ARTICLE_TEXT);
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.gate_status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 4. articleJsonLd — from case_study
// ---------------------------------------------------------------------------

describe("articleJsonLd — from case_study asset", () => {
  it("returns ok:true and validates against JsonLdSchema", () => {
    const asset = makeCaseStudyAsset("en");
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-cs-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JsonLdSchema.safeParse(result.body.json);
    expect(parsed.success).toBe(true);
  });

  it("articleBody contains situation + action + result joined", () => {
    const asset = makeCaseStudyAsset("en");
    const cs = asset.body as CaseStudyBody;
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-cs-en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.articleBody).toContain(cs.situation);
    expect(article.articleBody).toContain(cs.action);
    expect(article.articleBody).toContain(cs.result);
  });

  it("inLanguage matches the case_study source asset language", () => {
    const asset = makeCaseStudyAsset("id");
    const result = articleJsonLd(asset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-cs-id",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const article = result.body.json;
    if (article["@type"] !== "Article") return;
    expect(article.inLanguage).toBe("id");
    expect(result.asset.language).toBe("id");
  });
});

// ---------------------------------------------------------------------------
// 5. Error cases — unsupported source types
// ---------------------------------------------------------------------------

describe("articleJsonLd — unsupported source types", () => {
  it("returns ok:false for a definition source asset", () => {
    const defAsset: ContentAsset = {
      id: "50000000-0000-0000-0000-000000000001",
      customer_id: null,
      industry: "kbeauty",
      template_id: BASE_CTX.template_id,
      template_version: BASE_CTX.template_version,
      content_set_id: BASE_CTX.content_set_id,
      content_type: "definition",
      format: "definition_sentence",
      channel_class: "owned_net",
      language: "en",
      phrasing_group_id: "pg-def-en",
      body: { content_type: "definition", text: "A definition.", meaning_key: "def-1" },
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
    const result = articleJsonLd(defAsset, BRIEF, {
      ...BASE_CTX,
      phrasing_group_id: "pg-art-bad",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 6. Pure / no-LLM contract assertion
// ---------------------------------------------------------------------------

describe("Builders are pure — no async, no network", () => {
  it("organizationJsonLd is synchronous (no Promise)", () => {
    const result = organizationJsonLd(BRIEF, CLAIM_SOURCES, BASE_CTX);
    // If result were a Promise, .ok would be undefined
    expect(typeof result.ok).toBe("boolean");
  });

  it("faqPageJsonLd is synchronous", () => {
    const asset = makeFaqAsset("en");
    const result = faqPageJsonLd(asset, { ...BASE_CTX, phrasing_group_id: "pg-f" });
    expect(typeof result.ok).toBe("boolean");
  });

  it("articleJsonLd is synchronous", () => {
    const asset = makeAnswerBlockAsset("en", "Some answer text for testing synchronous execution.");
    const result = articleJsonLd(asset, BRIEF, { ...BASE_CTX, phrasing_group_id: "pg-a" });
    expect(typeof result.ok).toBe("boolean");
  });
});
