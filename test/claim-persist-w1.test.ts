/**
 * test/claim-persist-w1.test.ts
 *
 * W1.1 — the claimVerificationGate must write the RESOLVED claims (resolved_source_id
 * + verification set by verifyAndDecide) back onto ctx.asset.claims, so the caller
 * (assembleContentSet) can persist them via updateAssetGateStatus. Previously the
 * resolved claims were discarded, dead-ending re-gating and leaving the
 * geoReadiness evidence_binding pillar structurally always-false.
 */
import { describe, it, expect } from "vitest";
import { claimVerificationGate } from "../src/content/gates/claimVerification.js";
import type {
  ContentAsset,
  ContentGateContext,
  ClaimRecord,
  ClaimSourceRow,
} from "../src/content/types.js";

function source(text: string): ClaimSourceRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    customer_id: "22222222-2222-2222-2222-222222222222",
    claim_text: text,
    claim_kind: "capability",
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

function asset(text: string, claims: ClaimRecord[]): ContentAsset {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    customer_id: null,
    industry: "ai-companion",
    template_id: "00000000-0000-0000-0000-0000000000a1",
    template_version: 1,
    content_set_id: "00000000-0000-0000-0000-0000000000b1",
    content_type: "answer_block",
    format: "answer_block",
    channel_class: "owned_net",
    language: "en",
    phrasing_group_id: "pg1",
    body: { content_type: "answer_block", text, length_units: 12, numeric_claim_ids: [], source_ids: [] },
    claims,
    word_count: 12,
    gate_status: "pending",
    gate_report: null,
  } as unknown as ContentAsset;
}

describe("W1.1 — claimVerificationGate persists resolved claims onto the asset", () => {
  it("writes resolved_source_id + verification back onto ctx.asset.claims when a claim binds", async () => {
    const text = "revenue sharing program for content creators";
    const src = source(
      "Talkie AI: a revenue-sharing program exists for content creators who publish characters on the platform",
    );
    const a = asset(text, [capabilityClaim(text)]);
    const ctx: ContentGateContext = { asset: a, siblings: [], brandAliases: ["EMORA"], claimSources: [src] };

    const result = await claimVerificationGate.apply(ctx);

    expect(result.action).toBe("pass");
    // The asset now carries the RESOLVED claim (previously discarded).
    expect(a.claims).toHaveLength(1);
    expect(a.claims[0]!.resolved_source_id).toBe(src.id);
    expect(a.claims[0]!.verification).toBe("verified");
  });

  it("leaves asset.claims empty (no crash) for an empty-body asset", async () => {
    const a = asset("", []);
    // Force empty body text.
    (a.body as { text: string }).text = "";
    const ctx: ContentGateContext = { asset: a, siblings: [], brandAliases: [], claimSources: [] };
    const result = await claimVerificationGate.apply(ctx);
    expect(result.action).toBe("pass");
    expect(a.claims).toEqual([]);
  });
});
