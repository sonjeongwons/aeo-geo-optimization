/**
 * test/pipeline/ics02-carry-forward.test.ts
 *
 * ICS-02 — Surface cache carry-forward copies prior judgment brand_mentioned.
 *
 * Verifies that when runCycle PATH A encounters a cross-cycle cache hit for a
 * non-chat (serp/scrape) surface, it copies the prior judgment's brand_mentioned
 * (and other fields) into the new 'cached' judgment row — instead of writing a
 * conservative abstain that silently depresses SMR.
 *
 * Uses vi.mock to avoid DB connections (mocks repo and assembleReport).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock repo to avoid DB connection.
vi.mock("../../src/db/repo.js", () => ({
  findWorkUnits: vi.fn().mockResolvedValue([]),
  insertResponseRaw: vi.fn().mockResolvedValue({ id: "raw-id-cached-001" }),
  insertJudgment: vi.fn().mockResolvedValue({ id: "j-001", captured_at: new Date() }),
  markWorkUnitDone: vi.fn().mockResolvedValue(undefined),
  markWorkUnitError: vi.fn().mockResolvedValue(undefined),
  markWorkUnitSkipped: vi.fn().mockResolvedValue(undefined),
  createRun: vi.fn().mockResolvedValue({ id: "run-001" }),
  snapshotNTotal: vi.fn().mockResolvedValue(undefined),
  insertWorkUnit: vi.fn().mockResolvedValue(undefined),
  advanceRotationState: vi.fn().mockResolvedValue(undefined),
  startRun: vi.fn().mockResolvedValue(undefined),
  finishRun: vi.fn().mockResolvedValue(undefined),
  readRotationState: vi.fn().mockResolvedValue(-1),
  countWorkUnitsByStatus: vi.fn().mockResolvedValue({ pending: 0, done: 1, skipped: 0, error: 0 }),
  findRun: vi.fn().mockResolvedValue(null),
}));

// Mock assembleReport to avoid pulling in pg/kysely at module init.
vi.mock("../../src/metrics/report.js", () => ({
  assembleReport: vi.fn().mockResolvedValue({
    runId: "run-001",
    smr: { value: 0, nTotal: 1, brandHits: 0 },
    abstainCount: 1,
  }),
}));

const FIXED_RUN_ID = "00000000-0000-0000-0000-000000000001";
const FIXED_CUSTOMER_ID = "00000000-0000-0000-0000-000000000002";
const FIXED_QUESTION_ID = "00000000-0000-0000-0000-000000000003";

const STUB_QUESTION = {
  id: FIXED_QUESTION_ID,
  customerId: FIXED_CUSTOMER_ID,
  text: "Who is the market leader?",
  densityTier: "core" as const,
  active: true,
  language: "en",
  promptTemplate: null,
};

const STUB_MODEL = {
  id: "googleAio",
  provider: "googleAio",
  modality: "serp" as const,
  capabilities: ["generate" as const],
  isCheapMonitor: false,
  isJudge: false,
  inputUsdPerMtok: 0,
  outputUsdPerMtok: 0,
  enabled: true,
};

const STUB_LANGUAGE = {
  customerId: FIXED_CUSTOMER_ID,
  language: "en",
  weight: 1.0,
  isPriority: true,
};

const STUB_BUDGET = {
  customerId: FIXED_CUSTOMER_ID,
  maxModels: 5,
  maxSamples: 3,
  maxLanguages: 5,
  weeklyUsdCap: 100,
  monthlyUsdCap: 300,
};

const STUB_ADAPTER = {
  provider: "googleAio",
  modality: "serp" as const,
  capabilities: ["generate" as const],
  status: "ready" as const,
  async generate() { return { ok: false as const, code: "NOT_CONFIGURED" as const }; },
  async judge() { return { ok: false as const, code: "NOT_CONFIGURED" as const }; },
};

const STUB_JUDGE_ADAPTER = {
  provider: "gemini",
  modality: "chat" as const,
  capabilities: [] as const,
  status: "not_configured" as const,
  async generate() { return { ok: false as const, code: "NOT_CONFIGURED" as const }; },
  async judge() { return { ok: false as const, code: "NOT_CONFIGURED" as const }; },
};

/**
 * Build cacheFns that serve a single pre-seeded cross-cycle cache hit.
 *
 * runCycle calls createResponseCache(cacheFns) internally. The cache's
 * findByHash must return { answerText, createdAt } (not the discriminated union
 * from ResponseCache.check) so the TTL logic inside createResponseCache works.
 */
function makeSeedCacheFns(requestHash: string, answerText: string) {
  const entry = { answerText, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) };
  return {
    findByHash: async (hash: string) =>
      hash === requestHash ? entry : null,
    upsert: async () => {},
  };
}

