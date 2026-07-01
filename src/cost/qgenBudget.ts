/**
 * src/cost/qgenBudget.ts
 *
 * Phase 1 preflight for onboarding-time question generation (qgen).
 *
 * Design rules (DESIGN-phase1.md §Cost Design / §Key Decisions):
 *
 * 1. GLOBAL GATE — reads GLOBAL_WEEKLY_USD_CAP / GLOBAL_MONTHLY_USD_CAP from
 *    env.ts (exist there; defaults 50 / 150). Uses these as coarse global
 *    gates BEFORE starting a generation run.  The caller supplies an estimated
 *    cost so this check is purely synchronous (no DB read).
 *
 * 2. PER-RUN ACCUMULATOR — a process-local USD counter sums actual per-call
 *    usage returned by each Gemini call and aborts when the per-run ceiling is
 *    exceeded.  Default ceiling: $0.50 (configurable via the RunBudget input).
 *
 * 3. NO CUSTOMER / BUDGET ROW REQUIRED — URL-first onboarding happens BEFORE
 *    any customer row exists, so the customer-scoped preflight() from budget.ts
 *    cannot be used here.
 *
 * 4. DOES NOT READ cost_daily MID-RUN — cost_daily is a continuous aggregate
 *    with a 1-hour end_offset, so in-flight spend is invisible to it for up to
 *    an hour.  The per-run ceiling is enforced by the process-local accumulator
 *    over ACTUAL usage returned by each call — not by re-querying the CAGG.
 *
 * 5. NO sumCostSince CALL — this module never calls the per-customer
 *    sumCostSince helper (which requires a customer row) for the in-flight run.
 *
 * Usage pattern:
 *
 *   const budget = new QgenRunBudget({ runCeilingUsd: 0.5 });
 *
 *   // Before starting:
 *   budget.assertGlobalGate({ estimatedUsd: 0.2 });
 *
 *   // After each Gemini call:
 *   budget.recordUsage(callUsd);          // throws QgenBudgetExceededError if over
 *
 *   // Check at any time (non-throwing):
 *   const ok = budget.isWithinCeiling();
 */

import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown when the per-run USD ceiling is exceeded.
 * Distinct from BudgetExceededError (which is customer-scoped).
 */
export class QgenBudgetExceededError extends Error {
  public readonly code = 'QGEN_BUDGET_EXCEEDED' as const;

  constructor(
    public readonly accumulatedUsd: number,
    public readonly ceilingUsd: number,
  ) {
    super(
      `qgen per-run USD ceiling of $${ceilingUsd.toFixed(4)} exceeded ` +
        `(accumulated $${accumulatedUsd.toFixed(4)}).`,
    );
    this.name = 'QgenBudgetExceededError';
  }
}

/**
 * Thrown when a generation run would exceed the global weekly or monthly cap.
 */
export class QgenGlobalCapExceededError extends Error {
  public readonly code = 'QGEN_GLOBAL_CAP_EXCEEDED' as const;

