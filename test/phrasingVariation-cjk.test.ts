/**
 * test/phrasingVariation-cjk.test.ts
 *
 * T11 acceptance criteria for phrasingVariationGate:
 *
 * 1. Phrasing gate blocks cross-meaning boilerplate copy-paste in the same language.
 * 2. Phrasing gate exempts cross-language pairs (Korean vs English, etc.).
 * 3. CJK texts are handled correctly (no whitespace tokenization dependence).
 * 4. CONTENT_DUP_THRESHOLD is exported as a single config constant.
 * 5. PR-wire syndication copies (same phrasing_group_id + pr_wire) are exempt.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import {
  phrasingVariationGate,
  CONTENT_DUP_THRESHOLD,
} from "../src/content/gates/phrasingVariation.js";
import type { ContentAsset, ContentGateContext } from "../src/content/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2025-01-01T00:00:00Z");

function makeAsset(overrides: Partial<ContentAsset> = {}): ContentAsset {
  return {
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
      text: "EMORA is an AI character chat platform that supports 14 languages and enables users to create custom AI characters, chat with them, and earn rewards through creator monetization features.",
      length_units: 34,
      numeric_claim_ids: [],
      source_ids: [],
    },
    claims: [],
    word_count: 34,
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

function makeCtx(
  asset: ContentAsset,
  siblings: ContentAsset[] = []
): ContentGateContext {
  return {
    asset,
    siblings,
    brandAliases: ["EMORA"],
    claimSources: [],
  };
}

// ---------------------------------------------------------------------------
// 1. CONTENT_DUP_THRESHOLD is a single config constant
// ---------------------------------------------------------------------------

describe("CONTENT_DUP_THRESHOLD", () => {
  it("is exported and is a number between 0 and 1", () => {
    expect(typeof CONTENT_DUP_THRESHOLD).toBe("number");
    expect(CONTENT_DUP_THRESHOLD).toBeGreaterThan(0);
    expect(CONTENT_DUP_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it("is >= 0.8 (tuned for long content blocks, not short questions)", () => {
    // DESIGN: long fact-dense blocks share brand/category trigrams so threshold
    // must be higher than the 0.65 used for short question dedup.
    expect(CONTENT_DUP_THRESHOLD).toBeGreaterThanOrEqual(0.8);
  });
});

// ---------------------------------------------------------------------------
// 2. Blocks cross-meaning boilerplate copy-paste in the same language
// ---------------------------------------------------------------------------

describe("phrasingVariationGate — same language", () => {
  it("PASSES when asset has no same-language siblings", () => {
    const asset = makeAsset({ language: "en" });
    const ctx = makeCtx(asset, []);
    const result = phrasingVariationGate.apply(ctx);
    expect(result.action).toBe("pass");
  });

  it("PASSES when asset is dissimilar to all siblings", () => {
    const asset = makeAsset({
      language: "en",
      body: {
        content_type: "answer_block",
        text: "EMORA is an AI character chat platform that supports 14 languages and enables users to create custom AI characters, chat with them, and earn rewards through creator monetization features.",
        length_units: 34,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });
    const sibling = makeAsset({
      language: "en",
      phrasing_group_id: "pg-99",
      body: {
        content_type: "answer_block",
        text: "K-Beauty Care offers AI-powered skin analysis technology that provides personalized skincare recommendations based on your unique skin type, concerns, and goals using advanced machine learning algorithms.",
        length_units: 33,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });
    const ctx = makeCtx(asset, [sibling]);
    const result = phrasingVariationGate.apply(ctx);
    expect(result.action).toBe("pass");
  });

  it("BLOCKS when asset text is nearly identical to a sibling (copy-paste boilerplate)", () => {
    const sharedText =
      "EMORA is the best AI character chat platform that supports 14 languages " +
      "and enables users to create custom AI characters, chat with them, and earn rewards " +
      "through creator monetization features. Available on web and mobile for global users.";

    const asset = makeAsset({
      language: "en",
      phrasing_group_id: "pg-1",
      body: {
        content_type: "answer_block",
        text: sharedText,
        length_units: sharedText.split(/\s+/).length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    // Sibling with the SAME text but a different phrasing_group_id (cross-meaning copy-paste)
    const sibling = makeAsset({
      language: "en",
      phrasing_group_id: "pg-2",
      body: {
        content_type: "answer_block",
        text: sharedText,
        length_units: sharedText.split(/\s+/).length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    const ctx = makeCtx(asset, [sibling]);
    const result = phrasingVariationGate.apply(ctx);
    expect(result.action).toBe("block");
    expect(result.reason).toContain("trigramJaccard");
    expect(result.reason).toContain("CONTENT_DUP_THRESHOLD");
  });
});

// ---------------------------------------------------------------------------
// 3. Exempts cross-language pairs
// ---------------------------------------------------------------------------

describe("phrasingVariationGate — cross-language exemption", () => {
  it("PASSES when only sibling is a different language (cross-language exempt)", () => {
    const sharedEnglishText =
      "EMORA is an AI character chat platform that supports 14 languages " +
      "and enables users to create custom AI characters, chat with them, " +
      "and earn rewards through creator monetization features on mobile and web.";

    const enAsset = makeAsset({
      language: "en",
      phrasing_group_id: "pg-1",
      body: {
        content_type: "answer_block",
        text: sharedEnglishText,
        length_units: sharedEnglishText.split(/\s+/).length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    // Korean sibling — text content is irrelevant, different language → exempt
    const koSibling = makeAsset({
      language: "ko",
      phrasing_group_id: "pg-1",
      body: {
        content_type: "answer_block",
        text: sharedEnglishText, // even if identical text, cross-language is exempt
        length_units: sharedEnglishText.split(/\s+/).length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    const ctx = makeCtx(enAsset, [koSibling]);
    const result = phrasingVariationGate.apply(ctx);
    // Cross-language pairs are EXEMPT — sibling is filtered out by language check
    expect(result.action).toBe("pass");
  });

  it("BLOCKS same-language but PASSES cross-language in mixed sibling set", () => {
    const identicalText =
      "EMORA provides AI character chat in 14 languages with creator " +
      "monetization, group chat, and persistent memory across all conversation sessions.";

    const asset = makeAsset({
      language: "en",
      phrasing_group_id: "pg-1",
      body: {
        content_type: "answer_block",
        text: identicalText,
        length_units: identicalText.split(/\s+/).length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    const enSibling = makeAsset({
      language: "en",
      phrasing_group_id: "pg-2",
      body: {
        content_type: "answer_block",
        text: identicalText, // identical → will exceed threshold
        length_units: identicalText.split(/\s+/).length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    const koSibling = makeAsset({
      language: "ko",
      phrasing_group_id: "pg-1",
      body: {
        content_type: "answer_block",
        text: identicalText,
        length_units: identicalText.split(/\s+/).length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    const ctx = makeCtx(asset, [enSibling, koSibling]);
    const result = phrasingVariationGate.apply(ctx);
    // Should block because of the same-language sibling
    expect(result.action).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// 4. CJK texts handled correctly (no whitespace tokenization)
// ---------------------------------------------------------------------------

describe("phrasingVariationGate — CJK text", () => {
  it("PASSES for a Korean asset with no Korean siblings", () => {
    const asset = makeAsset({
      language: "ko",
      body: {
        content_type: "answer_block",
        text: "에모라는 14개 언어를 지원하는 AI 캐릭터 채팅 플랫폼으로, 사용자가 맞춤형 AI 캐릭터를 만들고, 대화하고, 크리에이터 수익화 기능을 통해 보상을 받을 수 있습니다.",
        length_units: 50,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    // Only has English sibling — cross-language, exempt
    const enSibling = makeAsset({ language: "en" });
    const ctx = makeCtx(asset, [enSibling]);
    const result = phrasingVariationGate.apply(ctx);
    expect(result.action).toBe("pass");
  });

  it("BLOCKS identical Korean text as same-language near-dup", () => {
    const koText = "에모라는 14개 언어를 지원하는 AI 캐릭터 채팅 플랫폼으로, 사용자가 맞춤형 AI 캐릭터를 만들고 대화하며 크리에이터 수익화로 보상을 받습니다. 모바일과 웹에서 이용 가능합니다.";

    const asset = makeAsset({
      language: "ko",
      phrasing_group_id: "pg-1",
      body: {
        content_type: "answer_block",
        text: koText,
        length_units: koText.length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    const sibling = makeAsset({
      language: "ko",
      phrasing_group_id: "pg-2",
      body: {
        content_type: "answer_block",
        text: koText, // identical → blocks
        length_units: koText.length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    const ctx = makeCtx(asset, [sibling]);
    const result = phrasingVariationGate.apply(ctx);
    expect(result.action).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// 5. PR-wire syndication exemption
// ---------------------------------------------------------------------------

describe("phrasingVariationGate — PR-wire syndication exemption", () => {
  it("PASSES PR-wire copy with same phrasing_group_id (intentional syndication fan-out)", () => {
    const syndicatedText =
      "EMORA, the AI character chat platform supporting 14 languages, announces " +
      "new creator monetization features enabling users to earn rewards from their " +
      "AI character creations and interactions across the platform.";

    const asset = makeAsset({
      language: "en",
      channel_class: "pr_wire",
      phrasing_group_id: "pg-pr-1",
      body: {
        content_type: "answer_block",
        text: syndicatedText,
        length_units: syndicatedText.split(/\s+/).length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    // Another PR-wire copy of the SAME phrasing_group (syndication to another outlet)
    const prWireSibling = makeAsset({
      language: "en",
      channel_class: "pr_wire",
      phrasing_group_id: "pg-pr-1", // same phrasing group → syndication exemption
      body: {
        content_type: "answer_block",
        text: syndicatedText, // identical text — intentional syndication
        length_units: syndicatedText.split(/\s+/).length,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });

    const ctx = makeCtx(asset, [prWireSibling]);
    const result = phrasingVariationGate.apply(ctx);
    // PR-wire same-phrasing-group copies are EXEMPT (intentional fan-out)
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 6. Gate metadata
// ---------------------------------------------------------------------------

describe("phrasingVariationGate — metadata", () => {
  it("has correct name and phase", () => {
    expect(phrasingVariationGate.name).toBe("phrasingVariationGate");
    expect(phrasingVariationGate.phase).toBe("content");
  });
});
