/**
 * test/keywordStuffing.test.ts
 *
 * X22(b) acceptance: keywordStuffingGate BLOCKs egregious single-term
 * over-repetition but is conservative — it never trips on short copy, on natural
 * technical density, or on stopwords.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { keywordStuffingGate, findKeywordStuffing } from "../src/content/gates/keywordStuffing.js";
import type { ContentAsset, ContentGateContext } from "../src/content/types.js";

const NOW = new Date("2025-01-01T00:00:00Z");

function makeAsset(body: ContentAsset["body"]): ContentAsset {
  return {
    id: randomUUID(),
    customer_id: "cust-1",
    industry: "tech",
    template_id: randomUUID(),
    template_version: 1,
    content_set_id: randomUUID(),
    content_type: body.content_type,
    format: body.content_type === "jsonld" ? "jsonld_org" : "answer_block",
    channel_class: "owned_net",
    language: "en",
    phrasing_group_id: "pg-1",
    body,
    claims: [],
    word_count: 10,
    gate_status: "pending",
    gate_report: null,
    disclosure_tag: null,
    needs_native_review: false,
    regen_attempts: 0,
    provenance: null,
    created_at: NOW,
  } as ContentAsset;
}

function answer(text: string): ContentAsset["body"] {
  return { content_type: "answer_block", text, length_units: 12, numeric_claim_ids: [], source_ids: [] };
}

function ctx(asset: ContentAsset): ContentGateContext {
  return { asset, siblings: [], claimSources: [] } as unknown as ContentGateContext;
}

describe("keywordStuffingGate (X22b negative control)", () => {
  it("has correct name and phase", () => {
    expect(keywordStuffingGate.name).toBe("keywordStuffingGate");
    expect(keywordStuffingGate.phase).toBe("content");
  });

  it("BLOCKs egregious single-term stuffing", () => {
    // "widgets" 12× inside ~70 significant tokens → ~17% density, well over 5%.
    const filler = Array.from({ length: 58 }, (_, i) => `alpha${i}`).join(" ");
    const stuffed = `widgets widgets widgets widgets widgets widgets widgets widgets widgets widgets widgets widgets ${filler}`;
    const r = keywordStuffingGate.apply(ctx(makeAsset(answer(stuffed))));
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/widgets/);
  });

  it("PASSES natural dense technical copy (no single term concentrated)", () => {
    const text =
      "EMORA supports streaming responses, voice synthesis, multilingual chat, " +
      "memory persistence, character creation, group conversations, content moderation, " +
      "and an export pipeline. Developers integrate via a documented REST interface, " +
      "configure rate limits, and monitor latency through structured telemetry dashboards " +
      "with retention policies and aggregated diagnostics across regional deployments.";
    const r = keywordStuffingGate.apply(ctx(makeAsset(answer(text))));
    expect(r.action).toBe("pass");
  });

  it("PASSES short copy below the significant-token floor even if repetitive", () => {
    // Too few significant tokens to judge — never trips.
    const r = keywordStuffingGate.apply(ctx(makeAsset(answer("chat chat chat chat chat chat chat chat"))));
    expect(r.action).toBe("pass");
  });

  it("does not count stopwords as stuffing", () => {
    // "with"/"that"/"this" are stopwords; long natural prose isn't flagged.
    const text =
      "This guide explains how the platform works with that data and this configuration. " +
      Array.from({ length: 60 }, (_, i) => `topic${i}`).join(" ");
    const r = keywordStuffingGate.apply(ctx(makeAsset(answer(text))));
    expect(r.action).toBe("pass");
  });

  it("findKeywordStuffing returns null for short prose", () => {
    expect(findKeywordStuffing("alpha beta gamma delta")).toBeNull();
  });

  it("PASSES jsonld bodies (no prose)", () => {
    const body: ContentAsset["body"] = {
      content_type: "jsonld",
      schema_type: "Organization",
      json: { "@type": "Organization", name: "EMORA" },
    } as unknown as ContentAsset["body"];
    expect(keywordStuffingGate.apply(ctx(makeAsset(body))).action).toBe("pass");
  });
});
