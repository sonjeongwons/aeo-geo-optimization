/**
 * src/pipeline/runCycle.ts
 *
 * runCycle — orchestrates one full AEO/GEO measurement cycle.
 *
 * DESIGN.md T13 / "PLAN → fan-out → aggregate" steps:
 *
 *   1. budget.preflight  — pre-run USD cap check; sets run.status='over_budget' on reject.
 *   2. buildPlan         — pure sampling logic (sampling/plan.ts); expands run into work-units.
 *   3. snapshot n_total  — repo.snapshotNTotal() BEFORE any execution (§5.2 denominator freeze).
 *   4. persist work-units — repo.insertWorkUnit() per unit (idempotent via PK ON CONFLICT DO NOTHING).
 *   5. advance rotation  — repo.advanceRotationState() for tiers scheduled this cycle.
 *   6. run.status → 'running' — repo.startRun().
 *   7. fan-out           — enqueue one response.run job per pending work-unit (idempotent
 *                          via work_unit PK; re-enqueueing a done unit is a no-op because
 *                          runResponse checks status='done' first).
 *   8. completion poll   — on synchronous (baseline) path, execute work-units in-process
 *                          and detect completion; on asynchronous (operating) path, the
 *                          cycle.aggregate handler is invoked by the worker after the last
 *                          response.run job, or by the caller after inline execution.
 *   9. aggregate + report — assembleReport() after all units are complete.
 *  10. finish run        — repo.finishRun() with 'completed'/'failed'/'over_budget'.
 *
 * ## Resumability
 *
 * Crash recovery works as follows:
 *   - If the run exists and n_total is already set, skip steps 2-5.
 *   - insertWorkUnit uses ON CONFLICT DO NOTHING, so re-persisting the plan is safe.
 *   - response.run jobs are enqueued only for units whose status is 'pending'.
 *   - runResponse() itself checks work_unit.status='done' and returns immediately
 *     for already-completed units (DESIGN §5.3 idempotent resume).
 *
 * ## Sync vs async fan-out
 *
 * For BASELINE runs the caller may choose to run in-process (no queue) by providing
 * a `responseRunHandler` in the deps.  The handler is called sequentially for each
 * pending work-unit and the cycle completes before returning.  This is the path used
 * by `npm run diagnose` and `POST /diagnose`.
 *
 * For OPERATING runs the fan-out goes through the durable pg-boss queue (via the
 * `queue` parameter).  The cycle.aggregate job is enqueued after all response.run
 * jobs are emitted; the aggregate worker picks it up asynchronously.
 *
 * ## Over-budget handling
 *
 * - preflight() rejects → run.status='over_budget' → returns immediately.
 * - A mid-cycle BudgetExceededError / CostDataMissingError from runResponse bubbles
 *   out of the inline handler (baseline) or is caught per-job (operating).  The cycle
 *   sets run.status='over_budget' or 'failed' accordingly.
 *
 * ## NOT_CONFIGURED providers
 *
 * buildPlan receives only models with status='ready' (i.e. the caller filters the
 * model list to exclude providers whose adapters return NOT_CONFIGURED).  Therefore
 * no work-units are ever created for unconfigured providers (DESIGN §5.3 / T13
 * acceptance criterion).
 */

import pino from "pino";
import Bottleneck from "bottleneck";

import { buildPlan, PLAN_TEMPERATURE } from "../sampling/plan.js";
import {
  preflight,
  estimateSurfacePlanCost,
  buildPlanCostBreakdown,
} from "../cost/budget.js";
import { createResponseCache } from "../cost/cache.js";
import { Ledger } from "../cost/ledger.js";
import { assembleReport } from "../metrics/report.js";
import { BudgetExceededError, CostDataMissingError } from "../domain/errors.js";
import { surfaceUsdPerCall } from "../surfaces/surfacePricing.js";
import * as repo from "../db/repo.js";
import {
  fireCycleNativeReviewHook,
  type CycleNativeReviewHook,
  type NativeReviewContext,
} from "../surfaces/nativeReview.js";

import {
  JOB_NAMES,
  type CyclePlanPayload,
  type CycleAggregatePayload,
} from "../scheduler/jobs.js";
import type { JobQueue } from "../scheduler/queue.js";
import type { CostReadPort } from "../cost/budget.js";
import type { CacheQueryFns } from "../cost/cache.js";
import type { Gate } from "../guardrails/gate.js";
import type { ProviderAdapter } from "../providers/types.js";
import type {
  Budget,
  Question,
  ModelRef,
  CustomerLanguage,
  DensityTier,
  RunKind,
} from "../domain/types.js";
import type { RunReport } from "../domain/metrics.types.js";
import type { RotationState } from "../sampling/rotation.js";
import type { RunResponseDeps } from "./runResponse.js";
import { runResponse } from "./runResponse.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = pino({ name: "pipeline.runCycle" });

// ---------------------------------------------------------------------------
// RunCycleDeps — all external dependencies needed by runCycle
// ---------------------------------------------------------------------------

/**
 * Everything runCycle needs, injected by the caller (worker.ts / cli/diagnose.ts).
 *
 * Separating deps allows tests to inject lightweight doubles without wiring
 * a real pg-boss queue or provider adapters.
 */
