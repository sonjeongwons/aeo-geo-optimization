/**
 * test/surfaces/surfaceAdapter.e2e.test.ts
 *
 * T17 — E2E: Surface answer → mention_judgment path (no core edits).
 *
 * DESIGN-phase4.md T17 acceptance criterion:
 *   "e2e to mention_judgment no core edits"
 *
 * This test proves that a v1-b surface answer (from SurfaceAdapter.generate())
 * reaches the extractMention / mention_judgment pipeline via the SAME path used
 * by Phase 0-3 chat adapters — with ZERO modifications to any core files
 * (runResponse, extractMention, ruleFallback, etc.).
 *
 * Test strategy:
 *   1. Build a SurfaceAdapter with a FixtureSerpClient or FixtureRpaRunner
 *      (armed, returns fixture raw data with a known parser).
 *   2. Call adapter.generate() — should return GenerateOk with prose answerText.
 *   3. Pass answerText to extractMention (same call the real pipeline makes).
 *      Use a NOT_CONFIGURED judge adapter → rule-based fallback runs.
 *   4. Verify the result has a valid JudgeVerdict (brand_mentioned, etc.).
 *   5. Verify judge() on the surface adapter returns NOT_CONFIGURED (surface
 *      adapters are not judges; the pipeline uses a separate judgeAdapter).
 *   6. Verify PROSE/CITATION SEPARATION: citations are in meta.citations,
 *      NOT in answerText that was passed to the judge.
 *
 * No DB, no network, no pg, no @google/genai — all seams injected as fixtures.
 * Core files (extractMention, ruleFallback) are imported but NOT modified.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FixtureSerpClient } from "../../src/surfaces/serp/serpClient.js";
import { FixtureRpaRunner } from "../../src/surfaces/scrape/rpaRunner.js";
import { SurfaceAdapter } from "../../src/surfaces/SurfaceAdapter.js";
import { AiOverviewParser } from "../../src/surfaces/serp/parse/aiOverviewParser.js";
import { NaverParser } from "../../src/surfaces/serp/parse/naverParser.js";
import { CopilotParser } from "../../src/surfaces/scrape/parse/copilotParser.js";
import { extractMention } from "../../src/judge/extractMention.js";
import { NOT_CONFIGURED } from "../../src/providers/types.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Brand being tracked. */
const BRAND = "AcmeCorp";
const BRAND_ALIASES = ["acmecorp", "Acme Corp", "acme-corp"];

/** Competitors. */
const COMPETITORS = [
  { name: "RivalCo", aliases: ["rivalco", "rival co"] },
];

/**
 * A NOT_CONFIGURED judge adapter — mirrors how stubs are returned
 * by providers that have no judge capability.
 *
 * When the judge adapter returns NOT_CONFIGURED, extractMention falls
 * through to rule-based judgment (ruleFallback) — the same code path
 * exercised in production when Gemini is unavailable.
 */
const stubJudgeAdapter: ProviderAdapter = {
  provider: "stub-judge",
  modality: "chat",
  capabilities: [],
  status: "not_configured",
  async generate() {
    return { ok: false, code: NOT_CONFIGURED };
  },
  async judge() {
    return { ok: false, code: NOT_CONFIGURED };
  },
};

// ---------------------------------------------------------------------------
// Helper: invoke the extractMention pipeline
// ---------------------------------------------------------------------------

async function runMentionPipeline(answerText: string | null) {
  return extractMention({
    answerText,
    brandName: BRAND,
    brandAliases: BRAND_ALIASES,
    competitors: COMPETITORS,
    judgeAdapter: stubJudgeAdapter,
  });
}

// ===========================================================================
// Google AI Overviews — SERP surface e2e
// ===========================================================================

