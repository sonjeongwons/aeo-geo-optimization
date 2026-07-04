/** test/geo-readiness.test.ts — SOTA sweep H: GEO-readiness advisory gate. */
import { describe, it, expect } from "vitest";
import { scoreGeoReadiness, geoReadinessGate } from "../src/content/gates/geoReadiness.js";
import type { ContentAsset, ContentGateContext } from "../src/content/types.js";

function asset(body: any): ContentAsset {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    customer_id: null,
    industry: "ai-companion",
    template_id: "00000000-0000-0000-0000-0000000000a1",
    template_version: 1,
    content_set_id: "00000000-0000-0000-0000-0000000000b1",
    content_type: body.content_type,
    format: body.content_type === "definition" ? "definition_sentence" : body.content_type,
    channel_class: "owned_net",
    language: "en",
    phrasing_group_id: "pg1",
    body,
    claims: [],
    word_count: 10,
    gate_status: "pending",
    gate_report: null,
  } as unknown as ContentAsset;
}

const ctx = (a: ContentAsset): ContentGateContext => ({
  asset: a,
  siblings: [],
  brandAliases: ["EMORA"],
  claimSources: [],
});

describe("scoreGeoReadiness (H pillars)", () => {
  it("definition: full score with meaning_key + adequate text", () => {
    const r = scoreGeoReadiness(
      asset({ content_type: "definition", text: "EMORA is an AI character chat platform with memory.", meaning_key: "emora-definition" }),
    );
    expect(r.score).toBe(1);
    expect(r.missing).toEqual([]);
  });

  it("definition: missing meaning_key lowers the score", () => {
    const r = scoreGeoReadiness(
      asset({ content_type: "definition", text: "EMORA is an AI character chat platform with memory.", meaning_key: "" }),
    );
    expect(r.score).toBe(0.5);
    expect(r.missing).toContain("has_meaning_key");
  });

  it("answer_block: rewards length band + evidence binding", () => {
    const good = scoreGeoReadiness(
      asset({ content_type: "answer_block", text: "...", length_units: 120, numeric_claim_ids: [], source_ids: ["s1"] }),
    );
    expect(good.score).toBe(1);
    const thin = scoreGeoReadiness(
      asset({ content_type: "answer_block", text: "...", length_units: 5, numeric_claim_ids: [], source_ids: [] }),
    );
    expect(thin.score).toBe(0);
    expect(thin.missing).toEqual(["answer_length_band", "evidence_binding"]);
  });

  it("faq: rewards 3-8 row band + answer binding", () => {
    const rows = [
      { q: "Q1", a: "A1", answer_claim_ids: ["c1"] },
      { q: "Q2", a: "A2", answer_claim_ids: [] },
      { q: "Q3", a: "A3", answer_claim_ids: [] },
    ];
    const r = scoreGeoReadiness(asset({ content_type: "faq", rows }));
    expect(r.score).toBe(1);
  });

  it("comparison: columns + rows + cell evidence", () => {
    const r = scoreGeoReadiness(
      asset({
        content_type: "comparison",
        columns: ["EMORA", "Other"],
        rows: [{ entity: "memory", cells: [{ value: "yes", claim_id: "c1" }] }],
      }),
    );
    expect(r.score).toBe(1);
  });

  it("score is always in [0,1]", () => {
    const r = scoreGeoReadiness(asset({ content_type: "case_study", situation: "s", action: "a", result: "r", metrics: [] }));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});

describe("geoReadinessGate (advisory — never blocks)", () => {
  it("ALWAYS returns pass, even for a deficient asset", () => {
    const a = asset({ content_type: "answer_block", text: "...", length_units: 1, numeric_claim_ids: [], source_ids: [] });
    const res = geoReadinessGate.apply(ctx(a));
    expect(res.action).toBe("pass");
    expect(res.gate).toBe("geoReadinessGate");
  });

  it("records the readiness % and missing pillars in the reason", () => {
    const a = asset({ content_type: "answer_block", text: "...", length_units: 1, numeric_claim_ids: [], source_ids: [] });
    const res = geoReadinessGate.apply(ctx(a));
    expect(res.reason).toMatch(/content-readiness \d+%/);
    expect(res.reason).toContain("missing");
  });

  it("phase is 'content'", () => {
    expect(geoReadinessGate.phase).toBe("content");
  });
});

describe("answer_length_band matches the enforced per-script band (W6.3)", () => {
  const koAsset = (length_units: number): ContentAsset =>
    ({ ...asset({ content_type: "answer_block", text: "...", length_units, numeric_claim_ids: [], source_ids: ["s1"] }), language: "ko" }) as ContentAsset;

  it("a 400-char Korean answer_block passes the length pillar (would fail the old hardcoded 320 cap)", () => {
    // ko enforced band is up to ceil(167*3.0)=501 chars; 400 is valid.
    const r = scoreGeoReadiness(koAsset(400));
    expect(r.missing).not.toContain("answer_length_band");
    expect(r.score).toBe(1);
  });

  it("a Korean answer_block above the ko band (600 chars) still fails the pillar", () => {
    const r = scoreGeoReadiness(koAsset(600));
    expect(r.missing).toContain("answer_length_band");
  });

  it("an English answer_block over the word band (400 words) fails the pillar", () => {
    const r = scoreGeoReadiness(
      asset({ content_type: "answer_block", text: "...", length_units: 400, numeric_claim_ids: [], source_ids: ["s1"] }),
    );
    expect(r.missing).toContain("answer_length_band");
  });
});
