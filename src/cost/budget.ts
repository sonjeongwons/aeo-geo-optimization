/**
 * src/cost/budget.ts
 *
 * §11 Budget caps — shape caps at plan time + weekly/monthly USD caps.
 *
 * Design rules (DESIGN.md §11 / §5.3):
 * - Shape caps (max_models / max_samples / max_languages) are enforced at
 *   matrix-build time by the planner; budget.ts exposes the helpers so the
 *   planner can trim deterministically.
 * - USD caps (weekly + monthly) are read from the `cost_daily` continuous
 *   aggregate (NOT a full scan of llm_call) — this is the CAGG that rolls up
 *   spend per day per customer.
 * - FAIL-CLOSED: if cost data is missing / the CAGG returns NULL, we BLOCK
 *   the call (never silently pass).
 * - preflight() checks estimated spend and marks the run `over_budget` before
 *   any work starts.
 * - assertWithinCap() is called per generation + judge call inside the pipeline.
 *
 * Dependency injection: all DB access is done via the `CostReadPort` seam so
 * this module has no direct pg/kysely import and remains testable without a
 * real database.
 */

import { BudgetExceededError, CostDataMissingError } from "../domain/errors.js";
import type { Budget } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Port (seam) — implemented by src/db/repo.ts in production
// ---------------------------------------------------------------------------

/**
 * Read port for budget checks.
 * The production implementation reads from the `cost_daily` CAGG.
 * Tests inject a lightweight stub.
 */
export interface CostReadPort {
  /**
   * Returns the rolling USD spent by the customer in the last `windowDays`
   * calendar days, read from the `cost_daily` continuous aggregate.
   *
   * MUST return `null` (not 0!) when no `cost_daily` rows exist yet for the
   * customer — the caller treats null as MISSING and fails closed.
   */
  getRollingSpendUsd(
    customerId: string,
    windowDays: number
  ): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Shape-cap check (plan-time, pure)
// ---------------------------------------------------------------------------

export interface ShapeCapInput {
  nModels: number;
  nSamples: number;
  nLanguages: number;
  budget: Budget;
}

/**
 * Checks the three shape caps synchronously (no DB access).
 * Throws BudgetExceededError with capType='shape' if any cap is violated.
 *
 * Called by the planner BEFORE building the work-unit matrix so that the
 * planner can trim down to the cap rather than reject outright. The planner
 * trims first; this function is the hard-stop guard if trimming is skipped.
 */
export function assertShapeCaps(input: ShapeCapInput): void {
  const { nModels, nSamples, nLanguages, budget } = input;

  if (nModels > budget.maxModels) {
    throw new BudgetExceededError(
      `Model count ${nModels} exceeds budget cap of ${budget.maxModels}.`,
      budget.customerId,
      "shape"
    );
  }
  if (nSamples > budget.maxSamples) {
    throw new BudgetExceededError(
      `Sample count ${nSamples} exceeds budget cap of ${budget.maxSamples}.`,
      budget.customerId,
      "shape"
    );
  }
  if (nLanguages > budget.maxLanguages) {
    throw new BudgetExceededError(
      `Language count ${nLanguages} exceeds budget cap of ${budget.maxLanguages}.`,
      budget.customerId,
      "shape"
    );
  }
}

// ---------------------------------------------------------------------------
// preflight — run-level USD cap check (before execution starts)
// ---------------------------------------------------------------------------

export interface PreflightInput {
  customerId: string;
  budget: Budget;
  estimatedUsd: number;
  costReader: CostReadPort;
}

export interface PreflightResult {
  /** true = run is within budget and may proceed */
  ok: boolean;
  /** Reason string when ok=false */
  reason?: string;
  weeklySpent: number | null;
  monthlySpent: number | null;
  weeklyRemaining: number | null;
  monthlyRemaining: number | null;
}

/**
 * Performs the pre-run budget check.
 *
 * Reads rolling 7-day and 30-day spend from the `cost_daily` CAGG.
 * If either window returns null (no data yet) we treat it as 0 (the customer
 * has never spent anything) — unlike assertWithinCap which fails closed on
 * missing per-call data, a missing CAGG aggregate on a brand-new customer is
 * a legitimate "zero spend" state.
 *
 * Returns PreflightResult.ok=false when the estimated spend would exceed
 * the remaining weekly OR monthly cap.
 */
export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const { customerId, budget, estimatedUsd, costReader } = input;

