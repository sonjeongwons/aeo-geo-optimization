/**
 * test/disclosure.test.ts
 *
 * T11 acceptance criteria for disclosureGate:
 *
 * 1. BLOCKS a pr_wire asset with null disclosure_tag (§7#6).
 * 2. BLOCKS a pr_wire asset with an empty string disclosure_tag.
 * 3. BLOCKS a pr_wire asset with a disclosure_tag NOT in the controlled vocabulary.
 * 4. PASSES a pr_wire asset with a valid vocabulary disclosure_tag.
 * 5. PASSES owned_net/entity assets (no disclosure required).
 * 6. PASSES social/directory/web2 assets with valid disclosure tags.
 * 7. Gate has correct name/phase.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { disclosureGate } from "../src/content/gates/disclosure.js";
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
      text: "EMORA is an AI character chat platform.",
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

function makeCtx(asset: ContentAsset): ContentGateContext {
  return {
    asset,
    siblings: [],
    brandAliases: ["EMORA"],
    claimSources: [],
  };
}

// ---------------------------------------------------------------------------
// 1. BLOCKS pr_wire with null disclosure_tag
// ---------------------------------------------------------------------------

describe("disclosureGate — pr_wire requires disclosure", () => {
  it("BLOCKS pr_wire asset with null disclosure_tag", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "en",
      disclosure_tag: null,
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("pr_wire");
    expect(result.reason).toContain("§7#6");
  });

  it("BLOCKS pr_wire asset with empty string disclosure_tag", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "en",
      disclosure_tag: "",
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("null or empty");
  });

  it("BLOCKS pr_wire asset with whitespace-only disclosure_tag", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "en",
      disclosure_tag: "   ",
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
  });

  it("BLOCKS pr_wire asset with disclosure_tag NOT in controlled vocabulary", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "en",
      disclosure_tag: "This is an ad",  // not in en.json disclosure_tags
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
    expect(result.reason).toContain("controlled vocabulary");
  });

  it("PASSES pr_wire asset with valid English disclosure_tag 'Sponsored'", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "en",
      disclosure_tag: "Sponsored",
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });

  it("PASSES pr_wire asset with valid English disclosure_tag 'Advertisement'", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "en",
      disclosure_tag: "Advertisement",
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });

  it("PASSES pr_wire asset with valid English disclosure_tag (case-insensitive)", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "en",
      disclosure_tag: "sponsored", // lowercase — should still match
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 2. directory/web2/social also require disclosure
// ---------------------------------------------------------------------------

describe("disclosureGate — directory/web2/social require disclosure", () => {
  it("BLOCKS directory asset with null disclosure_tag", () => {
    const asset = makeAsset({
      channel_class: "directory",
      language: "en",
      disclosure_tag: null,
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
  });

  it("BLOCKS web2 asset with null disclosure_tag", () => {
    const asset = makeAsset({
      channel_class: "web2",
      language: "en",
      disclosure_tag: null,
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
  });

  it("BLOCKS social asset with null disclosure_tag", () => {
    const asset = makeAsset({
      channel_class: "social",
      language: "en",
      disclosure_tag: null,
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
  });

  it("PASSES social asset with valid disclosure tag", () => {
    const asset = makeAsset({
      channel_class: "social",
      language: "en",
      disclosure_tag: "Paid partnership",
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 3. owned_net and entity do NOT require disclosure
// ---------------------------------------------------------------------------

describe("disclosureGate — owned_net/entity do not require disclosure", () => {
  it("PASSES owned_net asset with null disclosure_tag", () => {
    const asset = makeAsset({
      channel_class: "owned_net",
      disclosure_tag: null,
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });

  it("PASSES entity asset with null disclosure_tag", () => {
    const asset = makeAsset({
      channel_class: "entity",
      disclosure_tag: null,
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 4. Korean and Japanese controlled vocabulary
// ---------------------------------------------------------------------------

describe("disclosureGate — multilingual controlled vocabulary", () => {
  it("PASSES Korean pr_wire asset with valid Korean disclosure tag '광고'", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "ko",
      disclosure_tag: "광고",
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });

  it("BLOCKS Korean pr_wire asset with English disclosure tag 'Sponsored'", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "ko",
      disclosure_tag: "Sponsored", // English tag in Korean context → not in ko.json
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("block");
  });

  it("PASSES Japanese pr_wire asset with valid Japanese disclosure tag '広告'", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "ja",
      disclosure_tag: "広告",
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });

  it("PASSES pr_wire asset with 'Paid partnership' (valid English vocabulary)", () => {
    const asset = makeAsset({
      channel_class: "pr_wire",
      language: "en",
      disclosure_tag: "Paid partnership",
    });

    const result = disclosureGate.apply(makeCtx(asset));
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 5. Gate metadata
// ---------------------------------------------------------------------------

describe("disclosureGate — metadata", () => {
  it("has correct name and phase", () => {
    expect(disclosureGate.name).toBe("disclosureGate");
    expect(disclosureGate.phase).toBe("content");
  });
});