  constructor(
    public readonly capType: 'weekly' | 'monthly',
    public readonly estimatedUsd: number,
    public readonly capUsd: number,
  ) {
    super(
      `qgen estimated cost $${estimatedUsd.toFixed(4)} would exceed ` +
        `the global ${capType} cap of $${capUsd.toFixed(4)}.`,
    );
    this.name = 'QgenGlobalCapExceededError';
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface QgenRunBudgetOptions {
  /**
   * Per-run USD ceiling enforced by the process-local accumulator.
   * If absent, defaults to DEFAULT_RUN_CEILING_USD (0.50).
   */
  runCeilingUsd?: number;

  /**
   * Override the global weekly cap read from env.
   * Used in tests to inject controlled values without modifying process.env.
   */
  globalWeeklyUsdCap?: number;

  /**
   * Override the global monthly cap read from env.
   * Used in tests to inject controlled values without modifying process.env.
   */
  globalMonthlyUsdCap?: number;
}

/** Default per-run ceiling: $0.50 (§Cost Design). */
export const DEFAULT_RUN_CEILING_USD = 0.5;

// ---------------------------------------------------------------------------
// Global-gate check (pure, no DB)
// ---------------------------------------------------------------------------

export interface GlobalGateInput {
  /**
   * Estimated total USD spend for this generation run.
   * Used only for the coarse global gate check; the accumulator tracks actual.
   */
  estimatedUsd: number;
}

// ---------------------------------------------------------------------------
// QgenRunBudget
// ---------------------------------------------------------------------------

/**
 * Stateful per-run budget tracker for question generation.
 *
 * Instantiate once per generation run, call assertGlobalGate() before starting,
 * then call recordUsage(usd) after each Gemini call to enforce the per-run
 * ceiling via process-local accumulation.
 *
 * Thread safety: Node.js is single-threaded; no lock needed.
 */
export class QgenRunBudget {
  /** Per-run ceiling (USD). */
  private readonly ceilingUsd: number;

  /** Global weekly cap read from env (overrideable for tests). */
  private readonly globalWeeklyUsdCap: number;

  /** Global monthly cap read from env (overrideable for tests). */
  private readonly globalMonthlyUsdCap: number;

  /** Process-local accumulator of actual USD spent this run. */
  private accumulatedUsd = 0;

  constructor(opts: QgenRunBudgetOptions = {}) {
    this.ceilingUsd = opts.runCeilingUsd ?? DEFAULT_RUN_CEILING_USD;
    // Read from env unless overridden (tests inject without process.env mutation)
    this.globalWeeklyUsdCap = opts.globalWeeklyUsdCap ?? env.GLOBAL_WEEKLY_USD_CAP;
    this.globalMonthlyUsdCap = opts.globalMonthlyUsdCap ?? env.GLOBAL_MONTHLY_USD_CAP;
  }

  // -------------------------------------------------------------------------
  // Global gate (coarse, pre-run)
  // -------------------------------------------------------------------------

  /**
   * Coarse global-cap gate: checks that the estimated run cost does not exceed
   * the global weekly or monthly cap.
   *
   * Call ONCE before starting the generation run.
   * Does NOT read the DB or cost_daily — it is a purely env-based guard.
   * Throws QgenGlobalCapExceededError if the estimated cost is over either cap.
   */
  assertGlobalGate(input: GlobalGateInput): void {
    const { estimatedUsd } = input;

    if (estimatedUsd > this.globalWeeklyUsdCap) {
      throw new QgenGlobalCapExceededError('weekly', estimatedUsd, this.globalWeeklyUsdCap);
    }

    if (estimatedUsd > this.globalMonthlyUsdCap) {
      throw new QgenGlobalCapExceededError('monthly', estimatedUsd, this.globalMonthlyUsdCap);
    }
  }

  // -------------------------------------------------------------------------
  // Per-run ceiling (accumulator-based)
  // -------------------------------------------------------------------------

  /**
   * Record the USD cost of one Gemini call and check if the per-run ceiling is
   * exceeded.
   *
   * Throws QgenBudgetExceededError AFTER recording the cost when the accumulated
   * total exceeds the ceiling.  The caller should treat this as a hard abort.
   *
   * @param usd - actual USD cost returned by the adapter for this call
   */
  recordUsage(usd: number): void {
    if (usd < 0) {
      throw new RangeError(`qgenBudget: negative usd=${usd} is invalid`);
    }

    this.accumulatedUsd += usd;

    if (this.accumulatedUsd > this.ceilingUsd) {
      throw new QgenBudgetExceededError(this.accumulatedUsd, this.ceilingUsd);
    }
  }

  // -------------------------------------------------------------------------
  // Non-throwing inspection
  // -------------------------------------------------------------------------

  /**
   * Returns true when the accumulated spend is within the per-run ceiling.
   * Does NOT throw; use this for conditional checks.
   */
  isWithinCeiling(): boolean {
    return this.accumulatedUsd <= this.ceilingUsd;
  }

  /**
   * Returns the total USD accumulated so far in this run.
   */
  get totalUsd(): number {
    return this.accumulatedUsd;
  }

  /**
   * Returns the per-run ceiling configured for this instance.
   */
  get ceiling(): number {
    return this.ceilingUsd;
  }

  /**
   * Returns the remaining USD budget before the per-run ceiling is hit.
   * May be negative when already exceeded.
   */
  get remainingUsd(): number {
    return this.ceilingUsd - this.accumulatedUsd;
  }

  /**
   * Returns the global weekly cap used by this instance.
   */
  get weeklyCapUsd(): number {
    return this.globalWeeklyUsdCap;
  }

  /**
   * Returns the global monthly cap used by this instance.
   */
  get monthlyCapUsd(): number {
    return this.globalMonthlyUsdCap;
  }
}

// ---------------------------------------------------------------------------
// Functional helper (thin wrapper for simple one-shot checks)
// ---------------------------------------------------------------------------

/**
 * Create a fresh QgenRunBudget for the current generation run.
 * Shorthand for `new QgenRunBudget(opts)`.
 */
export function createQgenBudget(opts: QgenRunBudgetOptions = {}): QgenRunBudget {
  return new QgenRunBudget(opts);
}