  const [weeklySpentRaw, monthlySpentRaw] = await Promise.all([
    costReader.getRollingSpendUsd(customerId, 7),
    costReader.getRollingSpendUsd(customerId, 30),
  ]);

  // For preflight: null = customer has no prior spend = 0.
  // (Different from assertWithinCap where null = data problem = fail-closed.)
  const weeklySpent = weeklySpentRaw ?? 0;
  const monthlySpent = monthlySpentRaw ?? 0;

  const weeklyRemaining = budget.weeklyUsdCap - weeklySpent;
  const monthlyRemaining = budget.monthlyUsdCap - monthlySpent;

  if (estimatedUsd > weeklyRemaining) {
    return {
      ok: false,
      reason: `Estimated cost $${estimatedUsd.toFixed(4)} exceeds remaining weekly cap $${weeklyRemaining.toFixed(4)} (spent $${weeklySpent.toFixed(4)} of $${budget.weeklyUsdCap}).`,
      weeklySpent,
      monthlySpent,
      weeklyRemaining,
      monthlyRemaining,
    };
  }

  if (estimatedUsd > monthlyRemaining) {
    return {
      ok: false,
      reason: `Estimated cost $${estimatedUsd.toFixed(4)} exceeds remaining monthly cap $${monthlyRemaining.toFixed(4)} (spent $${monthlySpent.toFixed(4)} of $${budget.monthlyUsdCap}).`,
      weeklySpent,
      monthlySpent,
      weeklyRemaining,
      monthlyRemaining,
    };
  }

  return {
    ok: true,
    weeklySpent,
    monthlySpent,
    weeklyRemaining,
    monthlyRemaining,
  };
}

// ---------------------------------------------------------------------------
// assertWithinCap — per-call guard (FAIL-CLOSED on missing data)
// ---------------------------------------------------------------------------

export interface AssertWithinCapInput {
  customerId: string;
  budget: Budget;
  costReader: CostReadPort;
}

/**
 * Per-call budget guard. Called inside the pipeline before each generation
 * or judge call.
 *
 * FAIL-CLOSED: if `costReader.getRollingSpendUsd` returns null (no CAGG data
 * after the customer has started running), throws CostDataMissingError.
 *
 * A brand-new customer with no prior spend will have cost_daily rows inserted
 * by the ledger as soon as the first call completes; until then the pipeline
 * is allowed to proceed because the CAGG lag is at most 1 hour. However, once
 * a customer has at least one llm_call row, missing cost_daily data signals a
 * CAGG refresh failure → we fail closed.
 *
 * Implementation note: the caller is responsible for checking whether the
 * customer is "new" (no prior llm_call rows). We expose a separate helper
 * `assertWithinCapOrNew` that accepts an `isNewCustomer` flag and delegates
 * to either the fail-closed path or a zero-spend assumption.
 */
