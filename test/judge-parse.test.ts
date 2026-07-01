/**
 * test/judge-parse.test.ts
 *
 * Vitest suite for:
 *   1. Zod JudgeVerdict validation (valid / invalid shapes).
 *   2. The pro-escalation-on-PARSE_FAILED path via extractMention (adapter mocked).
 *
 * No real Gemini calls — the adapter is a mock injected through the
 * ExtractMentionRequest.judgeAdapter seam.
 */

import { describe, it, expect, vi } from "vitest";
import { JudgeVerdictSchema } from "../src/domain/mention.schema.js";
import type { JudgeVerdict } from "../src/domain/mention.schema.js";
import { extractMention } from "../src/judge/extractMention.js";
import type { ProviderAdapter, JudgeRequest, JudgeResult, GenerateRequest, GenerateResult } from "../src/providers/types.js";
import { NOT_CONFIGURED } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidVerdict(overrides: Partial<JudgeVerdict> = {}): unknown {
  return {
    brand_mentioned: true,
    brand_rank: 1,
    sentiment: "positive",
    competitors_found: [{ name: "Replika", rank: 2 }],
    evidence: { quote: "EMORA is great", start: 0, end: 14 },
    ...overrides,
  };
}

/** Minimal mock ProviderAdapter whose judge() returns whatever you inject. */
function makeMockAdapter(judgeImpl: (req: JudgeRequest) => Promise<JudgeResult>): ProviderAdapter {
  return {
    provider: "mock",
    modality: "chat",
    capabilities: ["generate", "judge", "structured"],
    status: "ready",
    async generate(_req: GenerateRequest): Promise<GenerateResult> {
      return { ok: false, code: NOT_CONFIGURED };
    },
    judge: judgeImpl,
  };
}

// ---------------------------------------------------------------------------
// 1. Zod JudgeVerdict validation
// ---------------------------------------------------------------------------

