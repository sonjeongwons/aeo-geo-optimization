/**
 * test/claimVerify-subset-match.test.ts
 *
 * Locks the §7-safe claim⊆source matching direction added for comparison cells:
 * a SHORT paraphrased capability/comparative claim binds to a verified source
 * when >= 2/3 of the CLAIM's significant words appear in that (longer) source —
 * BUT a fabricated capability still binds to nothing (so §7 is not weakened).
 */
import { describe, it, expect } from "vitest";
import { verifyAndDecide } from "../src/content/claimVerify.js";
import type { ClaimRecord, ClaimSourceRow } from "../src/content/types.js";

function source(text: string, kind: ClaimSourceRow["claim_kind"] = "comparative"): ClaimSourceRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    customer_id: "22222222-2222-2222-2222-222222222222",
    claim_text: text,
    claim_kind: kind,
    numeric_value: null,
    numeric_unit: null,
    numeric_bound: null,
    source_kind: "public_url",
    source_ref: "https://example.com/source",
    verified_by: "owner@example.com",
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

// The body just needs to contain the claim text so the backstop correlates it.
const body = (text: string) => ({
  content_type: "answer_block" as const,
  text,
  length_units: 12,
  numeric_claim_ids: [] as string[],
  source_ids: [] as string[],
});

describe("claimVerify claim⊆source matching (§7-safe recall)", () => {
  it("a short paraphrase whose words are mostly in a verified source RESOLVES (passes)", () => {
    // Source is verbose; claim is a terse subset paraphrase.
    const src = source(
      "Talkie AI: a revenue-sharing program exists for content creators who publish characters on the platform",
    );
    const text = "revenue sharing program for content creators";
    const result = verifyAndDecide({
      body: body(text),
      language: "en",
      claims: [capabilityClaim(text)],
      sources: [src],
    });
    expect(result.decision).toBe("pass");
    // The claim resolved against the verified source.
    expect(result.claims[0]?.resolved_source_id).toBe(src.id);
  });

  it("a FABRICATED capability with no source overlap is NOT bound (needs_human)", () => {
    const src = source(
      "Talkie AI: a revenue-sharing program exists for content creators who publish characters",
    );
    const text = "guaranteed military grade quantum encryption for all messages";
    const result = verifyAndDecide({
      body: body(text),
      language: "en",
      claims: [capabilityClaim(text)],
      sources: [src],
    });
    expect(result.decision).toBe("needs_human");
    expect(result.claims[0]?.resolved_source_id).toBeNull();
  });

  it("a POLARITY-INVERTED claim does NOT bind to an affirmative source (v4 §7 fix)", () => {
    const src = source("EMORA supports group chat with multiple AI characters");
    const text = "EMORA does not support group chat with multiple characters";
    const result = verifyAndDecide({ body: body(text), language: "en", claims: [capabilityClaim(text)], sources: [src] });
    expect(result.claims[0]?.resolved_source_id).toBeNull();
    expect(result.decision).toBe("needs_human");
  });

  it("a SAME-polarity negated claim still binds (no false suppression)", () => {
    // Both negated ("no") AND ≥2/3 word overlap → polarity agrees, match holds.
    const src = source("EMORA requires no setup and no credit card to start");
    const text = "EMORA requires no setup no credit card";
    const result = verifyAndDecide({ body: body(text), language: "en", claims: [capabilityClaim(text)], sources: [src] });
    expect(result.claims[0]?.resolved_source_id).toBe(src.id);
  });

  it("W1.10: a capability claim sharing ONLY a generic noun with an unrelated source does NOT bind", () => {
    // Both mention "feature"/"platform" (generic) but describe DIFFERENT
    // capabilities — must not false-verify.
    const src = source("in-chat image generation feature for the platform");
    const text = "unlimited memory retention feature";
    const result = verifyAndDecide({
      body: body(text),
      language: "en",
      claims: [capabilityClaim(text)],
      sources: [src],
    });
    expect(result.claims[0]?.resolved_source_id).toBeNull();
    expect(result.decision).toBe("needs_human");
  });

  it("W1.10: a capability claim sharing DISTINCTIVE words still binds", () => {
    const src = source("the platform offers unlimited memory retention across sessions");
    const text = "unlimited memory retention feature";
    const result = verifyAndDecide({
      body: body(text),
      language: "en",
      claims: [capabilityClaim(text)],
      sources: [src],
    });
    expect(result.claims[0]?.resolved_source_id).toBe(src.id);
  });

  it("prefers a SIGNED source over an UNSIGNED duplicate on an exact-match tie", () => {
    // Mirrors the real sharejoa bug: seedClaimSourcesFromBrief auto-creates an
    // UNSIGNED duplicate (customer_attested, verified_by=null) from a brief
    // attribute, alongside a properly ingested+signed fact covering the exact
    // same claim text. Plain lexical scoring ties (both exact-match, score 3);
    // without a signed-first preference, iteration/sort order could pick
    // either — including the unsigned one, which then permanently blocks the
    // claim ("not yet signed off") even though a verified equivalent exists.
    const unsignedDuplicate: ClaimSourceRow = {
      ...source("4K 화질 지원", "capability"),
      id: "44444444-4444-4444-4444-444444444444",
      source_kind: "customer_attested",
      verified_by: null,
      verified_at: null,
    };
    const signed: ClaimSourceRow = {
      ...source("4K 화질 지원", "capability"),
      id: "55555555-5555-5555-5555-555555555555",
      source_kind: "customer_attested",
    };
    const text = "4K 화질 지원";
    const result = verifyAndDecide({
      body: body(text),
      language: "ko",
      claims: [capabilityClaim(text)],
      sources: [unsignedDuplicate, signed],
    });
    expect(result.claims[0]?.resolved_source_id).toBe(signed.id);
    expect(result.decision).toBe("pass");
  });

  it("falls back to an UNSIGNED source when no signed source matches (existing needs_human path unchanged)", () => {
    const unsigned: ClaimSourceRow = {
      ...source("4K 화질 지원", "capability"),
      source_kind: "customer_attested",
      verified_by: null,
      verified_at: null,
    };
    const text = "4K 화질 지원";
    const result = verifyAndDecide({
      body: body(text),
      language: "ko",
      claims: [capabilityClaim(text)],
      sources: [unsigned],
    });
    // Resolves to the unsigned source (so the "not yet signed off" reason can
    // surface) but does NOT pass — an unsigned source is not yet trustworthy.
    expect(result.claims[0]?.resolved_source_id).toBe(unsigned.id);
    expect(result.decision).not.toBe("pass");
  });

  it("a short claim (<4 significant words) sharing NON-contiguous words does NOT loose-match", () => {
    const src = source("EMORA offers a creator economy for monetizing AI characters and content");
    // 3 significant words, all present in the source but NOT a contiguous substring
    // → contains-match can't fire, and the subset rule requires >= 4 claim words.
    const text = "monetizing economy characters";
    const result = verifyAndDecide({
      body: body(text),
      language: "en",
      claims: [capabilityClaim(text)],
      sources: [src],
    });
    expect(result.claims[0]?.resolved_source_id).toBeNull();
  });
});
