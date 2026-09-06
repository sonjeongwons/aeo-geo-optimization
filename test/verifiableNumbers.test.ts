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
import type { ContentAsset, ContentGateContext, ClaimRecord, ClaimSourceRow } from "../src/content/types.js";

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

function makeClaimSource(overrides: Partial<ClaimSourceRow> = {}): ClaimSourceRow {
  return {
    id: randomUUID(),
    customer_id: "cust-1",
    claim_text: "test source claim",
    claim_kind: "capability",
    numeric_value: null,
    numeric_unit: null,
    numeric_bound: null,
    source_kind: "customer_attested",
    source_ref: null,
    verified_by: "owner@example.com",
    verified_at: NOW,
    created_at: NOW,
    ...overrides,
  };
}

function makeCtx(asset: ContentAsset, claimSources: ClaimSourceRow[] = []): ContentGateContext {
  return {
    asset,
    siblings: [],
    brandAliases: ["EMORA"],
    claimSources,
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

describe("verifiableNumbersGate — CJK superlative false positives (W1.7)", () => {
  const koAsset = (text: string) =>
    makeAsset({ language: "ko", body: { content_type: "answer_block", text, length_units: text.length, numeric_claim_ids: [], source_ids: [] }, claims: [] });

  it("does NOT block '최대한' (as-much-as-possible, not the superlative 최대)", () => {
    const result = verifiableNumbersGate.apply(makeCtx(koAsset("스밈은 최대한 안전하게 매칭을 진행합니다.")));
    expect(result.action).toBe("pass");
  });

  it("does NOT trip the 최대 superlative on the bounded quantifier '최대 50' (number verified separately)", () => {
    // The bare word 최대 before a number is a bounded quantifier, not a
    // superlative claim; if this asset blocks it must NOT be for the 최대 term.
    const result = verifiableNumbersGate.apply(makeCtx(koAsset("스밈 회차는 최대 50명 규모로 진행됩니다.")));
    if (result.action !== "pass") {
      expect(result.reason ?? "").not.toContain("최대");
    }
  });

  it("STILL blocks the bare superlative '최대의' (genuine superlative use)", () => {
    const result = verifiableNumbersGate.apply(makeCtx(koAsset("스밈은 최대의 검증 서비스를 제공합니다.")));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("최대");
  });

  it("STILL blocks '완벽하게' (a real superlative claim — §7-conservative)", () => {
    const result = verifiableNumbersGate.apply(makeCtx(koAsset("스밈은 신원을 완벽하게 검증합니다.")));
    expect(result.action).toBe("block");
  });

  it("does NOT block '유튜브 프리미엄' (Google's product name, not a self-praise claim)", () => {
    const result = verifiableNumbersGate.apply(makeCtx(koAsset("쉐어조아는 유튜브 프리미엄을 할인가에 제공합니다.")));
    expect(result.action).toBe("pass");
  });

  it("does NOT block '유튜브 뮤직 프리미엄' (same product-name exception)", () => {
    const result = verifiableNumbersGate.apply(makeCtx(koAsset("쉐어조아는 유튜브 뮤직 프리미엄을 포함하여 제공합니다.")));
    expect(result.action).toBe("pass");
  });

  it("STILL blocks a bare '프리미엄' self-praise claim (not preceded by 유튜브/뮤직)", () => {
    const result = verifiableNumbersGate.apply(makeCtx(koAsset("쉐어조아는 프리미엄 서비스를 제공합니다.")));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("프리미엄");
  });
});

// ---------------------------------------------------------------------------
// Coverage against ctx.claimSources (the customer's verified claim_source
// registry) directly, independent of asset.claims (which is EMPTY on first
// generation — claimExtract only runs inside claimVerificationGate, which is
// skipped once a cheap gate already blocked). See verifiableNumbers.ts's
// "Cheap coverage against the customer's claim_source registry" section.
// ---------------------------------------------------------------------------

describe("verifiableNumbersGate — coverage via ctx.claimSources (no LLM needed)", () => {
  const koAsset = (text: string) =>
    makeAsset({ language: "ko", body: { content_type: "answer_block", text, length_units: text.length, numeric_claim_ids: [], source_ids: [] }, claims: [] });

  it("passes a bare numeric token whose VALUE matches a verified numeric claim_source", () => {
    const src = makeClaimSource({
      claim_text: "운산파트너스는 28년 자동차 정비 노하우를 바탕으로 운영됩니다.",
      claim_kind: "numeric",
      numeric_value: "28",
      numeric_unit: "년",
    });
    const result = verifiableNumbersGate.apply(
      makeCtx(koAsset("운산파트너스는 28년의 정비 경험을 갖추고 있습니다."), [src])
    );
    expect(result.action).toBe("pass");
  });

  it("STILL blocks a bare numeric token with NO matching claim_source value", () => {
    const src = makeClaimSource({
      claim_text: "공임비의 5%를 기준으로 정산합니다.",
      claim_kind: "numeric",
      numeric_value: "5",
      numeric_unit: "%",
    });
    const result = verifiableNumbersGate.apply(
      makeCtx(koAsset("운산파트너스는 24시간 접수를 제공합니다."), [src])
    );
    expect(result.action).toBe("block");
    expect(result.reason).toContain("24");
  });

  it("does NOT count an UNSIGNED claim_source (verified_by null) as coverage", () => {
    const src = makeClaimSource({
      claim_kind: "numeric",
      numeric_value: "28",
      numeric_unit: "년",
      verified_by: null,
      verified_at: null,
    });
    const result = verifiableNumbersGate.apply(
      makeCtx(koAsset("운산파트너스는 28년의 정비 경험을 갖추고 있습니다."), [src])
    );
    expect(result.action).toBe("block");
  });

  it("passes a superlative covered by a verified claim_source's claim_text", () => {
    const src = makeClaimSource({
      claim_text: "쉐어조아는 프리미엄 구독을 할인가에 제공하는 정식 등록 사업자입니다.",
      claim_kind: "capability",
    });
    const result = verifiableNumbersGate.apply(
      makeCtx(koAsset("쉐어조아는 프리미엄 혜택을 제공합니다."), [src])
    );
    expect(result.action).toBe("pass");
  });
});

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