export interface RunCycleDeps {
  /**
   * The durable job queue (pg-boss).
   * Used for enqueueing response.run and cycle.aggregate jobs on the operating path.
   * MAY be omitted on the synchronous baseline path when responseRunHandler is provided.
   */
  queue?: JobQueue;

  /**
   * Inline response handler (for synchronous / baseline execution).
   *
   * When provided, runCycle executes work-units directly in-process instead of
   * enqueueing response.run jobs.  This is the path used by `npm run diagnose`.
   *
   * The handler receives the same payload that would be sent to the response.run
   * queue, plus the full RunResponseDeps bundle.
   *
   * If absent AND `queue` is present, jobs are enqueued asynchronously.
   * At least one of (queue | responseRunHandler) MUST be provided.
   */
  responseRunHandler?: (
    payload: import("../scheduler/jobs.js").ResponseRunPayload,
    runResponseDeps: RunResponseDeps,
  ) => Promise<void>;

  // ---- Customer / run context ----

  /** Customer slug (for log messages). */
  customerSlug: string;

  /** Brand info for the judge. */
  brand: {
    name: string;
    aliases: string[];
  };

  /** Tracked competitors. */
  competitors: Array<{ name: string; aliases: string[] }>;

  // ---- Sampling inputs ----

  /** All active questions for the customer. */
  questions: Question[];

  /**
   * Available enabled models — MUST already be filtered to only include models
   * whose provider adapters have status='ready' (DESIGN §5.3 / T13 acceptance:
   * NOT_CONFIGURED providers produce no work_units — excluded at plan time).
   */
  models: ModelRef[];

  /** Customer language rows (with weights). */
  languages: CustomerLanguage[];

  /** Customer budget caps (read from DB before starting the cycle). */
  budget: Budget;

  // ---- Provider adapters ----

  /**
   * Map from model ID → ProviderAdapter.
   * Only adapters with status='ready' should appear here.
   * Used when resolving adapters per work-unit in the inline path.
   */
  adapters: Map<string, ProviderAdapter>;

  /**
   * The Gemini adapter used as LLM judge.
   * Passed to runResponse regardless of which model is used for generation.
   */
  judgeAdapter: ProviderAdapter;

  // ---- Cost ----

  /**
   * Cost read port (seam for the budget assertion).
   * Production: backed by a wrapper over repo.sumCostSince.
   */
  costReader: CostReadPort;

  /** Ledger for writing llm_call rows. */
  ledger: Ledger;

  /** DB cache query functions (for cross-cycle dedup). */
  cacheFns: CacheQueryFns;

  // ---- Guardrail gates ----

  /** Ordered list of measurement-phase gates (injected, not hard-imported). */
  gates: readonly Gate[];

  // ---- Per-provider Bottleneck limiters ----

  /**
   * Per-provider rate limiters (Bottleneck).
   * If absent, calls are made without rate limiting (test/baseline use case).
   */
  limiters?: Map<string, Bottleneck>;

  /**
   * Whether this is a new customer with no prior spend history.
   * Passed to assertWithinCapOrNew so the first call isn't blocked by missing CAGG data.
   */
  isNewCustomer?: boolean;

  /**
   * Monotonic cycle index for rotation cursor advancement.
   * For baseline runs this should be 0.
   * For operating runs the caller should supply the current run count.
   */
  currentCycleIndex?: number;

  /**
   * Optional advisory native-review hook (T14).
   *
   * When provided, this is called after each work-unit completes for a
   * market-language surface that requires native-speaker review (naverAi,
   * line, kakao per COMPLIANCE_MANIFEST).
   *
   * ADVISORY ONLY — the hook MUST NOT alter SMR calculation:
   *   - Hook errors are caught and logged; they do NOT abort the cycle.
   *   - Whether the hook fires or not, the SMR values are IDENTICAL.
   *   - All response_raw + mention_judgment rows are written BEFORE the hook
   *     fires (PATH A), or the hook fires at enqueue time (PATH B).
   *
   * Typical use cases:
   *   - Insert into a native-review queue table.
   *   - Send a notification to a human review team.
   *   - Log for audit trail.
   */
  onNativeReview?: CycleNativeReviewHook;

  /**
   * ICS-02: Look up the latest current_judgment for a prior response_raw that
   * shares the given request_hash (from a different run than runId).
   *
   * Used by the surface cache carry-forward path (PATH A) to propagate the
   * prior cycle's brand_mentioned / brand_rank / sentiment / competitors_found /
   * evidence into the new cached judgment row — instead of writing a conservative
   * abstain that silently depresses SMR.
   *
   * The production implementation queries:
   *   SELECT cj.*
   *   FROM response_raw rr
   *   JOIN current_judgment cj ON cj.response_raw_id = rr.id
   *   WHERE rr.request_hash = $requestHash
   *     AND rr.run_id <> $excludeRunId   -- exclude the current run
   *     AND rr.status IN ('ok', 'cached') -- only rows with actual answer text
   *   ORDER BY rr.captured_at DESC
   *   LIMIT 1
   *
   * If no prior judgment exists, returns null — the caller then falls back to
   * the conservative abstain (brand_mentioned=false, provenance='abstain').
   *
   * Optional: when absent, the carry-forward path falls back to abstain
   * (same behavior as before ICS-02). The production wire in src/index.ts
   * SHOULD supply this to fix the SMR-depression defect.
   */
  findPriorJudgmentByHash?: (
    requestHash: string,
    excludeRunId: string,
  ) => Promise<{
    brand_mentioned: boolean;
    brand_rank: number | null;
    sentiment: "positive" | "neutral" | "negative" | null;
    competitors_found: unknown;
    evidence_quote: string | null;
    evidence_start: number | null;
    evidence_end: number | null;
    provenance: "judge" | "fallback" | "abstain";
  } | null>;
}

