/**
 * test/pipeline/baseline-resume.test.ts
 *
 * Gap-B — a big baseline (1000+ work-units) can't finish inside one rate-limited
 * CI window; the process is killed at the job timeout, leaving the run 'running'
 * with pending units. runCycle STEP 1 must RESUME that incomplete run instead of
 * spawning a fresh zombie every cycle, so coverage accumulates until complete.
 *
 * Verifies:
 *   1. When repo.findResumableRun returns a run → runCycle reuses its id and does
 *      NOT createRun / snapshotNTotal (frozen denominator §5.2) / startRun (preserve
 *      original started_at). Execution runs against the RESUMED run id.
 *   2. When it returns null → runCycle createRun + snapshotNTotal + startRun (fresh).
 *
 * Uses vi.mock to avoid DB (mocks repo + assembleReport), same harness as ics02.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/repo.js", () => ({
  findWorkUnits: vi.fn().mockResolvedValue([]),
  insertResponseRaw: vi.fn().mockResolvedValue({ id: "raw-001" }),
  insertJudgment: vi.fn().mockResolvedValue({ id: "j-001", captured_at: new Date() }),
  markWorkUnitDone: vi.fn().mockResolvedValue(undefined),
  markWorkUnitError: vi.fn().mockResolvedValue(undefined),
  markWorkUnitSkipped: vi.fn().mockResolvedValue(undefined),
  createRun: vi.fn().mockResolvedValue({ id: "fresh-run" }),
  findResumableRun: vi.fn().mockResolvedValue(null),
  // Default: every regenerated unit is treated as still-pending (has() → true), so
  // resume executes the whole (small) stub plan.
  findPendingWorkUnitKeys: vi.fn().mockResolvedValue({ has: () => true }),
  snapshotNTotal: vi.fn().mockResolvedValue(undefined),
  insertWorkUnit: vi.fn().mockResolvedValue(undefined),
  advanceRotationState: vi.fn().mockResolvedValue(undefined),
  startRun: vi.fn().mockResolvedValue(undefined),
  finishRun: vi.fn().mockResolvedValue(undefined),
  readRotationState: vi.fn().mockResolvedValue(-1),
  countWorkUnitsByStatus: vi.fn().mockResolvedValue({ pending: 0, done: 1, skipped: 0, error: 0 }),
  findRun: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/metrics/report.js", () => ({
  assembleReport: vi.fn().mockResolvedValue({
    runId: "x",
    smr: { value: 0, nTotal: 3, brandHits: 0 },
    abstainCount: 0,
  }),
}));

const CUSTOMER_ID = "00000000-0000-0000-0000-0000000000c1";
const QUESTION_ID = "00000000-0000-0000-0000-0000000000q1";

const STUB_QUESTION = {
  id: QUESTION_ID,
  customerId: CUSTOMER_ID,
  text: "What is the market leader?",
  densityTier: "core" as const,
  active: true,
  language: "en",
  promptTemplate: null,
};

// Chat model → always routes through responseRunHandler (no surface cache branch).
const STUB_MODEL = {
  id: "gemini-2.5-flash",
  provider: "gemini",
  modality: "chat" as const,
  capabilities: ["generate" as const],
  isCheapMonitor: false,
  isJudge: false,
  inputUsdPerMtok: 0,
  outputUsdPerMtok: 0,
  enabled: true,
};

const STUB_LANGUAGE = { customerId: CUSTOMER_ID, language: "en", weight: 1.0, isPriority: true };
const STUB_BUDGET = {
  customerId: CUSTOMER_ID,
  maxModels: 5,
  maxSamples: 3,
  maxLanguages: 5,
  weeklyUsdCap: 100,
  monthlyUsdCap: 300,
};
const STUB_ADAPTER = {
  provider: "gemini",
  modality: "chat" as const,
  capabilities: ["generate" as const],
  status: "ready" as const,
  async generate() { return { ok: false as const, code: "NOT_CONFIGURED" as const }; },
  async judge() { return { ok: false as const, code: "NOT_CONFIGURED" as const }; },
};
const STUB_JUDGE = { ...STUB_ADAPTER, status: "not_configured" as const };

const noopLedger = {
  recordGeneration: vi.fn().mockResolvedValue(undefined),
  recordJudge: vi.fn().mockResolvedValue(undefined),
  recordNotConfigured: vi.fn().mockResolvedValue(undefined),
  recordCacheHit: vi.fn().mockResolvedValue(undefined),
};

async function run(responseRunHandler: (p: unknown, d: unknown) => Promise<void>) {
  const { runCycle } = await import("../../src/pipeline/runCycle.js");
  await runCycle(
    { customerId: CUSTOMER_ID, kind: "baseline" },
    {
      responseRunHandler: responseRunHandler as never,
      customerSlug: "test-customer",
      brand: { name: "TestBrand", aliases: ["testbrand"] },
      competitors: [],
      questions: [STUB_QUESTION],
      models: [STUB_MODEL],
      languages: [STUB_LANGUAGE],
      budget: STUB_BUDGET,
      adapters: new Map([["gemini", STUB_ADAPTER]]),
      judgeAdapter: STUB_JUDGE,
      costReader: { getRollingSpendUsd: async () => 0 },
      ledger: noopLedger as never,
      cacheFns: { findByHash: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue(undefined) },
      gates: [],
      isNewCustomer: true,
    } as never,
  );
}

describe("Gap-B: baseline resume of an incomplete run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("RESUMES when findResumableRun returns a run — no createRun/snapshot/startRun; executes under the resumed id", async () => {
    const repo = await import("../../src/db/repo.js");
    vi.mocked(repo.findResumableRun).mockResolvedValue({ id: "resumed-run-123", nTotal: 3 });

    const seen: string[] = [];
    await run(async (payload) => { seen.push((payload as { runId: string }).runId); });

    // Reused the incomplete run, did not mint a new one.
    expect(repo.createRun).not.toHaveBeenCalled();
    // Denominator stays frozen (§5.2) and the clock is not reset.
    expect(repo.snapshotNTotal).not.toHaveBeenCalled();
    expect(repo.startRun).not.toHaveBeenCalled();
    // Execution ran against the RESUMED run id.
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["resumed-run-123"]));
    // The run is still finalized at the end of a completing cycle.
    expect(repo.finishRun).toHaveBeenCalledWith("resumed-run-123", "completed");
  });

  it("resume executes ONLY the frozen plan's pending units — units outside the pending set are excluded (§5.2 numerator⊆denominator)", async () => {
    const repo = await import("../../src/db/repo.js");
    vi.mocked(repo.findResumableRun).mockResolvedValue({ id: "resumed-run-123", nTotal: 3 });
    // Only sampleIdx=0 is still pending in the DB; 1 & 2 are already done (or would
    // be new units from an enlarged plan). They must NOT execute.
    const onlySample0 = new Set([`${QUESTION_ID}|gemini-2.5-flash|en|0`]);
    vi.mocked(repo.findPendingWorkUnitKeys).mockResolvedValue(onlySample0);

    let calls = 0;
    await run(async () => { calls++; });

    expect(calls).toBe(1); // exactly the one pending unit, not all 3
    expect(repo.insertWorkUnit).not.toHaveBeenCalled(); // no re-insert on resume
    expect(repo.snapshotNTotal).not.toHaveBeenCalled(); // denominator stays frozen
  });

  it("resume matching ZERO pending units leaves the run resumable — no finishRun, no execution", async () => {
    const repo = await import("../../src/db/repo.js");
    vi.mocked(repo.findResumableRun).mockResolvedValue({ id: "resumed-run-123", nTotal: 3 });
    vi.mocked(repo.findPendingWorkUnitKeys).mockResolvedValue(new Set()); // nothing matches

    let calls = 0;
    await run(async () => { calls++; });

    expect(calls).toBe(0);
    expect(repo.finishRun).not.toHaveBeenCalled(); // NOT wrongly marked completed
    expect(repo.createRun).not.toHaveBeenCalled();
  });

  it("creates a FRESH run when findResumableRun returns null", async () => {
    const repo = await import("../../src/db/repo.js");
    vi.mocked(repo.findResumableRun).mockResolvedValue(null);

    const seen: string[] = [];
    await run(async (payload) => { seen.push((payload as { runId: string }).runId); });

    expect(repo.createRun).toHaveBeenCalledOnce();
    expect(repo.snapshotNTotal).toHaveBeenCalled();
    expect(repo.startRun).toHaveBeenCalledWith("fresh-run");
    expect(new Set(seen)).toEqual(new Set(["fresh-run"]));
  });

  it("only baseline resumes — operating never calls findResumableRun", async () => {
    const repo = await import("../../src/db/repo.js");
    const { runCycle } = await import("../../src/pipeline/runCycle.js");
    vi.mocked(repo.findResumableRun).mockResolvedValue({ id: "should-not-be-used", nTotal: 3 });

    await runCycle(
      { customerId: CUSTOMER_ID, kind: "operating" },
      {
        responseRunHandler: (async () => {}) as never,
        customerSlug: "test-customer",
        brand: { name: "TestBrand", aliases: ["testbrand"] },
        competitors: [],
        questions: [STUB_QUESTION],
        models: [STUB_MODEL],
        languages: [STUB_LANGUAGE],
        budget: STUB_BUDGET,
        adapters: new Map([["gemini", STUB_ADAPTER]]),
        judgeAdapter: STUB_JUDGE,
        costReader: { getRollingSpendUsd: async () => 0 },
        ledger: noopLedger as never,
        cacheFns: { findByHash: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue(undefined) },
        gates: [],
        isNewCustomer: true,
      } as never,
    );

    expect(repo.findResumableRun).not.toHaveBeenCalled();
    expect(repo.createRun).toHaveBeenCalledOnce();
  });
});