export async function assertWithinCap(
  input: AssertWithinCapInput
): Promise<void> {
  const { customerId, budget, costReader } = input;

  const [weeklySpent, monthlySpent] = await Promise.all([
    costReader.getRollingSpendUsd(customerId, 7),
    costReader.getRollingSpendUsd(customerId, 30),
  ]);

  // FAIL CLOSED — null means the CAGG returned no data; this is a data problem
  if (weeklySpent === null || monthlySpent === null) {
    throw new CostDataMissingError(customerId);
  }

  if (weeklySpent >= budget.weeklyUsdCap) {
    throw new BudgetExceededError(
      `Weekly USD cap of $${budget.weeklyUsdCap} reached (spent $${weeklySpent.toFixed(4)}).`,
      customerId,
      "weekly"
    );
  }

  if (monthlySpent >= budget.monthlyUsdCap) {
    throw new BudgetExceededError(
      `Monthly USD cap of $${budget.monthlyUsdCap} reached (spent $${monthlySpent.toFixed(4)}).`,
      customerId,
      "monthly"
    );
  }
}

/**
 * Variant of assertWithinCap that treats a new customer (no prior llm_call
 * rows yet) as having $0 spend instead of failing closed.
 *
 * Use this in the very first call of a fresh baseline run where cost_daily
 * cannot have rows yet.
 */
export async function assertWithinCapOrNew(
  input: AssertWithinCapInput & { isNewCustomer: boolean }
): Promise<void> {
  const { isNewCustomer, ...rest } = input;
  const { customerId, budget, costReader } = rest;

  const [weeklySpent, monthlySpent] = await Promise.all([
    costReader.getRollingSpendUsd(customerId, 7),
    costReader.getRollingSpendUsd(customerId, 30),
  ]);

  if (weeklySpent === null || monthlySpent === null) {
    if (isNewCustomer) {
      // No prior spend — treat as $0 and allow through
      return;
    }
    // Existing customer with missing CAGG data → fail closed
    throw new CostDataMissingError(customerId);
  }

  if (weeklySpent >= budget.weeklyUsdCap) {
    throw new BudgetExceededError(
      `Weekly USD cap of $${budget.weeklyUsdCap} reached (spent $${weeklySpent.toFixed(4)}).`,
      customerId,
      "weekly"
    );
  }

  if (monthlySpent >= budget.monthlyUsdCap) {
    throw new BudgetExceededError(
      `Monthly USD cap of $${budget.monthlyUsdCap} reached (spent $${monthlySpent.toFixed(4)}).`,
      customerId,
      "monthly"
    );
  }
}

// ---------------------------------------------------------------------------
// Utility: estimate plan cost (rough, pre-execution)
// ---------------------------------------------------------------------------

/**
 * Rough cost estimate for a planned work-unit matrix.
 *
 * @param nWorkUnits  total number of work units (= run.n_total)
 * @param avgGenUsd   average USD per generation call
 * @param avgJudgeUsd average USD per judge call
 * @returns estimated total USD
 */
export function estimatePlanCost(
  nWorkUnits: number,
  avgGenUsd: number,
  avgJudgeUsd: number
): number {
  // Each work unit = 1 generation + 1 judge call
  return nWorkUnits * (avgGenUsd + avgJudgeUsd);
}

// ---------------------------------------------------------------------------
// Surface-aware plan cost estimation (Phase 4, T15)
// ---------------------------------------------------------------------------

/**
 * Breakdown of work-units by modality for surface-aware cost estimation.
 *
 * SERP surfaces (googleAio, naverAi) have a flat per-call rate metered via
 * surfacePricing.ts. Scrape surfaces are $0 stubs (RPA infra billed externally).
 * Chat surfaces use the standard avgGenUsd + avgJudgeUsd model.
 */
export interface PlanCostBreakdown {
  /** Number of chat (api modality) work-units. */
  nChatUnits: number;
  /**
   * Per-surface SERP unit counts.
   * Key: surfaceId (e.g. "googleAio"), value: number of work-units.
   * SERP calls are metered at the flat rate from surfacePricing.ts.
   */
  nSerpUnitsBySurface: Map<string, number>;
  /**
   * Number of scrape (RPA) work-units (any surface).
   * Scrape cost is $0 stub — RPA infra is billed externally.
   */
  nScrapeUnits: number;
}

