/**
 * test/verifiableNumbers.test.ts
 *
 * T11 acceptance criteria for verifiableNumbersGate:
 *
 * 1. Blocks a bare unsourced number (numeric_claim_ids references unresolved claim).
 * 2. Blocks an unbounded superlative (e.g. "best-in-class" with no resolved source).
 * 3. Passes when no superlatives or numerics are present.
 * 4. Passes when superlative is covered by a resolved claim.
 * 5. Passes when AnswerBlock.numeric_claim_ids are all resolved.
 * 6. Gate has correct name/phase.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { verifiableNumbersGate } from "../src/content/gates/verifiableNumbers.js";
import type { ContentAsset, ContentGateContext, ClaimRecord } from "../src/content/types.js";

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
      text: "EMORA supports multiple languages for character chat.",
      length_units: 8,
      numeric_claim_ids: [],
      source_ids: [],
    },
    claims: [],
    word_count: 8,
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

function makeClaim(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    claim_id: randomUUID(),
    claim_text: "test claim",
    claim_kind: "capability",
    span: { start: 0, end: 10 },
    resolved_source_id: null,
    verification: "unverified",
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
// 1. Blocks bare unsourced number (AnswerBlock.numeric_claim_ids with unresolved claims)
// ---------------------------------------------------------------------------

describe("verifiableNumbersGate — blocks bare unsourced numerics", () => {
  it("BLOCKS AnswerBlock when numeric_claim_ids references a claim with null resolved_source_id", () => {
    const claimId = randomUUID();
    const unresolved = makeClaim({
      claim_id: claimId,
      claim_text: "30% faster",
      claim_kind: "numeric",
      numeric: { value: 30, unit: "%", bound: "exact" },
      resolved_source_id: null, // NOT resolved → bare unsourced number
    });

    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "EMORA is 30% faster than alternatives.",
        length_units: 7,
        numeric_claim_ids: [claimId], // references unresolved claim
        source_ids: [],
      },
      claims: [unresolved],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("numeric_claim_ids");
    expect(result.reason).toContain("§7#2");
  });

  it("BLOCKS AnswerBlock when numeric_claim_ids references a claim_id not in claims[]", () => {
    const missingClaimId = randomUUID();

    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "Supports 14 languages for all users.",
        length_units: 6,
        numeric_claim_ids: [missingClaimId], // referenced but NOT in claims[]
        source_ids: [],
      },
      claims: [], // empty claims
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
  });

  it("PASSES AnswerBlock when all numeric_claim_ids have resolved_source_id", () => {
    const claimId = randomUUID();
    const resolvedClaim = makeClaim({
      claim_id: claimId,
      claim_text: "30% faster",
      claim_kind: "numeric",
      numeric: { value: 30, unit: "%", bound: "exact" },
      resolved_source_id: randomUUID(), // RESOLVED
      verification: "verified",
    });

    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "EMORA is 30% faster than alternatives.",
        length_units: 7,
        numeric_claim_ids: [claimId],
        source_ids: [],
      },
      claims: [resolvedClaim],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    // Superlative check: "faster" is not in the superlative lexicon (it's comparative)
    // Numeric check: claimId is resolved
    expect(result.action).toBe("pass");
  });

  it("PASSES AnswerBlock with empty numeric_claim_ids (no numeric tokens referenced)", () => {
    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "EMORA supports multiple languages for character chat and creative storytelling.",
        length_units: 12,
        numeric_claim_ids: [], // no numerics
        source_ids: [],
      },
      claims: [],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 2. Blocks unbounded superlative
// ---------------------------------------------------------------------------

describe("verifiableNumbersGate — blocks unbounded superlatives", () => {
  it("BLOCKS an English superlative 'best-in-class' with no resolved claim", () => {
    const asset = makeAsset({
      language: "en",
      body: {
        content_type: "answer_block",
        text: "EMORA is a best-in-class AI character chat platform trusted by millions of users worldwide.",
        length_units: 14,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [], // no claims → superlative is unbounded
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("best-in-class");
    expect(result.reason).toContain("§7#2");
  });

  it("BLOCKS 'industry-leading' with no resolved claim", () => {
    const asset = makeAsset({
      language: "en",
      body: {
        content_type: "answer_block",
        text: "EMORA offers industry-leading AI character creation tools.",
        length_units: 8,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("industry-leading");
  });

  it("BLOCKS Korean superlative '최고' with no resolved claim", () => {
    const asset = makeAsset({
      language: "ko",
      body: {
        content_type: "answer_block",
        text: "에모라는 최고의 AI 캐릭터 채팅 서비스입니다.",
        length_units: 13,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("최고");
  });

  it("BLOCKS Japanese superlative '最高' with no resolved claim", () => {
    const asset = makeAsset({
      language: "ja",
      body: {
        content_type: "answer_block",
        text: "エモラは最高のAIキャラクターチャットプラットフォームです。",
        length_units: 20,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("最高");
  });

  it("PASSES 'best' when covered by a resolved superlative claim", () => {
    const claimId = randomUUID();
    const resolvedClaim = makeClaim({
      claim_id: claimId,
      claim_text: "best AI character chat platform",
      claim_kind: "superlative",
      resolved_source_id: randomUUID(), // RESOLVED
      verification: "verified",
    });

    const asset = makeAsset({
      language: "en",
      body: {
        content_type: "answer_block",
        text: "EMORA is the best AI character chat platform for creative storytelling experiences.",
        length_units: 13,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [resolvedClaim],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 3. Clean asset passes
// ---------------------------------------------------------------------------

describe("verifiableNumbersGate — clean asset", () => {
  it("PASSES a clean definition without superlatives or numerics", () => {
    const asset = makeAsset({
      content_type: "definition",
      format: "definition_sentence",
      body: {
        content_type: "definition",
        text: "EMORA is an AI character chat application for creative storytelling in multiple languages.",
        meaning_key: "emora-definition",
      },
      claims: [],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 4. Gate metadata
// ---------------------------------------------------------------------------

describe("verifiableNumbersGate — metadata", () => {
  it("has correct name and phase", () => {
    expect(verifiableNumbersGate.name).toBe("verifiableNumbersGate");
    expect(verifiableNumbersGate.phase).toBe("content");
  });
});