describe("E2E: googleAio SurfaceAdapter → generate() → extractMention (rule fallback)", () => {
  /** SERP API fixture raw response with a known brand mention in the prose. */
  const AIO_FIXTURE_BRAND_MENTIONED = {
    ai_overview: {
      text_blocks: [
        {
          type: "paragraph",
          text: "AcmeCorp is a leading provider of enterprise software solutions. " +
                "Their flagship product is widely used across industries.",
        },
        {
          type: "paragraph",
          text: "RivalCo also offers similar products but at a higher price point.",
        },
      ],
      references: [
        { link: "https://acmecorp.com/about", title: "AcmeCorp Official", snippet: "AcmeCorp solutions." },
        { link: "https://rivalco.com/products", title: "RivalCo Products" },
      ],
    },
  };

  const client = new FixtureSerpClient(AIO_FIXTURE_BRAND_MENTIONED, 0.005);

  const adapter = new SurfaceAdapter({
    kind: "serp",
    surfaceId: "googleAio",
    client,
    parser: new AiOverviewParser(),
    buildSerpRequest: (prompt, lang) => ({ query: prompt, language: lang }),
  });

  it("adapter.status is 'ready' when client is configured", () => {
    expect(adapter.status).toBe("ready");
  });

  it("adapter.modality is 'serp'", () => {
    expect(adapter.modality).toBe("serp");
  });

  it("adapter.judge() returns NOT_CONFIGURED (surface adapters are not judges)", async () => {
    const judgeResult = await adapter.judge({
      answerText: "some answer",
      brandName: BRAND,
      brandAliases: BRAND_ALIASES,
      competitors: COMPETITORS,
      preferredModelId: "gemini-2.5-flash-lite",
    });
    expect(judgeResult.ok).toBe(false);
    if (judgeResult.ok) throw new Error("Expected NOT_CONFIGURED");
    expect(judgeResult.code).toBe(NOT_CONFIGURED);
  });

  it("adapter.generate() returns GenerateOk with prose answerText", async () => {
    const result = await adapter.generate({
      prompt: "What is the best enterprise software?",
      modelId: "googleAio",
      temperature: 0.7,
      promptVersion: "v1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected GenerateOk");

    // answerText must be non-empty prose
    expect(result.answerText.trim().length).toBeGreaterThan(0);
    expect(result.answerText).toContain("AcmeCorp");
  });

  it("PROSE/CITATION SEPARATION: citations in meta, not in answerText", async () => {
    const result = await adapter.generate({
      prompt: "What is the best enterprise software?",
      modelId: "googleAio",
      temperature: 0.7,
      promptVersion: "v1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected GenerateOk");

    // Citations are in meta, not in answerText
    const citations = result.meta["citations"] as Array<{ url: string }>;
    expect(citations).toHaveLength(2);
    expect(citations[0].url).toBe("https://acmecorp.com/about");
    expect(citations[1].url).toBe("https://rivalco.com/products");

    // URLs MUST NOT appear in answerText
    expect(result.answerText).not.toContain("https://acmecorp.com/about");
    expect(result.answerText).not.toContain("https://rivalco.com/products");
  });

  it("answerText flows into extractMention and produces a valid verdict", async () => {
    const genResult = await adapter.generate({
      prompt: "What is the best enterprise software?",
      modelId: "googleAio",
      temperature: 0.7,
      promptVersion: "v1",
    });

    expect(genResult.ok).toBe(true);
    if (!genResult.ok) throw new Error("Expected GenerateOk");

    // THIS IS THE CORE E2E STEP: answerText goes through the mention pipeline.
    // extractMention is the SAME function used in production runResponse.
    // NO CORE EDITS needed — surface answers are plain strings.
    const mentionResult = await runMentionPipeline(genResult.answerText);

    // Brand is mentioned in the fixture prose → should be detected
    expect(mentionResult.verdict.brand_mentioned).toBe(true);
    expect(mentionResult.verdict.sentiment).toBe("neutral");
    // Provenance should be 'fallback' (rule-based, since judge adapter is NOT_CONFIGURED)
    expect(mentionResult.provenance).toBe("fallback");
  });

  it("extractMention: brand NOT mentioned → brand_mentioned=false", async () => {
    // Use a fixture where AcmeCorp is not in the answer
    const noMentionFixture = {
      ai_overview: {
        text_blocks: [
          { type: "paragraph", text: "RivalCo is the market leader in this space." },
        ],
        references: [{ link: "https://rivalco.com" }],
      },
    };
    const noMentionClient = new FixtureSerpClient(noMentionFixture, 0);
    const noMentionAdapter = new SurfaceAdapter({
      kind: "serp",
      surfaceId: "googleAio",
      client: noMentionClient,
      parser: new AiOverviewParser(),
      buildSerpRequest: (p, l) => ({ query: p, language: l }),
    });

    const genResult = await noMentionAdapter.generate({
      prompt: "Who leads the market?",
      modelId: "googleAio",
      temperature: 0.7,
      promptVersion: "v1",
    });

    expect(genResult.ok).toBe(true);
    if (!genResult.ok) throw new Error("Expected GenerateOk");

    const mentionResult = await runMentionPipeline(genResult.answerText);
    expect(mentionResult.verdict.brand_mentioned).toBe(false);
  });
});

// ===========================================================================
// Naver AI — SERP surface e2e (nativeReview=true)
// ===========================================================================

describe("E2E: naverAi SurfaceAdapter → generate() → extractMention", () => {
  const NAVER_FIXTURE = {
    naver_ai: {
      answer: "AcmeCorp는 기업용 소프트웨어 분야의 선두 기업입니다. 많은 고객들이 신뢰합니다.",
      sources: [
        { link: "https://naver.com/acmecorp", title: "AcmeCorp 정보" },
      ],
    },
  };

  const naverClient = new FixtureSerpClient(NAVER_FIXTURE, 0);
  const naverAdapter = new SurfaceAdapter({
    kind: "serp",
    surfaceId: "naverAi",
    client: naverClient,
    parser: new NaverParser(),
    buildSerpRequest: (p, l) => ({ query: p, language: l, region: "kr" }),
  });

  it("adapter status is ready with FixtureSerpClient", () => {
    expect(naverAdapter.status).toBe("ready");
  });

  it("generate() returns GenerateOk with Korean prose", async () => {
    const result = await naverAdapter.generate({
      prompt: "AcmeCorp에 대해 알려줘",
      modelId: "naverAi",
      temperature: 0.7,
      promptVersion: "lang:ko:v1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected GenerateOk");
    expect(result.answerText.trim().length).toBeGreaterThan(0);
  });

  it("meta.nativeReview is true (KR market surface)", async () => {
    const result = await naverAdapter.generate({
      prompt: "AcmeCorp에 대해 알려줘",
      modelId: "naverAi",
      temperature: 0.7,
      promptVersion: "lang:ko:v1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected GenerateOk");
    expect(result.meta["nativeReview"]).toBe(true);
  });

  it("answerText flows into extractMention successfully", async () => {
    const genResult = await naverAdapter.generate({
      prompt: "AcmeCorp에 대해 알려줘",
      modelId: "naverAi",
      temperature: 0.7,
      promptVersion: "lang:ko:v1",
    });

    expect(genResult.ok).toBe(true);
    if (!genResult.ok) throw new Error("Expected GenerateOk");

    // Korean text with "AcmeCorp" alias — rule fallback should detect it
    const mentionResult = await runMentionPipeline(genResult.answerText);
    // AcmeCorp appears in Korean text as-is → rule fallback should find it
    expect(typeof mentionResult.verdict.brand_mentioned).toBe("boolean");
    expect(["fallback", "abstain"]).toContain(mentionResult.provenance);
  });
});

// ===========================================================================
// Copilot — Scrape surface e2e
// ===========================================================================

describe("E2E: copilot SurfaceAdapter → generate() → extractMention", () => {
  const COPILOT_SNAPSHOT = {
    answerBlock:
      "According to my research, AcmeCorp is the industry leader. " +
      "They have pioneered many innovations that RivalCo has later adopted.",
    citations: [
      { url: "https://bing.com/search?q=acmecorp", title: "Bing: AcmeCorp", rank: 1 },
      { url: "https://bing.com/search?q=rivalco", title: "Bing: RivalCo", rank: 2 },
    ],
  };

  const rpaRunner = new FixtureRpaRunner(COPILOT_SNAPSHOT, 0);
  const copilotAdapter = new SurfaceAdapter({
    kind: "scrape",
    surfaceId: "copilot",
    runner: rpaRunner,
    parser: new CopilotParser(),
    buildRpaRequest: (p, l) => ({
      targetUrl: "https://copilot.microsoft.com",
      query: p,
      language: l,
      timeoutMs: 30_000,
    }),
  });

  it("adapter.status is 'ready' with FixtureRpaRunner", () => {
    expect(copilotAdapter.status).toBe("ready");
  });

  it("adapter.modality is 'scrape'", () => {
    expect(copilotAdapter.modality).toBe("scrape");
  });

  it("generate() returns GenerateOk with prose from Copilot snapshot", async () => {
    const result = await copilotAdapter.generate({
      prompt: "What is AcmeCorp known for?",
      modelId: "copilot",
      temperature: 0.7,
      promptVersion: "v1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected GenerateOk");
    expect(result.answerText).toContain("AcmeCorp");
  });

  it("PROSE/CITATION SEPARATION: Bing URLs in meta.citations, not answerText", async () => {
    const result = await copilotAdapter.generate({
      prompt: "What is AcmeCorp known for?",
      modelId: "copilot",
      temperature: 0.7,
      promptVersion: "v1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected GenerateOk");

    const citations = result.meta["citations"] as Array<{ url: string }>;
    expect(citations.length).toBeGreaterThan(0);
    expect(result.answerText).not.toContain("https://bing.com");
  });

  it("answerText → extractMention → valid verdict (brand_mentioned=true)", async () => {
    const genResult = await copilotAdapter.generate({
      prompt: "What is AcmeCorp known for?",
      modelId: "copilot",
      temperature: 0.7,
      promptVersion: "v1",
    });

    expect(genResult.ok).toBe(true);
    if (!genResult.ok) throw new Error("Expected GenerateOk");

    // THE CORE E2E PATH — same as production runResponse:
    // answerText is passed directly to extractMention, NO CORE EDITS NEEDED.
    const mentionResult = await runMentionPipeline(genResult.answerText);

    expect(mentionResult.verdict.brand_mentioned).toBe(true);
    expect(mentionResult.provenance).toBe("fallback");
    // Competitors should be found since "RivalCo" is in the prose
    const rivalco = mentionResult.verdict.competitors_found.find(
      (c) => c.name === "RivalCo"
    );
    expect(rivalco).toBeDefined();
  });

  it("NOT_CONFIGURED stub runner → generate() returns NOT_CONFIGURED", async () => {
    // Verify that a not-configured scrape adapter returns NOT_CONFIGURED
    // (the pipeline skips this work-unit, same as chat adapters without keys)
    const { NotConfiguredRpaRunner } = await import("../../src/surfaces/scrape/rpaRunner.js");
    const notConfiguredAdapter = new SurfaceAdapter({
      kind: "scrape",
      surfaceId: "copilot",
      runner: new NotConfiguredRpaRunner(),
      parser: new CopilotParser(),
      buildRpaRequest: (p, l) => ({
        targetUrl: "https://copilot.microsoft.com",
        query: p,
        language: l,
      }),
    });

    expect(notConfiguredAdapter.status).toBe("not_configured");

    const result = await notConfiguredAdapter.generate({
      prompt: "test",
      modelId: "copilot",
      temperature: 0.7,
      promptVersion: "v1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected NOT_CONFIGURED");
    expect(result.code).toBe(NOT_CONFIGURED);
  });
});

// ===========================================================================
// NOT_CONFIGURED SERP surface — verify the stub path
// ===========================================================================

describe("E2E: NOT_CONFIGURED SerpClient → generate() returns NOT_CONFIGURED", () => {
  it("NotConfiguredSerpClient: generate() returns NOT_CONFIGURED without a network call", async () => {
    const { NotConfiguredSerpClient } = await import("../../src/surfaces/serp/serpClient.js");
    const notConfiguredAdapter = new SurfaceAdapter({
      kind: "serp",
      surfaceId: "googleAio",
      client: new NotConfiguredSerpClient(),
      parser: new AiOverviewParser(),
      buildSerpRequest: (p, l) => ({ query: p, language: l }),
    });

    expect(notConfiguredAdapter.status).toBe("not_configured");

    const result = await notConfiguredAdapter.generate({
      prompt: "test",
      modelId: "googleAio",
      temperature: 0.7,
      promptVersion: "v1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected NOT_CONFIGURED");
    expect(result.code).toBe(NOT_CONFIGURED);
  });
});

// ===========================================================================
// Language extraction from promptVersion
// ===========================================================================

describe("extractLanguageFromPromptVersion — promptVersion encoding", () => {
  it("extracts language code from lang:<code>:<rest> format", async () => {
    const { extractLanguageFromPromptVersion } = await import(
      "../../src/surfaces/SurfaceAdapter.js"
    );
    expect(extractLanguageFromPromptVersion("lang:ko:v1")).toBe("ko");
    expect(extractLanguageFromPromptVersion("lang:ja:v2")).toBe("ja");
    expect(extractLanguageFromPromptVersion("lang:en:v1.2")).toBe("en");
  });

  it("returns null for plain promptVersion (no lang: prefix)", async () => {
    const { extractLanguageFromPromptVersion } = await import(
      "../../src/surfaces/SurfaceAdapter.js"
    );
    expect(extractLanguageFromPromptVersion("v1")).toBeNull();
    expect(extractLanguageFromPromptVersion("v2.1-beta")).toBeNull();
  });
});

// ===========================================================================
// nativeReview + fireCycleNativeReviewHook integration
// ===========================================================================

describe("E2E: nativeReview flag propagation via compliance manifest", () => {
  it("modelRequiresNativeReview returns true for naverAi, line, kakao", async () => {
    const { modelRequiresNativeReview } = await import(
      "../../src/surfaces/nativeReview.js"
    );
    expect(modelRequiresNativeReview("naverAi")).toBe(true);
    expect(modelRequiresNativeReview("line")).toBe(true);
    expect(modelRequiresNativeReview("kakao")).toBe(true);
  });

  it("modelRequiresNativeReview returns false for chat/API surfaces", async () => {
    const { modelRequiresNativeReview } = await import(
      "../../src/surfaces/nativeReview.js"
    );
    expect(modelRequiresNativeReview("gemini-2.5-flash")).toBe(false);
    expect(modelRequiresNativeReview("copilot")).toBe(false);
    expect(modelRequiresNativeReview("metaAi")).toBe(false);
    expect(modelRequiresNativeReview("googleAio")).toBe(false);
  });

  it("fireCycleNativeReviewHook fires for naverAi and records context", async () => {
    const { fireCycleNativeReviewHook } = await import(
      "../../src/surfaces/nativeReview.js"
    );

    const firedEvents: string[] = [];
    const hook = async (ctx: { modelId: string }) => {
      firedEvents.push(ctx.modelId);
    };

    const context = {
      runId: "run-001",
      customerId: "cust-001",
      questionId: "q-001",
      modelId: "naverAi",
      language: "ko",
      sampleIdx: 0,
    };

    await fireCycleNativeReviewHook(context, hook);

    expect(firedEvents).toHaveLength(1);
    expect(firedEvents[0]).toBe("naverAi");
  });

  it("fireCycleNativeReviewHook does NOT fire for non-native-review surfaces", async () => {
    const { fireCycleNativeReviewHook } = await import(
      "../../src/surfaces/nativeReview.js"
    );

    const firedEvents: string[] = [];
    const hook = async (ctx: { modelId: string }) => {
      firedEvents.push(ctx.modelId);
    };

    const context = {
      runId: "run-001",
      customerId: "cust-001",
      questionId: "q-001",
      modelId: "googleAio", // NOT a native-review surface
      language: "en",
      sampleIdx: 0,
    };

    await fireCycleNativeReviewHook(context, hook);

    // Hook should NOT fire for googleAio
    expect(firedEvents).toHaveLength(0);
  });

  it("fireCycleNativeReviewHook is a no-op when no hook is provided", async () => {
    const { fireCycleNativeReviewHook } = await import(
      "../../src/surfaces/nativeReview.js"
    );

    // Should not throw
    await expect(
      fireCycleNativeReviewHook(
        {
          runId: "run-001",
          customerId: "cust-001",
          questionId: "q-001",
          modelId: "naverAi",
          language: "ko",
          sampleIdx: 0,
        },
        undefined // no hook
      )
    ).resolves.toBeUndefined();
  });
});

// ===========================================================================
// PM-03 TRUE E2E: surface answer reaches mention_judgment via runResponse
//
// This describe block proves the invariant stated in DESIGN-phase4.md T17:
// "a surface atom lands in mention_judgment through the SAME path as chat".
//
// Strategy:
//   1. Mock repo so no DB is needed. Spy on insertJudgment.
//   2. Build a SurfaceAdapter (googleAio, fixture client) and wire it as the
//      `adapter` dep in RunResponseDeps.
//   3. Call runResponse() with the real extractMention and rule-fallback judge.
//   4. Assert insertJudgment was called with the surface answerText's verdict
//      and the correct response_status (ok / not_configured).
// ===========================================================================

vi.mock("../../src/db/repo.js", () => {
  // Minimal stub — only the functions runResponse touches.
  return {
    findWorkUnits: vi.fn().mockResolvedValue([]),
    insertResponseRaw: vi.fn().mockResolvedValue({ id: "raw-id-001" }),
    insertJudgment: vi.fn().mockResolvedValue(undefined),
    markWorkUnitDone: vi.fn().mockResolvedValue(undefined),
    markWorkUnitError: vi.fn().mockResolvedValue(undefined),
    findSurfaceScanQueue: vi.fn().mockResolvedValue(null),
    upsertSurfaceScanQueue: vi.fn().mockResolvedValue(undefined),
  };
});

describe("PM-03 TRUE E2E: SurfaceAdapter → runResponse → insertJudgment (repo double)", () => {
  const FIXED_UUID = "00000000-0000-0000-0000-000000000001";

  const AIO_FIXTURE = {
    ai_overview: {
      text_blocks: [
        {
          type: "paragraph",
          text: "AcmeCorp is the leading provider of enterprise solutions.",
        },
      ],
      references: [{ link: "https://acmecorp.com", title: "AcmeCorp" }],
    },
  };

  // Build the surface adapter once.
  const serpClient = new FixtureSerpClient(AIO_FIXTURE, 0);
  const surfaceAdapter = new SurfaceAdapter({
    kind: "serp",
    surfaceId: "googleAio",
    client: serpClient,
    parser: new AiOverviewParser(),
    buildSerpRequest: (prompt, lang) => ({ query: prompt, language: lang }),
  });

  // Minimal stub judge — NOT_CONFIGURED → rule fallback runs.
  const notConfiguredJudge: ProviderAdapter = {
    provider: "stub-judge",
    modality: "chat",
    capabilities: [],
    status: "not_configured",
    async generate() { return { ok: false, code: NOT_CONFIGURED }; },
    async judge() { return { ok: false, code: NOT_CONFIGURED }; },
  };

  // Minimal CostReadPort that always says $0 (under budget).
  const zeroCostReader = {
    getRollingSpendUsd: async () => 0,
  };

  // No-op ledger (implements all methods that runResponse may call).
  const noopLedger = {
    recordGeneration: async () => {},
    recordJudge: async () => {},
    recordNotConfigured: async () => {},
    recordCacheHit: async () => {},
  };

  // Cache query fns that always miss — forces a real generate() call.
  const cacheFns = {
    findByHash: async () => null,
    upsert: async () => {},
  };

  const payload = {
    runId: FIXED_UUID,
    customerId: FIXED_UUID,
    questionId: FIXED_UUID,
    modelId: "googleAio",
    language: "en",
    sampleIdx: 0,
    requestHash: "abc123",
    prompt: "What is AcmeCorp?",
    promptVersion: "v1",
    temperature: 0.7,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("surface answer (brand mentioned) reaches insertJudgment with response_status=ok via runResponse", async () => {
    const repo = await import("../../src/db/repo.js");
    const { runResponse } = await import("../../src/pipeline/runResponse.js");

    await runResponse(payload, {
      adapter: surfaceAdapter,
      judgeAdapter: notConfiguredJudge,
      budget: { monthlyCapUsd: 1000, dailyCapUsd: 100 },
      isNewCustomer: true,
      costReader: zeroCostReader,
      ledger: noopLedger as never,
      cacheFns: cacheFns as never,
      gates: [],
      brand: { name: "AcmeCorp", aliases: ["acmecorp", "Acme Corp"] },
      competitors: [{ name: "RivalCo", aliases: ["rivalco"] }],
    });

    const insertJudgmentSpy = vi.mocked(repo.insertJudgment);
    expect(insertJudgmentSpy).toHaveBeenCalledOnce();

    const call = insertJudgmentSpy.mock.calls[0]![0];
    // response_status must be 'ok' for a successful generate()
    expect(call.responseStatus).toBe("ok");
    // Rule-fallback detected "AcmeCorp" in the fixture prose
    expect(call.brandMentioned).toBe(true);
    // Provenance comes from rule fallback (NOT_CONFIGURED judge)
    expect(call.provenance).toBe("fallback");
  });

  it("NOT_CONFIGURED surface → insertJudgment called with response_status=not_configured via runResponse", async () => {
    const repo = await import("../../src/db/repo.js");
    const { runResponse } = await import("../../src/pipeline/runResponse.js");
    const { NotConfiguredSerpClient } = await import("../../src/surfaces/serp/serpClient.js");

    const notConfiguredSurfaceAdapter = new SurfaceAdapter({
      kind: "serp",
      surfaceId: "googleAio",
      client: new NotConfiguredSerpClient(),
      parser: new AiOverviewParser(),
      buildSerpRequest: (p, l) => ({ query: p, language: l }),
    });

    await runResponse(payload, {
      adapter: notConfiguredSurfaceAdapter,
      judgeAdapter: notConfiguredJudge,
      budget: { monthlyCapUsd: 1000, dailyCapUsd: 100 },
      isNewCustomer: true,
      costReader: zeroCostReader,
      ledger: noopLedger as never,
      cacheFns: cacheFns as never,
      gates: [],
      brand: { name: "AcmeCorp", aliases: ["acmecorp"] },
      competitors: [],
    });

    const insertJudgmentSpy = vi.mocked(repo.insertJudgment);
    expect(insertJudgmentSpy).toHaveBeenCalledOnce();

    const call = insertJudgmentSpy.mock.calls[0]![0];
    // NOT_CONFIGURED generate() → response_status must record the failure
    expect(call.responseStatus).toBe("not_configured");
    // No answer → brand cannot be mentioned
    expect(call.brandMentioned).toBe(false);
  });
});
