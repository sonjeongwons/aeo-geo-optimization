/**
 * test/jsonld-shape.test.ts
 *
 * T11 acceptance criteria for jsonLdShapeGate:
 *
 * 1. BLOCKS 'best-in-class' string inside articleBody.
 * 2. BLOCKS Organization JSON-LD when url is NOT a deferred token.
 * 3. BLOCKS Article JSON-LD with a superlative in headline.
 * 4. BLOCKS Article JSON-LD with an unsourced bare numeric in articleBody.
 * 5. PASSES valid Organization JSON-LD with deferred url token.
 * 6. PASSES valid FAQPage JSON-LD with clean acceptedAnswer text.
 * 7. PASSES valid Article JSON-LD with clean body (no superlatives/bare numerics).
 * 8. Non-jsonld assets are NOOP (always pass).
 * 9. Gate has correct name/phase.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { jsonLdShapeGate } from "../src/content/gates/jsonLdShape.js";
import type {
  ContentAsset,
  ContentGateContext,
  ContentAsset as Asset,
} from "../src/content/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2025-01-01T00:00:00Z");

function makeJsonLdAsset(overrides: Partial<ContentAsset> = {}): ContentAsset {
  return {
    id: randomUUID(),
    customer_id: null,
    industry: "tech",
    template_id: randomUUID(),
    template_version: 1,
    content_set_id: randomUUID(),
    content_type: "jsonld",
    format: "jsonld_article",
    channel_class: "owned_net",
    language: "en",
    phrasing_group_id: "pg-jsonld-1",
    body: {
      content_type: "jsonld",
      schema_type: "Article",
      json: {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: "EMORA AI Character Chat Platform Review",
        articleBody: "EMORA is an AI character chat platform supporting multiple languages.",
        inLanguage: "en",
        datePublished: null,
      },
    },
    claims: [],
    word_count: null,
    gate_status: "pending",
    gate_report: null,
    disclosure_tag: null,
    needs_native_review: false,
    regen_attempts: 0,
    provenance: null,
    created_at: NOW,
    ...overrides,
  };
}

function makeCtx(asset: ContentAsset): ContentGateContext {
  return {
    asset,
    siblings: [],
    brandAliases: ["EMORA"],
    claimSources: [],
  };
}

// ---------------------------------------------------------------------------
// 1. BLOCKS 'best-in-class' inside articleBody (primary acceptance criterion)
// ---------------------------------------------------------------------------

describe("jsonLdShapeGate — superlative in JSON-LD text", () => {
  it("BLOCKS 'best-in-class' string inside articleBody", () => {
    const asset = makeJsonLdAsset({
      body: {
        content_type: "jsonld",
        schema_type: "Article",
        json: {
          "@context": "https://schema.org",
          "@type": "Article",
          headline: "EMORA Platform Overview",
          articleBody:
            "EMORA is a best-in-class AI character chat platform that enables " +
            "creative storytelling in multiple languages.",
          inLanguage: "en",
          datePublished: null,
        },
      },
    });

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("best-in-class");
    expect(result.reason).toContain("§7#2");
  });

  it("BLOCKS 'industry-leading' inside Article.headline", () => {
    const asset = makeJsonLdAsset({
      body: {
        content_type: "jsonld",
        schema_type: "Article",
        json: {
          "@context": "https://schema.org",
          "@type": "Article",
          headline: "The industry-leading AI Character Chat Platform: EMORA",
          articleBody: "EMORA supports multiple languages for creative AI chat.",
          inLanguage: "en",
          datePublished: null,
        },
      },
    });

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("industry-leading");
  });

  it("BLOCKS Japanese superlative '最高' inside Organization description", () => {
    const asset = makeJsonLdAsset({
      language: "ja",
      format: "jsonld_org",
      body: {
        content_type: "jsonld",
        schema_type: "Organization",
        json: {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "EMORA",
          url: { deferred: true, role: "owned_hub" as const },
          description: "エモラは最高のAIキャラクターチャットプラットフォームです。",
        },
      },
    });

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("最高");
  });

  it("BLOCKS Korean superlative '최고' inside FAQPage acceptedAnswer text", () => {
    const asset = makeJsonLdAsset({
      language: "ko",
      format: "jsonld_faqpage",
      body: {
        content_type: "jsonld",
        schema_type: "FAQPage",
        json: {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: "에모라는 어떤 서비스인가요?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "에모라는 최고의 AI 캐릭터 채팅 플랫폼으로 14개 언어를 지원합니다.",
              },
            },
          ],
        },
      },
    });

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("최고");
  });
});

// ---------------------------------------------------------------------------
// 2. BLOCKS Organization when url is NOT a deferred token
// ---------------------------------------------------------------------------

describe("jsonLdShapeGate — Organization url must be deferred token", () => {
  it("BLOCKS Organization with a literal URL string instead of deferred token", () => {
    const asset = makeJsonLdAsset({
      format: "jsonld_org",
      body: {
        content_type: "jsonld",
        schema_type: "Organization",
        json: {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "EMORA",
          // url is a string, not the deferred token → should be blocked by schema validation
          url: "https://example-customer.com" as unknown as { deferred: true; role: "owned_hub" },
        },
      },
    });

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// 3. PASSES valid JSON-LD assets
// ---------------------------------------------------------------------------

describe("jsonLdShapeGate — valid JSON-LD passes", () => {
  it("PASSES valid Organization JSON-LD with deferred url token", () => {
    const asset = makeJsonLdAsset({
      format: "jsonld_org",
      body: {
        content_type: "jsonld",
        schema_type: "Organization",
        json: {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "EMORA",
          url: { deferred: true, role: "owned_hub" },
          description: "An AI character chat platform for creative storytelling in multiple languages.",
          knowsAbout: ["AI character chat", "multilingual content", "creative storytelling"],
        },
      },
    });

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });

  it("PASSES valid Article JSON-LD with clean body (no superlatives or bare numerics)", () => {
    const asset = makeJsonLdAsset({
      format: "jsonld_article",
      body: {
        content_type: "jsonld",
        schema_type: "Article",
        json: {
          "@context": "https://schema.org",
          "@type": "Article",
          headline: "How EMORA Enables Multilingual AI Character Chat",
          articleBody:
            "EMORA is an AI character chat platform that supports multiple languages, " +
            "enabling users to create and interact with custom AI characters. " +
            "The platform features persistent memory, group chat, and creator monetization tools.",
          inLanguage: "en",
          datePublished: null,
        },
      },
    });

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });

  it("PASSES valid FAQPage JSON-LD with clean question/answer text", () => {
    const asset = makeJsonLdAsset({
      format: "jsonld_faqpage",
      body: {
        content_type: "jsonld",
        schema_type: "FAQPage",
        json: {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: "What is EMORA?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "EMORA is an AI character chat platform supporting multiple languages for creative storytelling.",
              },
            },
            {
              "@type": "Question",
              name: "Which languages does EMORA support?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "EMORA offers character chat in multiple languages including English, Japanese, and Korean.",
              },
            },
          ],
        },
      },
    });

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 4. Non-jsonld assets are NOOP
// ---------------------------------------------------------------------------

describe("jsonLdShapeGate — NOP for non-jsonld assets", () => {
  it("PASSES an answer_block asset immediately (NOP)", () => {
    const asset: ContentAsset = {
      id: randomUUID(),
      customer_id: "cust-1",
      industry: "tech",
      template_id: randomUUID(),
      template_version: 1,
      content_set_id: randomUUID(),
      content_type: "answer_block",
      format: "answer_block",
      channel_class: "owned_net",
      language: "en",
      phrasing_group_id: "pg-1",
      body: {
        content_type: "answer_block",
        text: "EMORA is best-in-class AI chat platform. With over 5,000 reviews and 4.8 stars!",
        length_units: 15,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
      word_count: 15,
      gate_status: "pending",
      gate_report: null,
      disclosure_tag: null,
      needs_native_review: false,
      regen_attempts: 0,
      provenance: null,
      created_at: NOW,
    };

    // jsonLdShapeGate should be NOP for answer_block even if the text has issues
    // (those are caught by other gates)
    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
    expect(result.gate).toBe("jsonLdShapeGate");
  });

  it("PASSES a definition asset immediately (NOP)", () => {
    const asset: ContentAsset = {
      id: randomUUID(),
      customer_id: null,
      industry: "tech",
      template_id: randomUUID(),
      template_version: 1,
      content_set_id: randomUUID(),
      content_type: "definition",
      format: "definition_sentence",
      channel_class: "owned_net",
      language: "en",
      phrasing_group_id: "pg-1",
      body: {
        content_type: "definition",
        text: "EMORA is the best AI character chat app.",
        meaning_key: "emora-def",
      },
      claims: [],
      word_count: null,
      gate_status: "pending",
      gate_report: null,
      disclosure_tag: null,
      needs_native_review: false,
      regen_attempts: 0,
      provenance: null,
      created_at: NOW,
    };

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 5. Gate metadata
// ---------------------------------------------------------------------------

describe("jsonLdShapeGate — metadata", () => {
  it("has correct name and phase", () => {
    expect(jsonLdShapeGate.name).toBe("jsonLdShapeGate");
    expect(jsonLdShapeGate.phase).toBe("content");
  });
});