describe("ICS-02: surface cache carry-forward copies prior judgment", () => {
  const noopLedger = {
    recordGeneration: vi.fn().mockResolvedValue(undefined),
    recordJudge: vi.fn().mockResolvedValue(undefined),
    recordNotConfigured: vi.fn().mockResolvedValue(undefined),
    recordCacheHit: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carry-forward with prior judgment brand_mentioned=true → writes brand_mentioned=true (not false)", async () => {
    const { runCycle } = await import("../../src/pipeline/runCycle.js");
    const repo = await import("../../src/db/repo.js");

    // Re-apply mock defaults after clearAllMocks().
    vi.mocked(repo.findWorkUnits).mockResolvedValue([]);
    vi.mocked(repo.insertResponseRaw).mockResolvedValue({ id: "raw-id-cached-001" } as never);
    vi.mocked(repo.insertJudgment).mockResolvedValue({ id: "j-001", captured_at: new Date() } as never);
    vi.mocked(repo.markWorkUnitDone).mockResolvedValue(undefined);
    vi.mocked(repo.createRun).mockResolvedValue({ id: "run-001" } as never);
    vi.mocked(repo.snapshotNTotal).mockResolvedValue(undefined);
    vi.mocked(repo.insertWorkUnit).mockResolvedValue(undefined);
    vi.mocked(repo.startRun).mockResolvedValue(undefined);
    vi.mocked(repo.finishRun).mockResolvedValue(undefined);
    vi.mocked(repo.readRotationState).mockResolvedValue(-1);

    // The plan builder will compute a request_hash for (googleAio, en, prompt, 0.7, v1).
    // We seed the cache using the SAME hash the plan will compute, so it finds a hit.
    // Since we don't know the exact hash in advance, we seed "all hashes" by returning
    // the entry for any hash.
    const entry = { answerText: "TestBrand is the market leader.", createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) };
    const cacheFns = {
      findByHash: vi.fn().mockResolvedValue(entry),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    const priorJudgment = {
      brand_mentioned: true,
      brand_rank: 1,
      sentiment: "positive" as const,
      competitors_found: [{ name: "RivalCo", rank: 2 }],
      evidence_quote: "TestBrand is the market leader.",
      evidence_start: 0,
      evidence_end: 32,
      provenance: "judge" as const,
    };

    const responseRunHandler = vi.fn(async () => {});

    await runCycle(
      { runId: FIXED_RUN_ID, customerId: FIXED_CUSTOMER_ID, kind: "baseline" },
      {
        responseRunHandler,
        customerSlug: "test-customer",
        brand: { name: "TestBrand", aliases: ["testbrand"] },
        competitors: [],
        questions: [STUB_QUESTION],
        models: [STUB_MODEL],
        languages: [STUB_LANGUAGE],
        budget: STUB_BUDGET,
        adapters: new Map([["googleAio", STUB_ADAPTER]]),
        judgeAdapter: STUB_JUDGE_ADAPTER,
        costReader: { getRollingSpendUsd: async () => 0 },
        ledger: noopLedger as never,
        cacheFns,
        gates: [],
        isNewCustomer: true,
        // ICS-02: findPriorJudgmentByHash returns a prior brand_mentioned=true judgment.
        findPriorJudgmentByHash: vi.fn().mockResolvedValue(priorJudgment),
      },
    );

    // The responseRunHandler must NOT have been called (carry-forward path handled it).
    expect(responseRunHandler).not.toHaveBeenCalled();

    const insertJudgmentSpy = vi.mocked(repo.insertJudgment);
    expect(insertJudgmentSpy).toHaveBeenCalledOnce();

    const call = insertJudgmentSpy.mock.calls[0]![0];
    // CRITICAL: brand_mentioned must be TRUE (carried from prior judgment, NOT reset to false).
    expect(call.brandMentioned).toBe(true);
    // Additional fields carried forward.
    expect(call.brandRank).toBe(1);
    expect(call.sentiment).toBe("positive");
    // response_status is 'cached' (correct for carry-forward).
    expect(call.responseStatus).toBe("cached");
    // No judge call was made → provenance is 'abstain' (honest: no re-judge this cycle).
    expect(call.provenance).toBe("abstain");
  });

  it("carry-forward with NO prior judgment → writes brand_mentioned=false (conservative abstain)", async () => {
    const { runCycle } = await import("../../src/pipeline/runCycle.js");
    const repo = await import("../../src/db/repo.js");

    vi.mocked(repo.findWorkUnits).mockResolvedValue([]);
    vi.mocked(repo.insertResponseRaw).mockResolvedValue({ id: "raw-id-cached-002" } as never);
    vi.mocked(repo.insertJudgment).mockResolvedValue({ id: "j-002", captured_at: new Date() } as never);
    vi.mocked(repo.markWorkUnitDone).mockResolvedValue(undefined);
    vi.mocked(repo.createRun).mockResolvedValue({ id: "run-002" } as never);
    vi.mocked(repo.snapshotNTotal).mockResolvedValue(undefined);
    vi.mocked(repo.insertWorkUnit).mockResolvedValue(undefined);
    vi.mocked(repo.startRun).mockResolvedValue(undefined);
    vi.mocked(repo.finishRun).mockResolvedValue(undefined);
    vi.mocked(repo.readRotationState).mockResolvedValue(-1);

    const entry = { answerText: "Some answer text.", createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) };
    const cacheFns = {
      findByHash: vi.fn().mockResolvedValue(entry),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    const responseRunHandler = vi.fn(async () => {});

    await runCycle(
      { runId: FIXED_RUN_ID, customerId: FIXED_CUSTOMER_ID, kind: "baseline" },
      {
        responseRunHandler,
        customerSlug: "test-customer",
        brand: { name: "TestBrand", aliases: [] },
        competitors: [],
        questions: [STUB_QUESTION],
        models: [STUB_MODEL],
        languages: [STUB_LANGUAGE],
        budget: STUB_BUDGET,
        adapters: new Map([["googleAio", STUB_ADAPTER]]),
        judgeAdapter: STUB_JUDGE_ADAPTER,
        costReader: { getRollingSpendUsd: async () => 0 },
        ledger: noopLedger as never,
        cacheFns,
        gates: [],
        isNewCustomer: true,
        // findPriorJudgmentByHash returns null → conservative abstain.
        findPriorJudgmentByHash: vi.fn().mockResolvedValue(null),
      },
    );

    const insertJudgmentSpy = vi.mocked(repo.insertJudgment);
    expect(insertJudgmentSpy).toHaveBeenCalledOnce();

    const call = insertJudgmentSpy.mock.calls[0]![0];
    // No prior judgment → conservative abstain (brand_mentioned=false).
    expect(call.brandMentioned).toBe(false);
    expect(call.provenance).toBe("abstain");
  });

  it("carry-forward when findPriorJudgmentByHash is NOT wired → falls back to conservative abstain (backward compat)", async () => {
    const { runCycle } = await import("../../src/pipeline/runCycle.js");
    const repo = await import("../../src/db/repo.js");

    vi.mocked(repo.findWorkUnits).mockResolvedValue([]);
    vi.mocked(repo.insertResponseRaw).mockResolvedValue({ id: "raw-id-cached-003" } as never);
    vi.mocked(repo.insertJudgment).mockResolvedValue({ id: "j-003", captured_at: new Date() } as never);
    vi.mocked(repo.markWorkUnitDone).mockResolvedValue(undefined);
    vi.mocked(repo.createRun).mockResolvedValue({ id: "run-003" } as never);
    vi.mocked(repo.snapshotNTotal).mockResolvedValue(undefined);
    vi.mocked(repo.insertWorkUnit).mockResolvedValue(undefined);
    vi.mocked(repo.startRun).mockResolvedValue(undefined);
    vi.mocked(repo.finishRun).mockResolvedValue(undefined);
    vi.mocked(repo.readRotationState).mockResolvedValue(-1);

    const entry = { answerText: "Some answer text.", createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) };
    const cacheFns = {
      findByHash: vi.fn().mockResolvedValue(entry),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    const responseRunHandler = vi.fn(async () => {});

    await runCycle(
      { runId: FIXED_RUN_ID, customerId: FIXED_CUSTOMER_ID, kind: "baseline" },
      {
        responseRunHandler,
        customerSlug: "test-customer",
        brand: { name: "TestBrand", aliases: [] },
        competitors: [],
        questions: [STUB_QUESTION],
        models: [STUB_MODEL],
        languages: [STUB_LANGUAGE],
        budget: STUB_BUDGET,
        adapters: new Map([["googleAio", STUB_ADAPTER]]),
        judgeAdapter: STUB_JUDGE_ADAPTER,
        costReader: { getRollingSpendUsd: async () => 0 },
        ledger: noopLedger as never,
        cacheFns,
        gates: [],
        isNewCustomer: true,
        // findPriorJudgmentByHash is NOT provided (undefined) → backward compat.
      },
    );

    const insertJudgmentSpy = vi.mocked(repo.insertJudgment);
    expect(insertJudgmentSpy).toHaveBeenCalledOnce();

    const call = insertJudgmentSpy.mock.calls[0]![0];
    // No DI function → conservative abstain (backward compat).
    expect(call.brandMentioned).toBe(false);
    expect(call.provenance).toBe("abstain");
  });
});
