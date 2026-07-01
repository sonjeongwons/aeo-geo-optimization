/**
 * test/claimVerify-failclosed.test.ts
 *
 * T10 acceptance criteria — fail-closed behaviour:
 *
 * 1. Empty/failed extraction with a backstop-detected numeric → needs_human (fail closed).
 * 2. Extraction failed (ok:false) + backstop found spans → needs_human, never pass.
 * 3. Zero claims + zero backstop flags → trivially pass.
 * 4. Zero claims + backstop found spans (extractor returned empty, not failed) → needs_human.
 * 5. Korean superlatives flagged by backstop with no claims → needs_human.
 */

import { describe, it, expect } from "vitest";
import { verifyAndDecide } from "../src/content/claimVerify.js";
import type { ClaimRecord, ClaimSourceRow } from "../src/content/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_SOURCES: ClaimSourceRow[] = [];
const EMPTY_CLAIMS: ClaimRecord[] = [];
const NOW = new Date("2025-01-01T00:00:00Z");

// ---------------------------------------------------------------------------
// Fail-closed: extraction failed + backstop found spans
// ---------------------------------------------------------------------------

describe("verifyAndDecide — fail closed on extraction failure + backstop hits", () => {
  it("extractionFailed=true + body with numeric → needs_human (never pass)", () => {
    const result = verifyAndDecide({
      body: {
        content_type: "answer_block",
        text: "We achieve 99% customer satisfaction in our platform",
        length_units: 9,
        numeric_claim_ids: [],
        source_ids: [],
      },
      language: "en",
      claims: EMPTY_CLAIMS,   // extraction returned nothing (failed)
      sources: EMPTY_SOURCES,
      extractionFailed: true,  // claimExtract returned ok:false
    });

    expect(result.decision).toBe("needs_human");
    expect(result.decision).not.toBe("pass");
    // backstop should have found "99" numeric
    expect(result.backstopHits.length).toBeGreaterThan(0);
  });

  it("extractionFailed=true + body with superlative → needs_human (fail closed)", () => {
    const result = verifyAndDecide({
      body: {
        content_type: "definition",
        text: "The best AI platform for enterprise teams",
        meaning_key: "brand-def",
      },
      language: "en",
      claims: EMPTY_CLAIMS,
      sources: EMPTY_SOURCES,
      extractionFailed: true,
    });

    expect(result.decision).toBe("needs_human");
    // backstop should have detected "best"
    const superlativeHits = result.backstopHits.filter(
      (h) => h.kind === "superlative"
    );
    expect(superlativeHits.length).toBeGreaterThan(0);
  });

  it("extractionFailed=true + body with NO numeric/superlative → pass (nothing found)", () => {
    // If backstop finds nothing, fail-closed doesn't trigger (nothing to gate)
    const result = verifyAndDecide({
      body: {
        content_type: "answer_block",
        text: "A chat platform for creative writing and roleplay with characters",
        length_units: 12,
        numeric_claim_ids: [],
        source_ids: [],
      },
      language: "en",
      claims: EMPTY_CLAIMS,
      sources: EMPTY_SOURCES,
      extractionFailed: true,
    });

    // Backstop found nothing, so extraction failure alone (with empty body) → pass
    // (no spans to gate = nothing to fail closed on)
    expect(result.decision).toBe("pass");
    expect(result.backstopHits.filter((h) => !h.coveredByExtraction)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: zero claims + backstop found spans (extractor returned empty)
// ---------------------------------------------------------------------------

describe("verifyAndDecide — zero claims but backstop found spans", () => {
  it("no claims + numeric in body (extraction returned []) → needs_human", () => {
    const result = verifyAndDecide({
      body: {
        content_type: "answer_block",
        text: "Up to 50% off all plans this month",
        length_units: 7,
        numeric_claim_ids: [],
        source_ids: [],
      },
      language: "en",
      claims: EMPTY_CLAIMS,   // extractor found nothing (returned empty, not failed)
      sources: EMPTY_SOURCES,
      extractionFailed: false, // extractor succeeded but returned []
    });

    expect(result.decision).toBe("needs_human");
    expect(result.backstopHits.some((h) => h.kind === "numeric")).toBe(true);
  });

  it("no claims + superlative in body (extraction returned []) → needs_human", () => {
    const result = verifyAndDecide({
      body: {
        content_type: "definition",
        text: "The leading platform for AI character creation",
        meaning_key: "key-1",
      },
      language: "en",
      claims: EMPTY_CLAIMS,
      sources: EMPTY_SOURCES,
      extractionFailed: false,
    });

    expect(result.decision).toBe("needs_human");
    expect(result.backstopHits.some((h) => h.kind === "superlative")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Trivial pass: no claims, no backstop flags
// ---------------------------------------------------------------------------

describe("verifyAndDecide — trivial pass when nothing to gate", () => {
  it("no claims + body with no numeric or superlative → pass", () => {
    const result = verifyAndDecide({
      body: {
        content_type: "answer_block",
        text: "An AI character chat app where you create and interact with characters in multiple languages",
        length_units: 15,
        numeric_claim_ids: [],
        source_ids: [],
      },
      language: "en",
      claims: EMPTY_CLAIMS,
      sources: EMPTY_SOURCES,
    });

    expect(result.decision).toBe("pass");
    expect(result.backstopHits.filter((h) => !h.coveredByExtraction)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Korean superlatives in backstop
// ---------------------------------------------------------------------------

describe("verifyAndDecide — Korean superlatives in backstop", () => {
  it("Korean superlative '최고' in body with no claims → needs_human", () => {
    const result = verifyAndDecide({
      body: {
        content_type: "definition",
        text: "최고의 AI 캐릭터 채팅 플랫폼",
        meaning_key: "ko-def-1",
      },
      language: "ko",
      claims: EMPTY_CLAIMS,
      sources: EMPTY_SOURCES,
    });

    expect(result.decision).toBe("needs_human");
    const koSuperlativeHits = result.backstopHits.filter(
      (h) => h.kind === "superlative" && h.text.includes("최고")
    );
    expect(koSuperlativeHits.length).toBeGreaterThan(0);
  });

  it("Korean superlative '1위' in body with no claims → needs_human", () => {
    const result = verifyAndDecide({
      body: {
        content_type: "answer_block",
        text: "AI 채팅 앱 중 1위로 선정된 EMORA",
        length_units: 10,
        numeric_claim_ids: [],
        source_ids: [],
      },
      language: "ko",
      claims: EMPTY_CLAIMS,
      sources: EMPTY_SOURCES,
    });

    expect(result.decision).toBe("needs_human");
  });
});

// ---------------------------------------------------------------------------
// Backstop: uncovered spans route to needs_human even when some claims pass
// ---------------------------------------------------------------------------

describe("verifyAndDecide — uncovered backstop spans override partial pass", () => {
  it("one verified claim + one uncovered backstop numeric → needs_human", () => {
    // The claim covers its span, but there's another numeric in the body
    // that has NO corresponding extracted claim — backstop catches it.
    const claim: ClaimRecord = {
      claim_id: "f0000000-0000-0000-0000-000000000001",
      claim_text: "30% faster",
      claim_kind: "numeric",
      numeric: { value: 30, unit: "%", bound: "exact" },
      span: { start: 0, end: 10 },
      resolved_source_id: null,
      verification: "unverified",
    };

    const source: ClaimSourceRow = {
      id: "src-f0000000-0000-0000-0000-000000000002",
      customer_id: "cust-0000-0000-0000-0000-000000000001",
      claim_text: "30% faster",
      claim_kind: "numeric",
      numeric_value: "30",
      numeric_unit: "%",
      numeric_bound: "exact",
      source_kind: "public_url",
      source_ref: "https://lab.example.com/test",
      verified_by: "analyst@example.com",
      verified_at: NOW,
      created_at: NOW,
    };

    // Body has "30%" (covered by claim) AND "99%" (NOT covered by any claim)
    const result = verifyAndDecide({
      body: {
        content_type: "answer_block",
        // "30% faster" is at offset 0-10, "99%" is uncovered extra numeric
        text: "30% faster than rivals. Also 99% uptime guaranteed.",
        length_units: 9,
        numeric_claim_ids: [claim.claim_id],
        source_ids: [source.id],
      },
      language: "en",
      claims: [claim],
      sources: [source],
    });

    // 30% claim resolves and passes, but "99%" is uncovered by any claim
    // so backstop forces needs_human
    expect(result.decision).toBe("needs_human");

    const uncovered = result.backstopHits.filter((h) => !h.coveredByExtraction);
    expect(uncovered.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// No LLM: verifyAndDecide is synchronous and pure
// ---------------------------------------------------------------------------

describe("verifyAndDecide — synchronous / no async (pure)", () => {
  it("returns synchronously — not a Promise", () => {
    const result = verifyAndDecide({
      body: { content_type: "definition", text: "A creative AI platform", meaning_key: "def-1" },
      language: "en",
      claims: [],
      sources: [],
    });
    // If it were async, result would be a Promise — check it's a plain object
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.decision).toBe("string");
  });
});