// ---------------------------------------------------------------------------
// runCycle — main export
// ---------------------------------------------------------------------------

/**
 * Orchestrate one full cycle: plan → fan-out → aggregate → finish.
 *
 * @param payload  - The cycle.plan job payload (customerId, kind).
 * @param deps     - All external dependencies (adapters, DB, queue, etc.).
 * @returns        - The assembled RunReport (available immediately on the sync path;
 *                   on the async path the caller should await the cycle.aggregate job).
 */
export async function runCycle(
  payload: CyclePlanPayload,
  deps: RunCycleDeps,
): Promise<RunReport | null> {
  const { customerId, kind } = payload;
  const {
    queue,
    responseRunHandler,
    customerSlug,
    brand,
    competitors,
    questions,
    models,
    languages,
    budget,
    adapters,
    judgeAdapter,
    costReader,
    ledger,
    cacheFns,
    gates,
    limiters,
    isNewCustomer = false,
    currentCycleIndex = 0,
    onNativeReview,
    findPriorJudgmentByHash,
  } = deps;

  log.info({ customerId, customerSlug, kind }, "runCycle: starting");

  // -------------------------------------------------------------------------
  // STEP 1 — Resume an incomplete run, or create a new one.
  //
  // A big baseline (e.g. a multilingual customer with 1000+ work-units) can't
  // finish inside one rate-limited CI window; the process is killed at the job
  // timeout, leaving the run 'running' with pending units. Rather than spawn a
  // fresh zombie every week (never completing, showing near-zero coverage), we
  // RESUME the incomplete run so coverage accumulates across cycles until the
  // plan is fully executed, then a subsequent cycle starts a fresh baseline.
  //
  // Only baseline resumes: operating runs advance rotation cursors (STEP 6) and
  // are small enough to finish in one window, so resuming them would double-count
  // cursor advancement. Resume is safe because buildPlan is DETERMINISTIC (same
  // questions/models/langs → same work-units + request_hashes), insertWorkUnit is
  // idempotent (ON CONFLICT DO NOTHING), and runResponse skips already-'done' units.
  // -------------------------------------------------------------------------
  const resumable =
    kind === "baseline" ? await repo.findResumableRun(customerId, kind) : null;

  let runId: string;
  const resuming = resumable !== null;
  if (resumable) {
    runId = resumable.id;
    log.info(
      { runId, customerId, kind, frozenNTotal: resumable.nTotal },
      "runCycle: RESUMING incomplete run (pending work-units remain from a prior cycle)",
    );
  } else {
    const runRow = await repo.createRun({
      customerId,
      kind,
      nSamples: budget.maxSamples,
      temperature: PLAN_TEMPERATURE,
    });
    runId = runRow.id;
    log.info({ runId, customerId, kind }, "runCycle: run created");
  }

  // -------------------------------------------------------------------------
  // STEP 2 — Build the plan (pure, no IO).
  // -------------------------------------------------------------------------

  // Load rotation states for all density tiers.
  const tiers: DensityTier[] = ["core", "secondary", "longtail"];
  const rotationStateEntries = await Promise.all(
    tiers.map(async (tier) => {
      const idx = await repo.readRotationState(customerId, tier);
      return [
        tier,
        {
          customerId,
          densityTier: tier,
          lastCycleIndex: idx,
        } satisfies RotationState,
      ] as [DensityTier, RotationState];
    }),
  );
  const rotationStates = new Map<DensityTier, RotationState>(rotationStateEntries);

  const planOutput = buildPlan({
    runId,
    customerId,
    kind,
    questions,
    models,
    languages,
    budget,
    currentCycleIndex,
    rotationStates,
  });

  const { workUnits, nTotal, nextRotationStates, languageTrimCount } = planOutput;

  log.info(
    {
      runId,
      nTotal,
      languageTrimCount,
      kind,
      tiersScheduled: nextRotationStates.size,
    },
    "runCycle: plan built",
  );

  // -------------------------------------------------------------------------
  // STEP 2b — Resolve which units to EXECUTE this invocation.
  //
  // Fresh run: the whole plan.
  // RESUME: only the frozen plan's still-'pending' units. We filter the freshly
  // regenerated (deterministic) plan down to the DB's pending set. This is the
  // correctness backbone of resume:
  //   - a unit the DB doesn't have pending (already 'done', or 'error', or NEVER
  //     part of the frozen plan because the active-question set grew) is EXCLUDED
  //     → the SMR numerator can never exceed the frozen n_total denominator (§5.2),
  //     and surface carry-forward can't re-process a done unit (no double-count).
  // Persist (STEP 5) is skipped on resume, so no new rows leak past n_total either.
  // -------------------------------------------------------------------------
  const wuKey = (wu: { questionId: string; modelId: string; language: string; sampleIdx: number }) =>
    `${wu.questionId}|${wu.modelId}|${wu.language}|${wu.sampleIdx}`;

  let executableUnits = workUnits;
  if (resuming) {
    const pendingKeys = await repo.findPendingWorkUnitKeys(runId);
    executableUnits = workUnits.filter((wu) => pendingKeys.has(wuKey(wu)));
    log.info(
      { runId, frozenNTotal: resumable?.nTotal, regeneratedNTotal: nTotal, pendingToRun: executableUnits.length },
      "runCycle: resume — executing frozen plan's remaining pending units only",
    );
    if (executableUnits.length === 0) {
      // No regenerated unit intersects the DB pending set (e.g. the question set
      // was replaced). Do NOT finishRun('completed') — that would strand real
      // pending units against the frozen denominator. Leave the run 'running' so a
      // later cycle (with a matching plan) can still resume it.
      log.warn(
        { runId, customerId },
        "runCycle: resume matched zero pending units — leaving run resumable, no work this cycle",
      );
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // STEP 3 — budget.preflight: check estimated USD before any execution.
  //
  // Surface-aware estimate (Phase 4 T15):
  //   - Chat (api modality) units: avg generation + judge cost.
  //   - SERP units: flat surface rate (from surfacePricing.ts) + judge cost.
  //   - Scrape units: $0 gen (RPA infra billed externally) + judge cost.
  //
  // This is more accurate than a flat per-unit estimate for cycles that
  // include a mix of chat and SERP/scrape surfaces.
  //
  // DESIGN §11: "preflight() rejects → run.status='over_budget'".
  // -------------------------------------------------------------------------

  // Rough per-unit cost estimate: generation + judge at flash-lite prices.
  // $0.000075/1K input + $0.0003/1K output at ~500 tok in/~300 tok out ≈ $0.0001/call.
  // Two calls (gen + judge) ≈ $0.0002/unit.  We use a conservative $0.001 per unit.
  const AVG_GEN_USD = 0.0005;
  const AVG_JUDGE_USD = 0.0005;

  // Build a modality map from the models list so buildPlanCostBreakdown can
  // classify each work-unit as chat / serp / scrape.
  const modalityMap = new Map(
    models.map((m) => [m.id, { modality: m.modality }] as const),
  );

  // Surface-aware cost breakdown — over the units actually to be EXECUTED this
  // invocation (on resume, the remaining pending units, NOT the whole plan — else
  // the estimate would over-count already-done work and spuriously trip the cap).
  const costBreakdown = buildPlanCostBreakdown(executableUnits, modalityMap);
  const estimatedUsd = estimateSurfacePlanCost(
    costBreakdown,
    AVG_GEN_USD,
    AVG_JUDGE_USD,
    // surfaceUsdPerCall accepts SurfaceId; cast string → SurfaceId here since
    // buildPlanCostBreakdown populates nSerpUnitsBySurface with model IDs that
    // ARE surface IDs for serp-modality models.
    (id) => surfaceUsdPerCall(id as import("../surfaces/types.js").SurfaceId),
  );

  const preflightResult = await preflight({
    customerId,
    budget,
    estimatedUsd,
    costReader,
  });

  if (!preflightResult.ok) {
    // On RESUME, do NOT flip the run to 'over_budget' — that status is not
    // resumable, so a single tight-budget cycle would permanently strand the
    // accumulated coverage + frozen denominator. Leave it 'running' so the next
    // cycle (after the weekly/monthly cap resets) resumes it. Fresh runs finalize
    // as over_budget per DESIGN §11.
    log.warn(
      {
        runId,
        customerId,
        resuming,
        reason: preflightResult.reason,
        estimatedUsd,
        weeklyRemaining: preflightResult.weeklyRemaining,
        monthlyRemaining: preflightResult.monthlyRemaining,
      },
      resuming
        ? "runCycle: preflight failed on resume — leaving run resumable (not over_budget)"
        : "runCycle: preflight failed — marking over_budget",
    );

    if (!resuming) {
      await repo.finishRun(runId, "over_budget");
    }
    return null;
  }

  log.info(
    {
      runId,
      estimatedUsd: estimatedUsd.toFixed(4),
      weeklyRemaining: preflightResult.weeklyRemaining?.toFixed(4),
      monthlyRemaining: preflightResult.monthlyRemaining?.toFixed(4),
    },
    "runCycle: preflight passed",
  );

  // -------------------------------------------------------------------------
  // STEP 4 — snapshot n_total on the run row BEFORE any execution (§5.2).
  //
  // On RESUME the denominator was frozen when the run was first created — do NOT
  // re-snapshot (§5.2 requires a stable denominator even if the regenerated plan
  // differs slightly, e.g. a question toggled active between cycles). A drift is
  // logged for visibility but the frozen n_total wins.
  // -------------------------------------------------------------------------
  if (resuming) {
    if (resumable && resumable.nTotal !== nTotal) {
      log.warn(
        { runId, frozenNTotal: resumable.nTotal, regeneratedNTotal: nTotal },
        "runCycle: resumed plan differs from frozen n_total — keeping frozen denominator (§5.2)",
      );
    }
    log.info({ runId, nTotal: resumable?.nTotal }, "runCycle: resume — n_total kept frozen");
  } else {
    await repo.snapshotNTotal(runId, nTotal);
    log.info({ runId, nTotal }, "runCycle: n_total snapshotted");
  }

  // Handle empty FRESH plan (no questions due / no configured models). Not
  // reachable on resume: an empty regenerated plan yields zero executableUnits,
  // which already returned null above (leaving the run resumable).
  if (!resuming && nTotal === 0) {
    log.warn(
      { runId, customerId, kind },
      "runCycle: plan produced zero work-units — completing immediately",
    );
    await repo.finishRun(runId, "completed");
    // Assemble an empty report.
    const report = await assembleReport(runId);
    return report;
  }

  // -------------------------------------------------------------------------
  // STEP 5 — Persist work-units (idempotent via ON CONFLICT DO NOTHING).
  //
  // Skipped on RESUME: the frozen plan's units are already persisted. Re-inserting
  // the regenerated plan could add units beyond the frozen n_total (if the active
  // question set grew), which would both violate §5.2 and keep the run eternally
  // resumable (new pending rows never in any executableUnits set).
  // -------------------------------------------------------------------------
  if (!resuming) {
    for (const wu of workUnits) {
      await repo.insertWorkUnit({
        runId,
        questionId: wu.questionId,
        modelId: wu.modelId,
        language: wu.language,
        sampleIdx: wu.sampleIdx,
      });
    }
    log.info({ runId, count: workUnits.length }, "runCycle: work-units persisted");
  }

  // -------------------------------------------------------------------------
  // STEP 6 — Advance rotation cursors for tiers scheduled this cycle.
  //          (Only for operating runs — baseline doesn't advance cursors.)
  // -------------------------------------------------------------------------
  if (kind === "operating") {
    for (const [tier, nextState] of nextRotationStates) {
      await repo.advanceRotationState(customerId, tier, nextState.lastCycleIndex);
    }
    log.debug(
      { runId, tiers: [...nextRotationStates.keys()] },
      "runCycle: rotation cursors advanced",
    );
  }

  // -------------------------------------------------------------------------
  // STEP 7 — Transition run → 'running'.
  //          On RESUME the run is already 'running' — skip so we preserve the
  //          ORIGINAL started_at (the true measurement start; §5.2) rather than
  //          resetting the clock each cycle.
  // -------------------------------------------------------------------------
  if (!resuming) {
    await repo.startRun(runId);
  }

  // -------------------------------------------------------------------------
  // STEP 8 — Fan-out: execute or enqueue one job per pending work-unit.
  //
  // Resumability: if a work-unit is already 'done' it will be skipped by
  // runResponse's STEP 1 resume check.  We can safely re-enqueue / re-execute
  // all units — the ones that are done will no-op instantly.
  //
  // Two paths:
  //   A. Synchronous (baseline, CLI): responseRunHandler provided → execute inline.
  //   B. Asynchronous (operating):    queue provided → enqueue response.run jobs.
  // -------------------------------------------------------------------------

  // Build a shared ResponseCache for the entire cycle so that intra-cycle
  // sample non-collapse is enforced across all work-units.
  const responseCache = createResponseCache(cacheFns);

  let finalStatus: "completed" | "failed" | "over_budget" = "completed";
  let report: RunReport | null = null;

  if (responseRunHandler) {
    // -----------------------------------------------------------------------
    // PATH A — synchronous inline execution (baseline / diagnose CLI).
    // -----------------------------------------------------------------------
    log.info(
      { runId, nTotal, executing: executableUnits.length },
      "runCycle: executing work-units inline (sync path)",
    );

    let hadError = false;
    let hadOverBudget = false;

    for (const wu of executableUnits) {
      // Build the ResponseRunPayload for this work-unit.
      const payload_ = {
        runId,
        customerId,
        questionId: wu.questionId,
        modelId: wu.modelId,
        language: wu.language,
        sampleIdx: wu.sampleIdx,
        requestHash: wu.requestHash ?? "",
        prompt: wu.prompt ?? "",
        promptVersion: wu.promptVersion ?? "v1",
        temperature: wu.temperature ?? PLAN_TEMPERATURE,
      };

      // Resolve the provider adapter for this model.
      // The provider is embedded in the ModelRef; map from modelId → adapter.
      const model = models.find((m) => m.id === wu.modelId);
      const adapter = model ? adapters.get(model.provider) : undefined;

      if (!model || !adapter) {
        log.warn(
          { runId, modelId: wu.modelId },
          "runCycle: no adapter found for model — skipping work-unit",
        );
        await repo.markWorkUnitSkipped(
          runId,
          wu.questionId,
          wu.modelId,
          wu.language,
          wu.sampleIdx,
        );
        continue;
      }

      const runResponseDeps: RunResponseDeps = {
        adapter,
        judgeAdapter,
        budget,
        isNewCustomer,
        costReader,
        ledger,
        cacheFns,
        responseCache,
        gates: [...gates],
        brand,
        competitors,
        ...(limiters !== undefined ? { limiters } : {}),
      };

      // -----------------------------------------------------------------------
      // SURFACE CACHE CARRY-FORWARD (Phase 4 T15) — PATH A.
      //
      // For serp/scrape (non-chat) surfaces, if the cross-cycle response cache
      // has a hit for this request_hash, carry forward the prior answer WITHOUT
      // re-running the LLM judge ("no re-judge on cache hit").
      //
      // Rationale (§11, §5.3):
      //   - serp/scrape surfaces are deterministic (nSamples=1). The same query
      //     to the same surface returns the same answer within a cache TTL window.
      //   - Re-running the judge on a cached answer wastes judge budget and
      //     violates the intent of the cross-cycle dedup cache.
      //   - A cached surface answer carries forward the prior judgment via abstain
      //     (provenance='abstain', brand_mentioned=false) — conservative and free.
      //     This is correct for surfaces: if the cached answer was NOT already
      //     judged (first appearance), the judgment is abstain; if it WAS judged,
      //     the full responseRunHandler will produce the correct judgment anyway,
      //     so the carry-forward is only applied when the cache hit is confirmed.
      //
      // NOTE: The carry-forward ONLY activates for serp/scrape surfaces (model.modality
      // !== 'chat'). Chat surfaces continue through the normal responseRunHandler path
      // with its existing intra-cycle non-collapse logic intact.
      // -----------------------------------------------------------------------
      const isNonChatSurface = model.modality === "serp" || model.modality === "scrape";
      const requestHash = wu.requestHash ?? "";

      if (isNonChatSurface && requestHash) {
        const cacheHit = await responseCache.check(requestHash, runId);
        if (cacheHit.hit) {
          // Cache hit on a surface work-unit: carry forward without re-judging.
          log.debug(
            { runId, questionId: wu.questionId, modelId: wu.modelId, requestHash },
            "runCycle: surface cache carry-forward — skipping re-judge",
          );

          try {
            // Persist the cached response_raw (status='cached').
            const rawRow = await repo.insertResponseRaw({
              runId,
              customerId,
              questionId: wu.questionId,
              modelId: wu.modelId,
              language: wu.language,
              sampleIdx: wu.sampleIdx,
              temperature: wu.temperature ?? PLAN_TEMPERATURE,
              requestHash,
              promptVersion: wu.promptVersion ?? "v1",
              answerText: cacheHit.answerText,
              providerMeta: { surfaceCacheCarryForward: true },
              status: "cached",
            });

            // Record a $0 cache-hit generation entry in the ledger.
            await ledger.recordCacheHit({
              customerId,
              runId,
              purpose: "generation",
              provider: wu.modelId, // for surfaces, provider = surfaceId
              modelId: wu.modelId,
              responseRawId: rawRow.id,
            });

            // ICS-02 FIX: carry forward the PRIOR judgment instead of writing
            // a conservative abstain that silently depresses SMR.
            //
            // Look up the latest current_judgment for the same request_hash
            // (from a prior run, not the current one). If found, copy its
            // brand_mentioned / brand_rank / sentiment / competitors_found /
            // evidence into the new cached judgment row. No judge call is made
            // (the "no-re-judge on cache hit" property is preserved).
            //
            // If no prior judgment exists (first time this hash has been seen),
            // fall back to the conservative abstain.
            const priorJudgment = findPriorJudgmentByHash
              ? await findPriorJudgmentByHash(requestHash, runId)
              : null;

            const competitorsFound = priorJudgment?.competitors_found;
            // competitors_found is stored as JSONB — normalize to array for insertJudgment.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const competitorsArray: Array<{ name: string; rank: number | null }> =
              Array.isArray(competitorsFound)
                ? (competitorsFound as Array<{ name: string; rank: number | null }>)
                : [];

            // Write the judgment: carry-forward if prior exists, abstain otherwise.
            await repo.insertJudgment({
              responseRawId: rawRow.id,
              runId,
              customerId,
              questionId: wu.questionId,
              modelId: wu.modelId,
              language: wu.language,
              responseStatus: "cached",
              brandMentioned: priorJudgment?.brand_mentioned ?? false,
              brandRank: priorJudgment?.brand_rank ?? null,
              sentiment: priorJudgment?.sentiment ?? null,
              competitorsFound: competitorsArray,
              evidenceQuote: priorJudgment?.evidence_quote ?? null,
              evidenceStart: priorJudgment?.evidence_start ?? null,
              evidenceEnd: priorJudgment?.evidence_end ?? null,
              // Provenance stays 'abstain' even on carry-forward: no judge call was made.
              // This is correct — the judgment data is copied from the prior cycle,
              // not re-derived by a judge in this cycle.
              provenance: "abstain",
              judgeModel: null,
              judgeRaw: null,
              guardrailStatus: "pass",
            });

            // Mark the work-unit done (idempotent).
            await repo.markWorkUnitDone(
              runId,
              wu.questionId,
              wu.modelId,
              wu.language,
              wu.sampleIdx,
              rawRow.id,
            );

            // Fire native-review hook (advisory; does not affect SMR).
            const nrCtx: NativeReviewContext = {
              runId,
              customerId,
              questionId: wu.questionId,
              modelId: wu.modelId,
              language: wu.language,
              sampleIdx: wu.sampleIdx,
            };
            await fireCycleNativeReviewHook(nrCtx, onNativeReview);
          } catch (cfErr) {
            log.error(
              { runId, questionId: wu.questionId, modelId: wu.modelId, cfErr },
              "runCycle: surface carry-forward error — marking work-unit error",
            );
            // Mark the work-unit as errored; the carry-forward failed.
            // We do NOT fall through to the responseRunHandler to avoid
            // potential duplicate response_raw rows from partial state.
            try {
              await repo.markWorkUnitError(
                runId,
                wu.questionId,
                wu.modelId,
                wu.language,
                wu.sampleIdx,
              );
            } catch (markErr) {
              log.error(
                { runId, questionId: wu.questionId, modelId: wu.modelId, markErr },
                "runCycle: surface carry-forward — failed to mark work-unit error",
              );
            }
            hadError = true;
          }
          // Skip the normal handler for this work-unit (carry-forward path handled it).
          continue;
        }
        // No cache hit: the responseCache.check() call already marked the hash
        // as seen in the current run (preventing intra-cycle collapse). Fall
        // through to the normal responseRunHandler, which will see a cache miss.
      }

      try {
        await responseRunHandler(payload_, runResponseDeps);

        // PATH A — native-review hook (T14, advisory only).
        // Fires AFTER the work-unit handler returns (i.e. after response_raw +
        // mention_judgment are committed). SMR is IDENTICAL whether this fires or not.
        const nrContext: NativeReviewContext = {
          runId,
          customerId,
          questionId: wu.questionId,
          modelId: wu.modelId,
          language: wu.language,
          sampleIdx: wu.sampleIdx,
        };
        await fireCycleNativeReviewHook(nrContext, onNativeReview);
      } catch (err) {
        if (err instanceof BudgetExceededError || err instanceof CostDataMissingError) {
          log.warn(
            { runId, err },
            "runCycle: budget error during inline execution — marking over_budget",
          );
          hadOverBudget = true;
          // Stop processing further work-units.
          break;
        }

        // Other errors: mark as failed but continue (don't abort the whole cycle).
        log.error(
          { runId, questionId: wu.questionId, modelId: wu.modelId, err },
          "runCycle: work-unit error during inline execution",
        );
        hadError = true;
      }
    }

    if (hadOverBudget) {
      finalStatus = "over_budget";
    } else if (hadError) {
      finalStatus = "failed";
    } else {
      finalStatus = "completed";
    }

    // Aggregate metrics and assemble report.
    try {
      report = await assembleReport(runId);
      log.info(
        {
          runId,
          smr: report.smr.value,
          nTotal: report.smr.nTotal,
          brandHits: report.smr.brandHits,
        },
        "runCycle: metrics aggregated",
      );
    } catch (aggErr) {
      log.error({ runId, aggErr }, "runCycle: aggregation error");
      finalStatus = "failed";
    }

    await repo.finishRun(runId, finalStatus);

    log.info({ runId, finalStatus }, "runCycle: finished (sync path)");
    return report;
  } else if (queue) {
    // -----------------------------------------------------------------------
    // PATH B — asynchronous queue-based fan-out (operating cycle).
    // -----------------------------------------------------------------------
    log.info({ runId, nTotal }, "runCycle: enqueueing response.run jobs (async path)");

    for (const wu of executableUnits) {
      const jobPayload = {
        runId,
        customerId,
        questionId: wu.questionId,
        modelId: wu.modelId,
        language: wu.language,
        sampleIdx: wu.sampleIdx,
        requestHash: wu.requestHash ?? "",
        prompt: wu.prompt ?? "",
        promptVersion: wu.promptVersion ?? "v1",
        temperature: wu.temperature ?? PLAN_TEMPERATURE,
      };

      await queue.enqueue(JOB_NAMES.RESPONSE_RUN, jobPayload, {
        retryLimit: 3,
        retryBackoff: true,
        retryDelay: 30,
      });

      // PATH B — native-review hook (T14, advisory only).
      // Fires at enqueue time (before the job executes asynchronously). This is
      // the earliest point runCycle can fire the hook on the async path; actual
      // response processing happens in the worker after this point.
      // SMR is IDENTICAL whether this fires or not.
      const nrContext: NativeReviewContext = {
        runId,
        customerId,
        questionId: wu.questionId,
        modelId: wu.modelId,
        language: wu.language,
        sampleIdx: wu.sampleIdx,
      };
      await fireCycleNativeReviewHook(nrContext, onNativeReview);
    }

    log.info(
      { runId, jobsEnqueued: executableUnits.length },
      "runCycle: response.run jobs enqueued",
    );

    // Enqueue cycle.aggregate with a singleton key to prevent duplicate aggregation.
    // The aggregate job polls until all work-units are done, then assembles the report.
    const aggregatePayload: CycleAggregatePayload = {
      runId,
      customerId,
    };

    await queue.enqueue(JOB_NAMES.CYCLE_AGGREGATE, aggregatePayload, {
      retryLimit: 5,
      retryBackoff: true,
      retryDelay: 60,
      singletonKey: `aggregate:${runId}`,
    });

    log.info({ runId }, "runCycle: cycle.aggregate job enqueued");

    // On the async path we don't wait for completion here.
    // The worker handles cycle.aggregate asynchronously.
    return null;
  } else {
    throw new Error(
      "runCycle: neither `queue` nor `responseRunHandler` was provided in deps. " +
        "At least one is required to execute work-units.",
    );
  }
}

// ---------------------------------------------------------------------------
// runCycleAggregate — called by the cycle.aggregate job handler
// ---------------------------------------------------------------------------

/**
 * Completion handler for the cycle.aggregate job.
 *
 * Waits (polls) until all work-units for the run are done/error/skipped,
 * then assembles the report and finishes the run.
 *
 * Called by the worker's cycleAggregate handler (injected from worker.ts).
 *
 * DESIGN: aggregate runs exactly once after all units done (enforced by the
 * singletonKey on the cycle.aggregate job).
 *
 * @param payload  - The cycle.aggregate job payload.
 * @param maxWaitMs - Maximum time to wait for completion (default 10 minutes).
 * @param pollIntervalMs - How often to check completion (default 5 seconds).
 */
export async function runCycleAggregate(
  payload: CycleAggregatePayload,
  maxWaitMs = 10 * 60 * 1000,
  pollIntervalMs = 5_000,
): Promise<RunReport> {
  const { runId, customerId } = payload;

  log.info({ runId, customerId }, "runCycleAggregate: starting");

  const deadline = Date.now() + maxWaitMs;

  // Poll until all work-units reach a terminal state.
  while (Date.now() < deadline) {
    const counts = await repo.countWorkUnitsByStatus(runId);

    const totalTerminal = counts.done + counts.skipped + counts.error;
    const totalUnits = totalTerminal + counts.pending;

    if (counts.pending === 0) {
      // All units are in terminal states — proceed to aggregate.
      log.info(
        { runId, counts },
        "runCycleAggregate: all work-units terminal — aggregating",
      );
      break;
    }

    log.debug(
      { runId, counts, totalUnits },
      "runCycleAggregate: waiting for pending work-units",
    );

    // Wait before next poll.
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Re-check after the loop (timeout case).
  const finalCounts = await repo.countWorkUnitsByStatus(runId);
  if (finalCounts.pending > 0) {
    // Some units are still pending after the wait deadline.
    // This can happen if workers are extremely slow or crashed.
    // We aggregate what we have and mark as failed.
    log.warn(
      { runId, finalCounts },
      "runCycleAggregate: timed out waiting for pending work-units — aggregating partial results",
    );
  }

  // Determine the final run status.
  const runMeta = await repo.findRun(runId);
  let finalStatus: "completed" | "failed" | "over_budget" = "completed";

  if (runMeta?.status === "over_budget") {
    finalStatus = "over_budget";
  } else if (finalCounts.error > 0) {
    // If ALL units errored, the run is failed; partial errors are still 'completed'
    // (errors count in the denominator as abstains).
    const totalTerminal = finalCounts.done + finalCounts.skipped + finalCounts.error;
    const errorRate = totalTerminal > 0 ? finalCounts.error / totalTerminal : 0;
    if (errorRate >= 1.0) {
      finalStatus = "failed";
    } else {
      finalStatus = "completed";
    }
  }

  // Assemble the report.
  let report: RunReport;
  try {
    report = await assembleReport(runId);
    log.info(
      {
        runId,
        smr: report.smr.value,
        nTotal: report.smr.nTotal,
        brandHits: report.smr.brandHits,
        abstainCount: report.abstainCount,
      },
      "runCycleAggregate: report assembled",
    );
  } catch (aggErr) {
    log.error({ runId, aggErr }, "runCycleAggregate: aggregation error");
    await repo.finishRun(runId, "failed");
    throw aggErr;
  }

  // Mark the run complete.
  await repo.finishRun(runId, finalStatus);

  log.info({ runId, finalStatus }, "runCycleAggregate: run finished");

  return report;
}

// ---------------------------------------------------------------------------
// buildCyclePlanHandler — factory that creates a CyclePlanHandler for the worker
// ---------------------------------------------------------------------------

/**
 * Build a `CyclePlanHandler` (as expected by worker.ts) from a RunCycleDeps factory.
 *
 * The handler is registered with the pg-boss worker and called on every
 * cycle.plan job.  It calls runCycle() with the queue-based async path.
 *
 * The `depsFactory` is called per job to allow fresh DB reads of customer data
 * (brand, competitors, questions, budget, etc.) per cycle.
 *
 * @param depsFactory  - Async factory that resolves per-customer RunCycleDeps
 *                       from a CyclePlanPayload.
 */
export function buildCyclePlanHandler(
  depsFactory: (payload: CyclePlanPayload) => Promise<RunCycleDeps>,
): import("../scheduler/worker.js").CyclePlanHandler {
  return async (
    payload: CyclePlanPayload,
    queue: JobQueue,
    limiters: Map<string, Bottleneck>,
  ): Promise<void> => {
    const deps = await depsFactory(payload);
    // Always use the queue path for operating cycles.
    await runCycle(payload, { ...deps, queue, limiters });
  };
}

/**
 * Build a `CycleAggregateHandler` (as expected by worker.ts).
 *
 * Wraps runCycleAggregate to match the handler type signature.
 */
export function buildCycleAggregateHandler(): import("../scheduler/worker.js").CycleAggregateHandler {
  return async (payload: CycleAggregatePayload): Promise<void> => {
    await runCycleAggregate(payload);
  };
}
