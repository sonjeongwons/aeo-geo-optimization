/**
 * test/noFakeSignals.test.ts
 *
 * T11 acceptance criteria for noFakeSignalsGate:
 *
 * 1. BLOCKS fake review-count scaffolding (e.g. "5,000 reviews").
 * 2. BLOCKS testimonial scaffolding (e.g. "customers say").
 * 3. PASSES clean content with no fake-signal patterns.
 * 4. PASSES when a community/review engagement metric has a resolved claim source.
 * 5. Gate has correct name/phase.
 *
 * Structural note: the community/review channel_class enum exclusion is tested
 * by the type system (TypeScript compilation), not at runtime — channel_class
 * 'community' and 'review' are not in the ChannelClass union, so no asset can
 * be created with those values. The noFakeSignalsGate adds a belt-and-suspenders
 * text scan on top of this structural exclusion.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { noFakeSignalsGate } from "../src/content/gates/noFakeSignals.js";
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
      text: "EMORA supports 14 languages for character chat.",
      length_units: 7,
      numeric_claim_ids: [],
      source_ids: [],
    },
    claims: [],
    word_count: 7,
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
// 1. Blocks fake review/rating scaffolding
// ---------------------------------------------------------------------------

describe("noFakeSignalsGate — review/rating count patterns", () => {
  it("BLOCKS '5,000 reviews' without a resolved source", () => {
    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "EMORA has received over 5,000 reviews from satisfied users across all platforms.",
        length_units: 14,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = noFakeSignalsGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("fake-signal");
  });

  it("BLOCKS '4.8 stars' rating scaffold without a resolved source", () => {
    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "EMORA maintains a 4.8 stars rating across all app stores globally.",
        length_units: 11,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = noFakeSignalsGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("fake-signal");
  });

  it("BLOCKS '10K ratings' scaffold without a resolved source", () => {
    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "EMORA has 10K ratings on the App Store and Play Store combined.",
        length_units: 12,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = noFakeSignalsGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// 2. Blocks testimonial scaffolding
// ---------------------------------------------------------------------------

describe("noFakeSignalsGate — testimonial scaffolding", () => {
  it("BLOCKS 'customers say' scaffold without a resolved source", () => {
    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "EMORA delivers a unique experience that customers say is unmatched in the AI chat space.",
        length_units: 16,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = noFakeSignalsGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
  });

  it("BLOCKS 'loved by users' scaffold without a resolved source", () => {
    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "EMORA is loved by users across 14 languages who enjoy creating AI characters.",
        length_units: 13,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = noFakeSignalsGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// 3. Passes clean content
// ---------------------------------------------------------------------------

describe("noFakeSignalsGate — clean content passes", () => {
  it("PASSES content with no fake-signal patterns", () => {
    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "EMORA is an AI character chat platform that supports native language generation in 14 languages, enabling creators to build custom AI characters with persistent memory and group chat features.",
        length_units: 32,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = noFakeSignalsGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });

  it("PASSES a definition sentence with no fake signals", () => {
    const asset = makeAsset({
      content_type: "definition",
      format: "definition_sentence",
      body: {
        content_type: "definition",
        text: "EMORA is an AI character chat application for multilingual creative storytelling.",
        meaning_key: "emora-def",
      },
      claims: [],
    });

    const result = noFakeSignalsGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });

  it("PASSES empty body", () => {
    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "",
        length_units: 0,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [],
    });

    const result = noFakeSignalsGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 4. Passes when pattern is covered by a resolved claim
// ---------------------------------------------------------------------------

describe("noFakeSignalsGate — resolved claim covers pattern", () => {
  it("PASSES '5,000 reviews' when covered by a resolved numeric claim", () => {
    const resolvedClaim = makeClaim({
      claim_text: "5,000 reviews",
      claim_kind: "numeric",
      resolved_source_id: randomUUID(), // resolved
      verification: "verified",
    });

    const asset = makeAsset({
      body: {
        content_type: "answer_block",
        text: "EMORA has received 5,000 reviews from verified users on major platforms.",
        length_units: 12,
        numeric_claim_ids: [],
        source_ids: [],
      },
      claims: [resolvedClaim],
    });

    const result = noFakeSignalsGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 5. Gate metadata
// ---------------------------------------------------------------------------

describe("noFakeSignalsGate — metadata", () => {
  it("has correct name and phase", () => {
    expect(noFakeSignalsGate.name).toBe("noFakeSignalsGate");
    expect(noFakeSignalsGate.phase).toBe("content");
  });
});
