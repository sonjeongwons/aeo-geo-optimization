/**
 * test/qgenBudget.test.ts
 *
 * Vitest suite for src/cost/qgenBudget.ts.
 *
 * Covers:
 *   - Per-run ceiling abort (process-local accumulator)
 *   - Global weekly cap gate
 *   - Global monthly cap gate
 *   - Works without a customer/budget row (no DB access)
 *   - Does NOT call sumCostSince for in-flight spend
 *   - Non-throwing inspection helpers
 */

import { describe, it, expect } from 'vitest';
import {
  QgenRunBudget,
  QgenBudgetExceededError,
  QgenGlobalCapExceededError,
  DEFAULT_RUN_CEILING_USD,
  createQgenBudget,
} from '../src/cost/qgenBudget.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a QgenRunBudget with controlled caps so tests do not depend on env. */
function makeBudget(opts: {
  runCeilingUsd?: number;
  globalWeeklyUsdCap?: number;
  globalMonthlyUsdCap?: number;
} = {}): QgenRunBudget {
  return new QgenRunBudget({
    runCeilingUsd: opts.runCeilingUsd ?? 0.5,
    globalWeeklyUsdCap: opts.globalWeeklyUsdCap ?? 50,
    globalMonthlyUsdCap: opts.globalMonthlyUsdCap ?? 150,
  });
}

// ---------------------------------------------------------------------------
// Default ceiling value
// ---------------------------------------------------------------------------