/**
 * Surface-aware cost estimate that accounts for flat-rate SERP surface charges.
 *
 * Unlike the chat-only `estimatePlanCost`, this function distinguishes:
 *   - Chat units: estimated at (avgGenUsd + avgJudgeUsd) per unit.
 *   - SERP units: flat rate from the surface price table + avgJudgeUsd per unit.
 *   - Scrape units: $0 flat (RPA infra tracked externally) + avgJudgeUsd per unit.
 *
 * The judge is always the Gemini adapter (§5.4), so its cost applies to all
 * surface types. For NOT_CONFIGURED stubs the judge call is skipped at runtime,
 * but we include it in the estimate to be conservative.
 *
 * @param breakdown       Breakdown of work-units by modality (from buildPlan output).
 * @param avgGenUsd       Average USD per chat generation call (fallback for chat units).
 * @param avgJudgeUsd     Average USD per judge call (applies to all modalities).
 * @param serpCallUsdFn   Function to look up flat-rate USD per SERP surface call.
 *                        Defaults to a zero-returning stub; production callers inject
 *                        `(id) => surfaceUsdPerCall(id as SurfaceId)` from
 *                        surfaces/surfacePricing.ts (which takes SurfaceId).
 *                        This function accepts `string` to keep budget.ts free of
 *                        a direct import of SurfaceId from the surfaces layer.
 * @returns Estimated total USD for the plan.
 */
export function estimateSurfacePlanCost(
  breakdown: PlanCostBreakdown,
  avgGenUsd: number,
  avgJudgeUsd: number,
  serpCallUsdFn: (surfaceId: string) => number = () => 0,
): number {
  // Chat units: standard gen + judge cost.
  const chatCost = breakdown.nChatUnits * (avgGenUsd + avgJudgeUsd);

  // SERP units: flat surface rate + judge cost per unit.
  let serpCost = 0;
  for (const [surfaceId, count] of breakdown.nSerpUnitsBySurface) {
    const flatRateUsd = serpCallUsdFn(surfaceId);
    serpCost += count * (flatRateUsd + avgJudgeUsd);
  }

  // Scrape units: $0 gen (RPA infra external) + judge cost.
  const scrapeCost = breakdown.nScrapeUnits * avgJudgeUsd;

  return chatCost + serpCost + scrapeCost;
}

/**
 * Build a PlanCostBreakdown from the work-unit list produced by buildPlan.
 *
 * Looks up modality for each unit via the `models` map (modelId → modality).
 * For surface (serp/scrape) work-units the modelId is the surfaceId (e.g. "googleAio").
 * For chat work-units the modelId is the model row id (e.g. "gemini-2.5-flash-lite").
 *
 * @param workUnits  The planned work-units from buildPlan output.
 * @param modelMap   Map from modelId → { modality, surfaceId? }.
 *                   Surface adapters set modality='serp'|'scrape' and the modelId IS the surfaceId.
 * @returns PlanCostBreakdown ready for estimateSurfacePlanCost.
 */
export function buildPlanCostBreakdown(
  workUnits: ReadonlyArray<{ modelId: string }>,
  modelMap: ReadonlyMap<string, { modality: "chat" | "serp" | "scrape" }>,
): PlanCostBreakdown {
  let nChatUnits = 0;
  let nScrapeUnits = 0;
  const nSerpUnitsBySurface = new Map<string, number>();

  for (const wu of workUnits) {
    const meta = modelMap.get(wu.modelId);
    const modality = meta?.modality ?? "chat";

    if (modality === "serp") {
      // For SERP surfaces the modelId IS the surfaceId.
      nSerpUnitsBySurface.set(wu.modelId, (nSerpUnitsBySurface.get(wu.modelId) ?? 0) + 1);
    } else if (modality === "scrape") {
      nScrapeUnits += 1;
    } else {
      nChatUnits += 1;
    }
  }

  return { nChatUnits, nSerpUnitsBySurface, nScrapeUnits };
}
