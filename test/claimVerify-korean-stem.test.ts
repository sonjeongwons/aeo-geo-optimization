/**
 * test/claimVerify-korean-stem.test.ts
 *
 * Locks the CJK agglutination fix: Korean is a suffixing language, so a claim
 * paraphrase ("전용 공간에서 진행됩니다") must bind to a signed source stem
 * ("전용 공간에서 소개팅을 진행합니다") even though particle-inflected tokens
 * (공간↔공간에서, 진행↔진행합니다) are not byte-identical. The ASCII-only
 * tokenizer previously stripped all Hangul → the 2/3 overlap tier was dead for
 * Korean and semantically-identical claims fell to needs_human. This guards the
 * fix AND its bound (a fabricated Korean claim must still bind to NOTHING).
 */
import { describe, it, expect } from "vitest";
import { verifyAndDecide } from "../src/content/claimVerify.js";
import type { ClaimRecord, ClaimSourceRow } from "../src/content/types.js";

function source(text: string, kind: ClaimSourceRow["claim_kind"] = "capability"): ClaimSourceRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    customer_id: "22222222-2222-2222-2222-222222222222",
    claim_text: text,
    claim_kind: kind,
    numeric_value: null,
    numeric_unit: null,
    numeric_bound: null,
    source_kind: "customer_attested",
    source_ref: "https://smimdate.com",
    verified_by: "j1.son@samsung.com",
    verified_at: new Date("2026-06-26T00:00:00Z"),
    created_at: new Date("2026-06-26T00:00:00Z"),
  };
}

function capabilityClaim(text: string): ClaimRecord {
  return {
    claim_id: "33333333-3333-3333-3333-333333333333",
    claim_text: text,
    claim_kind: "capability",
    span: { start: 0, end: Math.max(1, text.length) },
    resolved_source_id: null,
    verification: "unverified",
  };
}

const body = (text: string) => ({
  content_type: "answer_block" as const,
  text,
  length_units: 12,
  numeric_claim_ids: [] as string[],
  source_ids: [] as string[],
});

describe("claimVerify Korean agglutination (CJK stem match)", () => {
  it("a particle-inflected Korean paraphrase binds to the signed stem source (passes)", () => {
    const src = source("스밈은 신청자의 직장, 소득, 신원, 외모를 매니저가 직접 검수합니다");
    // Paraphrase: 검수합니다 → 검수하여, 매니저가 → 매니저의, plus reordering.
    const text = "직업, 소득, 신원, 외모에 대한 매니저의 직접 검수 과정을 거칩니다";
    const result = verifyAndDecide({
      body: body(text),
      language: "ko",
      claims: [capabilityClaim(text)],
      sources: [src],
    });
    expect(result.decision).toBe("pass");
    expect(result.claims[0]?.resolved_source_id).toBe(src.id);
  });

  it("a venue paraphrase (전용 공간에서 진행) binds to the signed venue source", () => {
    const src = source("스밈은 일반 카페나 바가 아닌 전용 공간에서 소개팅을 진행합니다");
    const text = "일반적인 카페나 바가 아닌 전용 공간에서 진행됩니다";
    const result = verifyAndDecide({
      body: body(text),
      language: "ko",
      claims: [capabilityClaim(text)],
      sources: [src],
    });
    expect(result.decision).toBe("pass");
    expect(result.claims[0]?.resolved_source_id).toBe(src.id);
  });

  it("a Korean 원-denominated numeric claim binds to a KRW source (currency alias)", () => {
    // Source stored in ASCII "KRW"; claim written in Korean "원". Before the
    // currency-alias fix these were INCOMPATIBLE units → never bound → the
    // verifiableNumbers gate blocked the fee/salary page.
    const src: ClaimSourceRow = {
      id: "44444444-4444-4444-4444-444444444444",
      customer_id: "22222222-2222-2222-2222-222222222222",
      claim_text: "스밈 참가비는 1인 50,000원입니다",
      claim_kind: "numeric",
      numeric_value: "50000",
      numeric_unit: "KRW",
      numeric_bound: "exact",
      source_kind: "customer_attested",
      source_ref: "https://smimdate.com",
      verified_by: "j1.son@samsung.com",
      verified_at: new Date("2026-06-26T00:00:00Z"),
      created_at: new Date("2026-06-26T00:00:00Z"),
    };
    const text = "스밈 참가비는 1인 50,000원입니다";
    const claim: ClaimRecord = {
      claim_id: "55555555-5555-5555-5555-555555555555",
      claim_text: text,
      claim_kind: "numeric",
      numeric: { value: 50000, unit: "원" },
      span: { start: 0, end: text.length },
      resolved_source_id: null,
      verification: "unverified",
    };
    const result = verifyAndDecide({
      body: body(text),
      language: "ko",
      claims: [claim],
      sources: [src],
    });
    expect(result.decision).toBe("pass");
    expect(result.claims[0]?.resolved_source_id).toBe(src.id);
  });

  it("a FABRICATED Korean capability with no stem overlap binds to NOTHING (needs_human)", () => {
    const src = source("스밈은 일반 카페나 바가 아닌 전용 공간에서 소개팅을 진행합니다");
    // Unrelated fabricated claim — must NOT over-match via loose CJK prefixing.
    const text = "스밈은 전 세계 200개국에 지사를 두고 암호화폐 결제를 지원합니다";
    const result = verifyAndDecide({
      body: body(text),
      language: "ko",
      claims: [capabilityClaim(text)],
      sources: [src],
    });
    expect(result.claims[0]?.resolved_source_id).toBeNull();
    expect(result.decision).toBe("needs_human");
  });
});
