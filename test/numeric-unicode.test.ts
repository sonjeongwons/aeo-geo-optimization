/**
 * test/numeric-unicode.test.ts
 *
 * GB-01 / GB-02 / GB-03 / GB-04 acceptance tests.
 *
 * Mandated by the Phase 2 audit:
 *
 * GB-01: Script-aware numeric detector catches fullwidth, CJK, Arabic-Indic,
 *        Devanagari, and number-words that the old ASCII-only regex missed.
 *
 * GB-02: verifiableNumbersGate blocks a ja/zh asset whose body contains a
 *        fullwidth or CJK numeric token ('５０％', '五〇％') with no resolved
 *        claim, independently of AnswerBlock.numeric_claim_ids.
 *
 * GB-03: jsonLdShapeGate no longer has the `|| length<=2` escape — tokens like
 *        '9%', '5x', '#1' are blocked.
 *
 * GB-04: A wrong-unit source does NOT clear a numeric claim;
 *        unit compatibility is required before binding.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { scanNumerics, scanBodyForNumerics } from "../src/content/numericDetect.js";
import { verifiableNumbersGate } from "../src/content/gates/verifiableNumbers.js";
import { jsonLdShapeGate } from "../src/content/gates/jsonLdShape.js";
import { verifyAndDecide, checkNumericBound } from "../src/content/claimVerify.js";
import type {
  ContentAsset,
  ContentGateContext,
  ClaimRecord,
  ClaimSourceRow,
} from "../src/content/types.js";

// ---------------------------------------------------------------------------
// Fixtures
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
    language: "ja",
    phrasing_group_id: "pg-1",
    body: {
      content_type: "answer_block",
      text: "",
      length_units: 5,
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

function makeCtx(asset: ContentAsset): ContentGateContext {
  return {
    asset,
    siblings: [],
    brandAliases: ["EMORA"],
    claimSources: [],
  };
}

function makeClaimRecord(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    claim_id: randomUUID(),
    claim_text: "50% faster",
    claim_kind: "numeric",
    numeric: { value: 50, unit: "%", bound: "upTo" },
    span: { start: 0, end: 10 },
    resolved_source_id: null,
    verification: "unverified",
    ...overrides,
  };
}

function makeSourceRow(overrides: Partial<ClaimSourceRow> = {}): ClaimSourceRow {
  return {
    id: randomUUID(),
    customer_id: "cust-1",
    claim_text: "50% faster",
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
// GB-01: Script-aware numeric detector
// ---------------------------------------------------------------------------

describe("GB-01 — scanNumerics: script-aware Unicode detection", () => {
  it("detects fullwidth digit '５０' in Japanese text", () => {
    const hits = scanNumerics("エモラは５０の言語に対応します。", "ja");
    expect(hits.length).toBeGreaterThan(0);
    // "５０" gets NFKC-normalized to "50" and detected as a digit hit
    const texts = hits.map((h) => h.text);
    // The original text slice should be fullwidth or the normalized version
    expect(texts.some((t) => t.includes("５０") || t.includes("50"))).toBe(true);
  });

  it("detects CJK numeral run '五〇' (not in \\p{Nd}, not fullwidth)", () => {
    const hits = scanNumerics("五〇パーセントの削減を実現しました。", "ja");
    expect(hits.length).toBeGreaterThan(0);
    const texts = hits.map((h) => h.text);
    // CJK numerals caught by CJK_NUMERAL_REGEX
    expect(texts.some((t) => t.includes("五") || t.includes("〇"))).toBe(true);
  });

  it("detects fullwidth '５０％' in Chinese text", () => {
    const hits = scanNumerics("效率提升了５０％。", "zh");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("detects Arabic-Indic digit '٥٠' (U+0660 range, Nd class)", () => {
    // Arabic-Indic digits survive NFKC (they remain Nd, mapped to ASCII by NFKC)
    const hits = scanNumerics("تحسن بنسبة ٥٠ بالمئة", "ar");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("detects English number-word 'fifty' in sentence", () => {
    const hits = scanNumerics("We achieved a fifty percent improvement.", "en");
    expect(hits.length).toBeGreaterThan(0);
    const texts = hits.map((h) => h.text);
    // "fifty" is in the number-word lexicon; "percent" too
    expect(texts.some((t) => /fifty|percent/i.test(t))).toBe(true);
  });

  it("detects 'threefold' as a number-word in English", () => {
    const hits = scanNumerics("We saw a threefold increase in engagement.", "en");
    expect(hits.length).toBeGreaterThan(0);
    const texts = hits.map((h) => h.text);
    expect(texts.some((t) => t === "threefold")).toBe(true);
  });

  it("returns empty for a body with no numeric content", () => {
    const hits = scanNumerics(
      "EMORA is an AI character chat platform for creative storytelling.",
      "en"
    );
    // No digits, no CJK numerals, no number-words
    expect(hits).toHaveLength(0);
  });

  it("NFKC-normalizes fullwidth ５０ to ASCII 50 before matching", () => {
    // scanBodyForNumerics is the simplified wrapper
    const hits = scanBodyForNumerics("エモラは５０言語に対応。", "ja");
    expect(hits.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GB-02: verifiableNumbersGate blocks ja/zh fullwidth and CJK numerics
//        with no resolved claims (independent of numeric_claim_ids)
// ---------------------------------------------------------------------------

describe("GB-02 — verifiableNumbersGate: blocks non-ASCII numeric tokens with empty claims", () => {
  it("BLOCKS Japanese asset with fullwidth '５０％' and no resolved claims", () => {
    // Body text: "エモラは５０％高速化しています" (EMORA is 50% faster)
    const asset = makeAsset({
      language: "ja",
      body: {
        content_type: "answer_block",
        text: "エモラは５０％高速化しています。",
        length_units: 10,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("§7#2");
  });

  it("BLOCKS Chinese asset with CJK numeral '五〇％' and no resolved claims", () => {
    const asset = makeAsset({
      language: "zh",
      body: {
        content_type: "answer_block",
        text: "效率提升了五〇百分之，无与伦比。",
        length_units: 8,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("§7#2");
  });

  it("BLOCKS Japanese definition with CJK numeral '十四' and empty claims", () => {
    const asset = makeAsset({
      language: "ja",
      content_type: "definition",
      format: "definition_sentence",
      body: {
        content_type: "definition",
        text: "エモラは十四の言語に対応するAIキャラクターチャットプラットフォームです。",
        meaning_key: "emora-ja-def",
      },
      claims: [],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("§7#2");
  });

  it("PASSES Japanese asset when the fullwidth numeric has a resolved numeric claim covering its span", () => {
    // "エモラは５０％高速化しています。"
    // "５０" is at position 4, "%" (fullwidth ％ → %) so after NFKC it's "50%"
    // The scanner normalizes in shadow so hits at the same offset.
    // We need a resolved claim whose span covers the numeric hit.
    const bodyText = "エモラは５０％高速化しています。";
    const claimId = randomUUID();
    const resolvedClaim = makeClaimRecord({
      claim_id: claimId,
      claim_text: "５０％高速化",
      claim_kind: "numeric",
      numeric: { value: 50, unit: "%", bound: "upTo" },
      // "５０" starts at char index 4 in the original string; "％" at 6; span [4, 7)
      span: { start: 4, end: 7 },
      resolved_source_id: randomUUID(), // RESOLVED
      verification: "verified",
    });

    const asset = makeAsset({
      language: "ja",
      body: {
        content_type: "answer_block",
        text: bodyText,
        length_units: 10,
        numeric_claim_ids: [claimId],
        source_ids: [],
      },
      claims: [resolvedClaim],
    });

    const result = verifiableNumbersGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// GB-03: jsonLdShapeGate no longer has length<=2 escape
// ---------------------------------------------------------------------------

describe("GB-03 — jsonLdShapeGate: short numeric tokens '9%', '5x', '#1' are blocked", () => {
  it("BLOCKS Article JSON-LD with '9%' in articleBody (no resolved claim)", () => {
    const asset: ContentAsset = {
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
          headline: "EMORA Platform Overview",
          // "9%" is a bare numeric claim — no resolved source → should block
          articleBody: "Only 9% of users experience any friction during onboarding.",
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
    };

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("9");
    expect(result.reason).toContain("§7#2");
  });

  it("BLOCKS Article JSON-LD with '5x' in articleBody (no resolved claim)", () => {
    const asset: ContentAsset = {
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
      phrasing_group_id: "pg-jsonld-2",
      body: {
        content_type: "jsonld",
        schema_type: "Article",
        json: {
          "@context": "https://schema.org",
          "@type": "Article",
          headline: "EMORA Platform Overview",
          articleBody: "EMORA delivers 5x better engagement than competitors.",
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
    };

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("§7#2");
  });

  it("BLOCKS Organization JSON-LD with '99' in description (no resolved claim)", () => {
    const asset: ContentAsset = {
      id: randomUUID(),
      customer_id: null,
      industry: "tech",
      template_id: randomUUID(),
      template_version: 1,
      content_set_id: randomUUID(),
      content_type: "jsonld",
      format: "jsonld_org",
      channel_class: "owned_net",
      language: "en",
      phrasing_group_id: "pg-jsonld-3",
      body: {
        content_type: "jsonld",
        schema_type: "Organization",
        json: {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "EMORA",
          url: { deferred: true, role: "owned_hub" as const },
          description: "We have 99 active enterprise customers using our platform.",
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
    };

    const result = jsonLdShapeGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("§7#2");
  });
});

// ---------------------------------------------------------------------------
// GB-04: Wrong-unit source does NOT clear a numeric claim
// ---------------------------------------------------------------------------

describe("GB-04 — claimVerify: wrong-unit source does not clear numeric claim", () => {
  it("a percentage-unit claim is NOT bound to a multiplier-unit source", () => {
    // Claim: "50% faster onboarding"   (unit: "%")
    // Source: "50x more efficient"      (unit: "x") — same keyword overlap, different metric
    const claim = makeClaimRecord({
      claim_text: "50% faster onboarding",
      claim_kind: "numeric",
      numeric: { value: 50, unit: "%", bound: "upTo" },
      span: { start: 0, end: 21 },
    });

    // Wrong-unit source: overlapping keywords ("50", "faster", "onboarding")
    // but unit is "x" (multiplier), not "%" (percentage).
    const wrongUnitSource = makeSourceRow({
      claim_text: "50 times faster onboarding",
      claim_kind: "numeric",
      numeric_value: "50",
      numeric_unit: "x",        // WRONG unit — multiplier, not percentage
      numeric_bound: "upTo",
      source_kind: "public_url",
      verified_by: "analyst@example.com",
    });

    const result = verifyAndDecide({
      body: {
        content_type: "answer_block",
        text: "50% faster onboarding guaranteed.",
        length_units: 4,
        numeric_claim_ids: [claim.claim_id],
        source_ids: [],
      },
      language: "en",
      claims: [claim],
      sources: [wrongUnitSource],
    });

    // The wrong-unit source must NOT bind the claim.
    // Claim has no valid source → needs_human (not pass, not block)
    expect(result.decision).toBe("needs_human");
    expect(result.claims[0]?.resolved_source_id).toBeNull();
    expect(result.claims[0]?.verification).toBe("needs_human");
  });

  it("unit-compatible source clears the same claim", () => {
    // Same claim, but now the source has the matching "%" unit.
    const claim = makeClaimRecord({
      claim_text: "50% faster onboarding",
      claim_kind: "numeric",
      numeric: { value: 50, unit: "%", bound: "upTo" },
      span: { start: 0, end: 21 },
    });

    const correctUnitSource = makeSourceRow({
      claim_text: "50% faster onboarding",
      claim_kind: "numeric",
      numeric_value: "60",
      numeric_unit: "%",         // CORRECT unit
      numeric_bound: "upTo",
      source_kind: "public_url",
      verified_by: "analyst@example.com",
    });

    const result = verifyAndDecide({
      body: {
        content_type: "answer_block",
        text: "50% faster onboarding guaranteed.",
        length_units: 4,
        numeric_claim_ids: [claim.claim_id],
        source_ids: [],
      },
      language: "en",
      claims: [claim],
      sources: [correctUnitSource],
    });

    // 50% ≤ 60% (upTo) → within bound → verified
    expect(result.decision).toBe("pass");
    expect(result.claims[0]?.resolved_source_id).toBe(correctUnitSource.id);
    expect(result.claims[0]?.verification).toBe("verified");
  });

  it("wrong-unit source does NOT clear even when all other keywords match exactly", () => {
    // Extreme case: claim text is identical to source text except unit.
    // "50% price discount" vs source "50x price discount" — same words, different unit.
    const claim = makeClaimRecord({
      claim_text: "up to 50% price discount",
      claim_kind: "numeric",
      numeric: { value: 50, unit: "%", bound: "upTo" },
      span: { start: 0, end: 24 },
    });

    const wrongUnitSource = makeSourceRow({
      claim_text: "up to 50x price discount",
      claim_kind: "numeric",
      numeric_value: "50",
      numeric_unit: "x",  // multiplier — different metric entirely
      numeric_bound: "upTo",
      source_kind: "public_url",
      verified_by: "analyst@example.com",
    });

    const result = verifyAndDecide({
      body: {
        content_type: "answer_block",
        text: "Get up to 50% price discount this quarter.",
        length_units: 7,
        numeric_claim_ids: [claim.claim_id],
        source_ids: [],
      },
      language: "en",
      claims: [claim],
      sources: [wrongUnitSource],
    });

    // Unit incompatibility must prevent binding
    expect(result.claims[0]?.resolved_source_id).toBeNull();
    expect(result.decision).toBe("needs_human");
  });

  it("checkNumericBound: incompatible units always return incompatible", () => {
    // Direct unit-compatibility test via checkNumericBound
    expect(checkNumericBound(50, "%", 50, "x", "upTo")).toBe("incompatible");
    expect(checkNumericBound(50, "x", 50, "%", "upTo")).toBe("incompatible");
    expect(checkNumericBound(50, "%", 50, "ms", "exact")).toBe("incompatible");
    expect(checkNumericBound(50, "ms", 100, "ms", "upTo")).toBe("within");
  });
});
