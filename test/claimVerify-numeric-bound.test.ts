/**
 * test/claimVerify-numeric-bound.test.ts
 *
 * T10 acceptance criteria for claimVerify.ts:
 *
 * 1. A claim resolving to a source stores resolved_source_id = the exact row id.
 * 2. Numeric over the normalized bound → block; 30% vs attested 'up to 50%' → not auto-pass
 *    (30% ≤ 50% → within; 60% vs 'up to 50%' → block is the correct reading per the spec).
 *    NOTE: The spec says "30% vs 'up to 50%' fails" — reading the DESIGN more carefully:
 *    it means 30% PASSES when the source says "up to 50%" (30 ≤ 50), but the CLAIM asserting
 *    a HIGHER value than the source bound is what blocks. The spec example "30% vs 'up to 50%'
 *    fails" is in context of "a claim saying 30% while the SOURCE says exactly 50% is wrong".
 *    Re-reading: "30% vs 'up to 50%' fails" — the CLAIM says 30%, SOURCE says upTo 50% →
 *    claim value (30) ≤ source value (50) → WITHIN (not auto-pass is wrong).
 *    The actual acceptance criterion is: "30% vs attested 'up to 50%' → not auto-pass" meaning
 *    that a claim of 30% while the SOURCE says "up to 50%" with customer_attested+unsigned
 *    should still be needs_human (because the source itself is unsigned). That's the real test.
 * 3. Empty/failed extraction with backstop-detected numeric → needs_human (fail closed).
 * 4. Superlative with no source row never auto-passes; pure/deterministic, no LLM.
 */

import { describe, it, expect } from "vitest";
import {
  verifyAndDecide,
  checkNumericBound,
  type VerifyResult,
} from "../src/content/claimVerify.js";
import type { ClaimRecord, ClaimSourceRow } from "../src/content/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2025-01-01T00:00:00Z");

function makeClaimRecord(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    claim_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    claim_text: "30% faster than competitors",
    claim_kind: "numeric",
    numeric: { value: 30, unit: "%", bound: "exact" },
    span: { start: 0, end: 30 },
    resolved_source_id: null,
    verification: "unverified",
    ...overrides,
  };
}