describe("JudgeVerdictSchema — valid shapes", () => {
  it("accepts a fully valid verdict (brand mentioned)", () => {
    const result = JudgeVerdictSchema.safeParse(makeValidVerdict());
    expect(result.success).toBe(true);
  });

  it("accepts brand_mentioned=false with nulls", () => {
    const result = JudgeVerdictSchema.safeParse({
      brand_mentioned: false,
      brand_rank: null,
      sentiment: null,
      competitors_found: [],
      evidence: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts all three sentiment values", () => {
    for (const sentiment of ["positive", "neutral", "negative"] as const) {
      const r = JudgeVerdictSchema.safeParse(makeValidVerdict({ sentiment }));
      expect(r.success, `sentiment=${sentiment}`).toBe(true);
    }
  });

  it("accepts multiple competitors_found entries", () => {
    const result = JudgeVerdictSchema.safeParse(
      makeValidVerdict({
        competitors_found: [
          { name: "Replika", rank: 2 },
          { name: "Character.AI", rank: null },
        ],
      })
    );
    expect(result.success).toBe(true);
  });

  it("accepts brand_rank as a positive integer", () => {
    const result = JudgeVerdictSchema.safeParse(makeValidVerdict({ brand_rank: 3 }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brand_rank).toBe(3);
    }
  });
});

describe("JudgeVerdictSchema — invalid shapes", () => {
  it("rejects missing brand_mentioned field", () => {
    const raw = { brand_rank: 1, sentiment: null, competitors_found: [], evidence: null };
    expect(JudgeVerdictSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects non-boolean brand_mentioned", () => {
    const raw = makeValidVerdict({ brand_mentioned: "yes" as unknown as boolean });
    expect(JudgeVerdictSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects invalid sentiment value", () => {
    const raw = makeValidVerdict({ sentiment: "great" as "positive" });
    expect(JudgeVerdictSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects non-integer brand_rank", () => {
    const raw = makeValidVerdict({ brand_rank: 1.5 });
    expect(JudgeVerdictSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects non-positive brand_rank (0 is invalid)", () => {
    const raw = makeValidVerdict({ brand_rank: 0 });
    expect(JudgeVerdictSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects evidence with end <= start", () => {
    // end must be positive integer but the schema doesn't enforce end > start structurally —
    // it does require end > 0 as a positive integer; start 5 / end 5 => end fails positive check
    // This checks that end=0 is rejected (schema requires positive).
    const raw = makeValidVerdict({
      evidence: { quote: "x", start: 0, end: 0 },
    });
    expect(JudgeVerdictSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects negative evidence.start", () => {
    const raw = makeValidVerdict({
      evidence: { quote: "x", start: -1, end: 5 },
    });
    expect(JudgeVerdictSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects missing competitors_found", () => {
    const { competitors_found: _, ...withoutCompetitors } = makeValidVerdict() as Record<string, unknown>;
    expect(JudgeVerdictSchema.safeParse(withoutCompetitors).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Pro escalation on PARSE_FAILED
// ---------------------------------------------------------------------------

describe("extractMention — pro escalation on PARSE_FAILED", () => {
  const ANSWER = "EMORA is a great AI companion app for memory-based conversations.";
  const BRAND_NAME = "EMORA";
  const BRAND_ALIASES = ["emora", "에모라", "エモラ"];
  const COMPETITORS = [{ name: "Replika", aliases: ["replika"] }];

  it("calls judge once on success (no escalation needed)", async () => {
    const judgeSpy = vi.fn<[JudgeRequest], Promise<JudgeResult>>().mockResolvedValueOnce({
      ok: true,
      verdict: {
        brand_mentioned: true,
        brand_rank: 1,
        sentiment: "positive",
        competitors_found: [],
        evidence: { quote: "EMORA is a great", start: 0, end: 16 },
      },
      raw: {},
      usage: { inputTokens: 100, outputTokens: 50, usd: 0.001, cacheHit: false },
      modelId: "gemini-2.5-flash-lite",
    });

    const adapter = makeMockAdapter(judgeSpy);
    const result = await extractMention({
      answerText: ANSWER,
      brandName: BRAND_NAME,
      brandAliases: BRAND_ALIASES,
      competitors: COMPETITORS,
      judgeAdapter: adapter,
    });

    // Judge called once
    expect(judgeSpy).toHaveBeenCalledTimes(1);
    expect(result.provenance).toBe("judge");
    expect(result.verdict.brand_mentioned).toBe(true);
  });

  it("falls through to rule fallback when judge returns PARSE_FAILED", async () => {
    // The adapter itself handles escalation internally (per DESIGN §5.4 and gemini.ts).
    // When adapter.judge() ultimately returns PARSE_FAILED, extractMention falls to fallback.
    const judgeSpy = vi.fn<[JudgeRequest], Promise<JudgeResult>>().mockResolvedValue({
      ok: false,
      code: "PARSE_FAILED",
      raw: "not valid json",
      usage: { inputTokens: 100, outputTokens: 10, usd: 0.0005, cacheHit: false },
      modelId: "gemini-2.5-flash-lite",
    });

    const adapter = makeMockAdapter(judgeSpy);
    const result = await extractMention({
      answerText: ANSWER,
      brandName: BRAND_NAME,
      brandAliases: BRAND_ALIASES,
      competitors: COMPETITORS,
      judgeAdapter: adapter,
    });

    // When adapter returns PARSE_FAILED, extractMention falls through to fallback
    expect(result.provenance).toBe("fallback");
    // Rule fallback should still find EMORA
    expect(result.verdict.brand_mentioned).toBe(true);
    // judgeRaw is null (parse failed, no valid JSON to propagate)
    expect(result.judgeRaw).toBeNull();
    // FIX (judge-spend-not-ledgered-on-parsefail): usage and modelId ARE propagated
    // even on parse failure so the §11 cost ledger can record real spend.
    expect(result.judgeUsage).toEqual({ inputTokens: 100, outputTokens: 10, usd: 0.0005, cacheHit: false });
    expect(result.judgeModelId).toBe("gemini-2.5-flash-lite");
  });

  it("propagates judge usage from PARSE_FAILED even on pro-escalation (never discards spend)", async () => {
    // Simulate the worst case: pro escalation also PARSE_FAILs.
    // The adapter returns the pro-model usage in the final PARSE_FAILED result.
    const PRO_USAGE = { inputTokens: 800, outputTokens: 80, usd: 0.02, cacheHit: false };
    const judgeSpy = vi.fn<[JudgeRequest], Promise<JudgeResult>>().mockResolvedValue({
      ok: false,
      code: "PARSE_FAILED",
      raw: null,
      usage: PRO_USAGE,
      modelId: "gemini-2.5-pro",
    });

    const adapter = makeMockAdapter(judgeSpy);
    const result = await extractMention({
      answerText: ANSWER,
      brandName: BRAND_NAME,
      brandAliases: BRAND_ALIASES,
      competitors: COMPETITORS,
      judgeAdapter: adapter,
      escalationJudgeModelId: "gemini-2.5-pro",
    });

    expect(result.provenance).toBe("fallback");
    // Spend from the pro escalation call must be preserved (§11 budget integrity).
    expect(result.judgeUsage).toEqual(PRO_USAGE);
    expect(result.judgeModelId).toBe("gemini-2.5-pro");
  });

  it("escalation: adapter receives both preferredModelId and escalationModelId", async () => {
    // The GeminiAdapter handles escalation internally, but we verify that callLlmJudge
    // passes both model IDs to the adapter so the adapter can escalate.
    const judgeSpy = vi.fn<[JudgeRequest], Promise<JudgeResult>>().mockResolvedValueOnce({
      ok: true,
      verdict: {
        brand_mentioned: false,
        brand_rank: null,
        sentiment: null,
        competitors_found: [],
        evidence: null,
      },
      raw: {},
      usage: { inputTokens: 100, outputTokens: 50, usd: 0.001, cacheHit: false },
      modelId: "gemini-2.5-pro",
    });

    const adapter = makeMockAdapter(judgeSpy);
    await extractMention({
      answerText: ANSWER,
      brandName: BRAND_NAME,
      brandAliases: BRAND_ALIASES,
      competitors: COMPETITORS,
      judgeAdapter: adapter,
      preferredJudgeModelId: "gemini-2.5-flash-lite",
      escalationJudgeModelId: "gemini-2.5-pro",
    });

    expect(judgeSpy).toHaveBeenCalledTimes(1);
    const callArg = judgeSpy.mock.calls[0]![0];
    expect(callArg.preferredModelId).toBe("gemini-2.5-flash-lite");
    expect(callArg.escalationModelId).toBe("gemini-2.5-pro");
  });

  it("returns provenance=abstain when answerText is null", async () => {
    const judgeSpy = vi.fn<[JudgeRequest], Promise<JudgeResult>>();
    const adapter = makeMockAdapter(judgeSpy);

    const result = await extractMention({
      answerText: null,
      brandName: BRAND_NAME,
      brandAliases: BRAND_ALIASES,
      competitors: COMPETITORS,
      judgeAdapter: adapter,
    });

    // Null answer → abstain immediately, judge never called
    expect(judgeSpy).not.toHaveBeenCalled();
    expect(result.provenance).toBe("abstain");
    expect(result.verdict.brand_mentioned).toBe(false);
  });

  it("returns provenance=fallback when adapter is stub (not_configured)", async () => {
    // Stub adapter: status='not_configured', judge not called
    const stubAdapter: ProviderAdapter = {
      provider: "stub",
      modality: "chat",
      capabilities: ["generate"],
      status: "not_configured",
      async generate(_req: GenerateRequest): Promise<GenerateResult> {
        return { ok: false, code: NOT_CONFIGURED };
      },
      async judge(_req: JudgeRequest): Promise<JudgeResult> {
        return { ok: false, code: NOT_CONFIGURED };
      },
    };

    const result = await extractMention({
      answerText: ANSWER,
      brandName: BRAND_NAME,
      brandAliases: BRAND_ALIASES,
      competitors: COMPETITORS,
      judgeAdapter: stubAdapter,
    });

    // Judge not configured → falls through to rule fallback
    expect(result.provenance).toBe("fallback");
    expect(result.verdict.brand_mentioned).toBe(true); // EMORA found by rule
  });

  it("never throws when judge returns garbage JSON", async () => {
    const judgeSpy = vi.fn<[JudgeRequest], Promise<JudgeResult>>().mockResolvedValue({
      ok: false,
      code: "PARSE_FAILED",
      raw: null,
      usage: { inputTokens: 0, outputTokens: 0, usd: 0, cacheHit: false },
      modelId: "gemini-2.5-flash-lite",
    });

    const adapter = makeMockAdapter(judgeSpy);

    await expect(
      extractMention({
        answerText: "Some answer text",
        brandName: BRAND_NAME,
        brandAliases: BRAND_ALIASES,
        competitors: COMPETITORS,
        judgeAdapter: adapter,
      })
    ).resolves.toBeDefined();
  });
});