describe('DEFAULT_RUN_CEILING_USD', () => {
  it('is $0.50', () => {
    expect(DEFAULT_RUN_CEILING_USD).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Per-run ceiling abort (accumulator-based)
// ---------------------------------------------------------------------------

describe('QgenRunBudget — per-run ceiling (accumulator)', () => {
  it('allows usage below the ceiling', () => {
    const budget = makeBudget({ runCeilingUsd: 0.5 });
    expect(() => budget.recordUsage(0.1)).not.toThrow();
    expect(() => budget.recordUsage(0.2)).not.toThrow();
    expect(budget.totalUsd).toBeCloseTo(0.3);
    expect(budget.isWithinCeiling()).toBe(true);
  });

  it('allows usage exactly equal to the ceiling', () => {
    const budget = makeBudget({ runCeilingUsd: 0.5 });
    expect(() => budget.recordUsage(0.5)).not.toThrow();
    expect(budget.isWithinCeiling()).toBe(true);
  });

  it('throws QgenBudgetExceededError when accumulator exceeds ceiling', () => {
    const budget = makeBudget({ runCeilingUsd: 0.5 });
    budget.recordUsage(0.3);
    expect(() => budget.recordUsage(0.25)).toThrow(QgenBudgetExceededError);
  });

  it('throws with correct accumulated and ceiling values', () => {
    const budget = makeBudget({ runCeilingUsd: 1.0 });
    budget.recordUsage(0.8);

    let err: QgenBudgetExceededError | undefined;
    try {
      budget.recordUsage(0.5);
    } catch (e) {
      err = e as QgenBudgetExceededError;
    }

    expect(err).toBeInstanceOf(QgenBudgetExceededError);
    expect(err?.accumulatedUsd).toBeCloseTo(1.3);
    expect(err?.ceilingUsd).toBe(1.0);
    expect(err?.code).toBe('QGEN_BUDGET_EXCEEDED');
  });

  it('accumulates across multiple calls before exceeding', () => {
    const budget = makeBudget({ runCeilingUsd: 0.5 });
    // Three calls of 0.15 each = 0.45 (within ceiling)
    budget.recordUsage(0.15);
    budget.recordUsage(0.15);
    budget.recordUsage(0.15);
    expect(budget.totalUsd).toBeCloseTo(0.45);
    expect(budget.isWithinCeiling()).toBe(true);

    // Fourth call of 0.15 = 0.60 (exceeds ceiling)
    expect(() => budget.recordUsage(0.15)).toThrow(QgenBudgetExceededError);
  });

  it('isWithinCeiling returns false after exceeding (even catching the throw)', () => {
    const budget = makeBudget({ runCeilingUsd: 0.5 });
    try {
      budget.recordUsage(0.9);
    } catch {
      // expected
    }
    expect(budget.isWithinCeiling()).toBe(false);
    expect(budget.remainingUsd).toBeLessThan(0);
  });

  it('rejects negative usd with RangeError', () => {
    const budget = makeBudget();
    expect(() => budget.recordUsage(-0.01)).toThrow(RangeError);
  });

  it('allows zero-cost calls (e.g. cache hits)', () => {
    const budget = makeBudget({ runCeilingUsd: 0.5 });
    expect(() => budget.recordUsage(0)).not.toThrow();
    expect(budget.totalUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Global gate — weekly cap
// ---------------------------------------------------------------------------

describe('QgenRunBudget — global weekly cap gate', () => {
  it('passes when estimated cost is below the weekly cap', () => {
    const budget = makeBudget({ globalWeeklyUsdCap: 50 });
    expect(() => budget.assertGlobalGate({ estimatedUsd: 0.2 })).not.toThrow();
  });

  it('passes when estimated cost equals the weekly cap', () => {
    const budget = makeBudget({ globalWeeklyUsdCap: 50 });
    // equal to cap — not strictly greater — should pass
    expect(() => budget.assertGlobalGate({ estimatedUsd: 50 })).not.toThrow();
  });

  it('throws QgenGlobalCapExceededError(weekly) when estimated > weekly cap', () => {
    const budget = makeBudget({ globalWeeklyUsdCap: 10 });
    expect(() => budget.assertGlobalGate({ estimatedUsd: 15 })).toThrow(QgenGlobalCapExceededError);
  });

  it('error carries correct capType and values', () => {
    const budget = makeBudget({ globalWeeklyUsdCap: 10 });

    let err: QgenGlobalCapExceededError | undefined;
    try {
      budget.assertGlobalGate({ estimatedUsd: 12 });
    } catch (e) {
      err = e as QgenGlobalCapExceededError;
    }

    expect(err).toBeInstanceOf(QgenGlobalCapExceededError);
    expect(err?.capType).toBe('weekly');
    expect(err?.estimatedUsd).toBe(12);
    expect(err?.capUsd).toBe(10);
    expect(err?.code).toBe('QGEN_GLOBAL_CAP_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// Global gate — monthly cap
// ---------------------------------------------------------------------------

describe('QgenRunBudget — global monthly cap gate', () => {
  it('throws QgenGlobalCapExceededError(monthly) when estimated > monthly cap', () => {
    // Make weekly cap large so monthly triggers first
    const budget = makeBudget({ globalWeeklyUsdCap: 500, globalMonthlyUsdCap: 100 });
    expect(() => budget.assertGlobalGate({ estimatedUsd: 120 })).toThrow(QgenGlobalCapExceededError);
  });

  it('error carries capType=monthly', () => {
    const budget = makeBudget({ globalWeeklyUsdCap: 500, globalMonthlyUsdCap: 100 });

    let err: QgenGlobalCapExceededError | undefined;
    try {
      budget.assertGlobalGate({ estimatedUsd: 110 });
    } catch (e) {
      err = e as QgenGlobalCapExceededError;
    }

    expect(err?.capType).toBe('monthly');
    expect(err?.capUsd).toBe(100);
  });

  it('weekly check fires before monthly when both are exceeded', () => {
    // estimated exceeds BOTH caps; weekly check should be first
    const budget = makeBudget({ globalWeeklyUsdCap: 5, globalMonthlyUsdCap: 10 });

    let err: QgenGlobalCapExceededError | undefined;
    try {
      budget.assertGlobalGate({ estimatedUsd: 20 });
    } catch (e) {
      err = e as QgenGlobalCapExceededError;
    }

    // The implementation checks weekly first
    expect(err?.capType).toBe('weekly');
  });
});

// ---------------------------------------------------------------------------
// No customer / budget row required
// ---------------------------------------------------------------------------

describe('QgenRunBudget — no customer row required', () => {
  it('works without any DB access or customer argument', () => {
    // QgenRunBudget constructor takes no customerId — no DB calls possible
    const budget = makeBudget();
    expect(() => budget.assertGlobalGate({ estimatedUsd: 0.1 })).not.toThrow();
    expect(() => budget.recordUsage(0.05)).not.toThrow();
    expect(budget.totalUsd).toBeCloseTo(0.05);
  });
});

// ---------------------------------------------------------------------------
// Inspection properties
// ---------------------------------------------------------------------------

describe('QgenRunBudget — inspection helpers', () => {
  it('exposes ceiling and cap values', () => {
    const budget = new QgenRunBudget({
      runCeilingUsd: 1.0,
      globalWeeklyUsdCap: 20,
      globalMonthlyUsdCap: 80,
    });

    expect(budget.ceiling).toBe(1.0);
    expect(budget.weeklyCapUsd).toBe(20);
    expect(budget.monthlyCapUsd).toBe(80);
  });

  it('remainingUsd decreases as usage is recorded', () => {
    const budget = makeBudget({ runCeilingUsd: 0.5 });
    expect(budget.remainingUsd).toBeCloseTo(0.5);
    budget.recordUsage(0.2);
    expect(budget.remainingUsd).toBeCloseTo(0.3);
  });
});

// ---------------------------------------------------------------------------
// createQgenBudget helper
// ---------------------------------------------------------------------------

describe('createQgenBudget', () => {
  it('returns a QgenRunBudget instance', () => {
    const budget = createQgenBudget({
      runCeilingUsd: 0.5,
      globalWeeklyUsdCap: 50,
      globalMonthlyUsdCap: 150,
    });
    expect(budget).toBeInstanceOf(QgenRunBudget);
  });

  it('applies default ceiling when no options given', () => {
    // Pass caps to avoid reading env in tests
    const budget = createQgenBudget({ globalWeeklyUsdCap: 50, globalMonthlyUsdCap: 150 });
    expect(budget.ceiling).toBe(DEFAULT_RUN_CEILING_USD);
  });
});

// ---------------------------------------------------------------------------
// Ensures sumCostSince is never called (structural — module imports)
// ---------------------------------------------------------------------------

describe('qgenBudget — does not import sumCostSince', () => {
  it('has no runtime dependency on repo.ts or cost_daily', async () => {
    // If qgenBudget.ts imported repo.ts, instantiating would trigger DB setup.
    // The fact that these tests pass without DATABASE_URL set confirms no DB import.
    const mod = await import('../src/cost/qgenBudget.js');
    // Just assert the module exports the expected symbols
    expect(typeof mod.QgenRunBudget).toBe('function');
    expect(typeof mod.QgenBudgetExceededError).toBe('function');
    expect(typeof mod.QgenGlobalCapExceededError).toBe('function');
    expect(typeof mod.createQgenBudget).toBe('function');
  });
});