function makeSourceRow(overrides: Partial<ClaimSourceRow> = {}): ClaimSourceRow {
  return {
    id: "src-row-001-0000-0000-0000-000000000001",
    customer_id: "cust-0000-0000-0000-0000-000000000001",
    claim_text: "30% faster than competitors",
    claim_kind: "numeric",
    numeric_value: "50",
    numeric_unit: "%",
    numeric_bound: "upTo",
    source_kind: "public_url",
    source_ref: "https://example.com/research",
    verified_by: "human@example.com",
    verified_at: NOW,
    created_at: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkNumericBound unit tests
// ---------------------------------------------------------------------------

describe("checkNumericBound — unit normalization", () => {
  it("30% claim vs upTo 50% source → within", () => {
    expect(checkNumericBound(30, "%", 50, "%", "upTo")).toBe("within");
  });

  it("60% claim vs upTo 50% source → exceeds (BLOCK)", () => {
    expect(checkNumericBound(60, "%", 50, "%", "upTo")).toBe("exceeds");
  });

  it("exact: 30% claim vs exact 30% source → within", () => {
    expect(checkNumericBound(30, "%", 30, "%", "exact")).toBe("within");
  });

  it("exact: 31% claim vs exact 30% source → exceeds", () => {
    expect(checkNumericBound(31, "%", 30, "%", "exact")).toBe("exceeds");
  });

  it("atLeast: 2x claim vs atLeast 1.5x source → within", () => {
    expect(checkNumericBound(2, "x", 1.5, "x", "atLeast")).toBe("within");
  });

  it("atLeast: 1x claim vs atLeast 1.5x source → exceeds", () => {
    expect(checkNumericBound(1, "x", 1.5, "x", "atLeast")).toBe("exceeds");
  });

  it("unit mismatch → incompatible", () => {
    expect(checkNumericBound(30, "%", 50, "x", "upTo")).toBe("incompatible");
  });

  it("2x normalizes same as 200%? — no, they are different canonical units → incompatible", () => {
    // 2x (multiplier) and 200% (percentage) have different canonical units
    expect(checkNumericBound(2, "x", 200, "%", "upTo")).toBe("incompatible");
  });

  it("million suffix: 2 million (count 2e6) vs upTo 3 million (count 3e6) → within", () => {
    expect(checkNumericBound(2, "million", 3, "million", "upTo")).toBe("within");
  });

  it("k suffix: 5000 (5k count) vs atLeast 3000 → within", () => {
    // normalize: 5k → 5000 count, 3k → 3000 count
    expect(checkNumericBound(5, "k", 3, "k", "atLeast")).toBe("within");
  });
});

// ---------------------------------------------------------------------------
// verifyAndDecide — resolved_source_id binding
// ---------------------------------------------------------------------------

describe("verifyAndDecide — resolved_source_id binding", () => {
  it("claim resolving to a source stores resolved_source_id = the exact row id", () => {
    const claim = makeClaimRecord({
      numeric: { value: 30, unit: "%", bound: "exact" },
    });
    const source = makeSourceRow({
      numeric_value: "30",
      numeric_bound: "exact",
    });

    const result: VerifyResult = verifyAndDecide({
      body: { content_type: "answer_block", text: "30% faster than competitors", length_units: 5, numeric_claim_ids: [claim.claim_id], source_ids: [] },
      language: "en",
      claims: [claim],
      sources: [source],
    });

    expect(result.claims[0]?.resolved_source_id).toBe(source.id);
    expect(result.claims[0]?.resolved_source_id).toBe(
      "src-row-001-0000-0000-0000-000000000001"
    );
  });

  it("claim not matching any source has resolved_source_id = null", () => {
    const claim = makeClaimRecord({ claim_text: "unknown claim xyz" });
    const result = verifyAndDecide({
      body: { content_type: "answer_block", text: "unknown claim xyz", length_units: 3, numeric_claim_ids: [], source_ids: [] },
      language: "en",
      claims: [claim],
      sources: [],
    });
    expect(result.claims[0]?.resolved_source_id).toBeNull();
    expect(result.decision).toBe("needs_human");
  });
});

// ---------------------------------------------------------------------------
// verifyAndDecide — numeric bound checking (block vs pass vs needs_human)
// ---------------------------------------------------------------------------

describe("verifyAndDecide — numeric bound: over-bound → block", () => {
  it("60% claim vs public_url source 'up to 50%' → block", () => {
    const claim = makeClaimRecord({
      claim_text: "60% faster",
      numeric: { value: 60, unit: "%", bound: "exact" },
      span: { start: 0, end: 10 },
    });
    const source = makeSourceRow({
      claim_text: "60% faster",
      numeric_value: "50",
      numeric_unit: "%",
      numeric_bound: "upTo",
    });

    const result = verifyAndDecide({
      body: { content_type: "answer_block", text: "60% faster than others", length_units: 4, numeric_claim_ids: [claim.claim_id], source_ids: [] },
      language: "en",
      claims: [claim],
      sources: [source],
    });

    expect(result.decision).toBe("block");
    expect(result.claims[0]?.verification).toBe("rejected");
    expect(result.claims[0]?.resolved_source_id).toBe(source.id);
  });

  it("30% claim vs unsigned customer_attested source 'up to 50%' → needs_human (not auto-pass)", () => {
    // This is the key spec case: "30% vs attested 'up to 50%' → not auto-pass"
    // because the source is customer_attested and unsigned (verified_by = null)
    const claim = makeClaimRecord({
      claim_text: "30% improvement",
      numeric: { value: 30, unit: "%", bound: "exact" },
      span: { start: 0, end: 16 },
    });
    const source = makeSourceRow({
      claim_text: "30% improvement",
      numeric_value: "50",
      numeric_unit: "%",
      numeric_bound: "upTo",
      source_kind: "customer_attested",
      verified_by: null,   // NOT YET SIGNED
      verified_at: null,
    });

    const result = verifyAndDecide({
      body: { content_type: "answer_block", text: "30% improvement in performance", length_units: 4, numeric_claim_ids: [claim.claim_id], source_ids: [] },
      language: "en",
      claims: [claim],
      sources: [source],
    });

    // 30 ≤ 50 so bound is within, BUT source is unsigned → needs_human (not pass, not block)
    expect(result.decision).toBe("needs_human");
    expect(result.claims[0]?.verification).toBe("needs_human");
    // resolved_source_id is set (we did find and match the source)
    expect(result.claims[0]?.resolved_source_id).toBe(source.id);
  });

  it("30% claim vs signed public_url source 'up to 50%' → pass", () => {
    const claim = makeClaimRecord({
      claim_text: "30% faster",
      numeric: { value: 30, unit: "%", bound: "exact" },
      span: { start: 0, end: 10 },
    });
    const source = makeSourceRow({
      claim_text: "30% faster",
      numeric_value: "50",
      numeric_unit: "%",
      numeric_bound: "upTo",
      source_kind: "public_url",
      verified_by: "human@example.com",
    });

    const result = verifyAndDecide({
      // body text without superlatives / extra numbers to avoid backstop noise
      body: { content_type: "answer_block", text: "30% faster than rivals per lab test", length_units: 7, numeric_claim_ids: [claim.claim_id], source_ids: [] },
      language: "en",
      claims: [claim],
      sources: [source],
    });

    expect(result.decision).toBe("pass");
    expect(result.claims[0]?.verification).toBe("verified");
    expect(result.claims[0]?.resolved_source_id).toBe(source.id);
  });
});

// ---------------------------------------------------------------------------
// verifyAndDecide — superlative with no source never auto-passes
// ---------------------------------------------------------------------------

describe("verifyAndDecide — superlative with no source", () => {
  it("superlative claim with no matching source row → needs_human (never pass)", () => {
    const claim: ClaimRecord = {
      claim_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      claim_text: "best AI chat platform",
      claim_kind: "superlative",
      span: { start: 0, end: 22 },
      resolved_source_id: null,
      verification: "unverified",
    };

    const result = verifyAndDecide({
      body: { content_type: "definition", text: "best AI chat platform for teams", meaning_key: "brand-def" },
      language: "en",
      claims: [claim],
      sources: [], // No source rows at all
    });

    expect(result.decision).toBe("needs_human");
    expect(result.decision).not.toBe("pass");
    expect(result.claims[0]?.resolved_source_id).toBeNull();
    expect(result.claims[0]?.verification).toBe("needs_human");
  });

  it("comparative claim with no source row → needs_human", () => {
    const claim: ClaimRecord = {
      claim_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      claim_text: "faster than Character.AI",
      claim_kind: "comparative",
      span: { start: 0, end: 24 },
      resolved_source_id: null,
      verification: "unverified",
    };

    const result = verifyAndDecide({
      body: { content_type: "answer_block", text: "faster than Character.AI in response time", length_units: 7, numeric_claim_ids: [], source_ids: [] },
      language: "en",
      claims: [claim],
      sources: [],
    });

    expect(result.decision).toBe("needs_human");
    expect(result.claims[0]?.verification).toBe("needs_human");
  });
});

// ---------------------------------------------------------------------------
// verifyAndDecide — multiple claims, block takes precedence
// ---------------------------------------------------------------------------

describe("verifyAndDecide — precedence: block > needs_human > pass", () => {
  it("one blocking claim + one needs_human claim → terminal is block", () => {
    const blockingClaim: ClaimRecord = {
      claim_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      claim_text: "99% accuracy",
      claim_kind: "numeric",
      numeric: { value: 99, unit: "%", bound: "exact" },
      span: { start: 0, end: 12 },
      resolved_source_id: null,
      verification: "unverified",
    };
    const nhClaim: ClaimRecord = {
      claim_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      claim_text: "best in class solution",
      claim_kind: "superlative",
      span: { start: 13, end: 35 },
      resolved_source_id: null,
      verification: "unverified",
    };

    const blockSource = makeSourceRow({
      id: "src-block-0000-0000-0000-000000000002",
      claim_text: "99% accuracy",
      numeric_value: "80",
      numeric_unit: "%",
      numeric_bound: "upTo",
      source_kind: "public_url",
      verified_by: "h@e.com",
    });

    const result = verifyAndDecide({
      body: { content_type: "answer_block", text: "99% accuracy best in class solution here", length_units: 7, numeric_claim_ids: [blockingClaim.claim_id], source_ids: [] },
      language: "en",
      claims: [blockingClaim, nhClaim],
      sources: [blockSource],
    });

    expect(result.decision).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// verifyAndDecide — pure / deterministic (no external calls)
// ---------------------------------------------------------------------------

describe("verifyAndDecide — pure deterministic, no LLM", () => {
  it("same inputs always produce the same output", () => {
    const claim = makeClaimRecord({
      numeric: { value: 30, unit: "%", bound: "exact" },
    });
    const source = makeSourceRow({
      numeric_value: "30",
      numeric_bound: "exact",
    });
    const opts = {
      body: { content_type: "answer_block" as const, text: "30% faster than competitors in tests", length_units: 6, numeric_claim_ids: [claim.claim_id], source_ids: [] },
      language: "en",
      claims: [claim],
      sources: [source],
    };

    const result1 = verifyAndDecide(opts);
    const result2 = verifyAndDecide(opts);

    expect(result1.decision).toBe(result2.decision);
    expect(result1.claims[0]?.resolved_source_id).toBe(
      result2.claims[0]?.resolved_source_id
    );
    expect(result1.claims[0]?.verification).toBe(
      result2.claims[0]?.verification
    );
  });
});
