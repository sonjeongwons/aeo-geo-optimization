/**
 * test/budget.test.ts
 *
 * Vitest suite for src/cost/budget.ts:
 *   - USD weekly/monthly caps enforced via preflight() and assertWithinCap().
 *   - FAIL-CLOSED: assertWithinCap throws CostDataMissingError when getRollingSpendUsd returns null.
 *   - preflight() treats null (new customer) as $0 spend (allow-through).
 *   - Reads from cost_daily rollup (CostReadPort) not from a full scan of llm_call.
 *   - assertShapeCaps() enforces model/sample/language shape caps.
 *
 * No real Postgres needed — CostReadPort is injected as an in-memory stub.
 */

import { describe, it, expect, vi } from "vitest";
import {
  assertShapeCaps,
  preflight,
  assertWithinCap,
  assertWithinCapOrNew,
  estimatePlanCost,
  type CostReadPort,
  type ShapeCapInput,
  type PreflightInput,
  type AssertWithinCapInput,
} from "../src/cost/budget.js";
import { BudgetExceededError, CostDataMissingError } from "../src/domain/errors.js";
import type { Budget } from "../src/domain/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    customerId: "customer-uuid-1",
    maxModels: 2,
    maxSamples: 5,
    maxLanguages: 3,
    weeklyUsdCap: 10.0,
    monthlyUsdCap: 30.0,
    ...overrides,
  };
}

/** Build a CostReadPort stub that returns controlled spend values. */
function makeCostReader(weeklySpend: number | null, monthlySpend: number | null): CostReadPort {
  return {
    getRollingSpendUsd: vi.fn(async (_customerId: string, windowDays: number) => {
      if (windowDays === 7) return weeklySpend;
      if (windowDays === 30) return monthlySpend;
      return null;
    }),
  };
}

// ---------------------------------------------------------------------------
// assertShapeCaps — synchronous, no DB
// ---------------------------------------------------------------------------

describe("assertShapeCaps — shape cap enforcement", () => {
  it("does not throw when all caps are within budget", () => {
    const input: ShapeCapInput = {
      nModels: 1,
      nSamples: 3,
      nLanguages: 2,
      budget: makeBudget(),
    };
    expect(() => assertShapeCaps(input)).not.toThrow();
  });

  it("throws BudgetExceededError when nModels exceeds cap", () => {
    const input: ShapeCapInput = {
      nModels: 5,   // cap = 2
      nSamples: 3,
      nLanguages: 2,
      budget: makeBudget({ maxModels: 2 }),
    };
    expect(() => assertShapeCaps(input)).toThrow(BudgetExceededError);
  });

  it("throws BudgetExceededError with capType='shape' for model violation", () => {
    const input: ShapeCapInput = {
      nModels: 3,
      nSamples: 3,
      nLanguages: 2,
      budget: makeBudget({ maxModels: 2 }),
    };
    try {
      assertShapeCaps(input);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).capType).toBe("shape");
    }
  });

  it("throws when nSamples exceeds cap", () => {
    const input: ShapeCapInput = {
      nModels: 1,
      nSamples: 10,  // cap = 5
      nLanguages: 2,
      budget: makeBudget({ maxSamples: 5 }),
    };
    expect(() => assertShapeCaps(input)).toThrow(BudgetExceededError);
  });

  it("throws when nLanguages exceeds cap", () => {
    const input: ShapeCapInput = {
      nModels: 1,
      nSamples: 3,
      nLanguages: 5,  // cap = 3
      budget: makeBudget({ maxLanguages: 3 }),
    };
    expect(() => assertShapeCaps(input)).toThrow(BudgetExceededError);
  });

  it("at-the-cap values pass (boundary)", () => {
    const budget = makeBudget({ maxModels: 2, maxSamples: 5, maxLanguages: 3 });
    expect(() =>
      assertShapeCaps({ nModels: 2, nSamples: 5, nLanguages: 3, budget })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// preflight — pre-run USD cap check
// ---------------------------------------------------------------------------

describe("preflight — USD cap enforcement before run starts", () => {
  it("returns ok=true when within both weekly and monthly caps", async () => {
    const budget = makeBudget({ weeklyUsdCap: 10, monthlyUsdCap: 30 });
    const costReader = makeCostReader(2.0, 5.0);  // spent $2 weekly, $5 monthly

    const result = await preflight({
      customerId: "cust-1",
      budget,
      estimatedUsd: 1.0,  // want to spend $1 more
      costReader,
    });

    expect(result.ok).toBe(true);
    expect(result.weeklySpent).toBe(2.0);
    expect(result.monthlySpent).toBe(5.0);
  });

  it("returns ok=false when estimated spend exceeds weekly remaining", async () => {
    const budget = makeBudget({ weeklyUsdCap: 10, monthlyUsdCap: 30 });
    const costReader = makeCostReader(9.0, 15.0);  // $9 of $10 weekly used

    const result = await preflight({
      customerId: "cust-1",
      budget,
      estimatedUsd: 5.0,  // would push to $14 of $10 cap
      costReader,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("weekly");
  });

  it("returns ok=false when estimated spend exceeds monthly remaining", async () => {
    const budget = makeBudget({ weeklyUsdCap: 50, monthlyUsdCap: 30 });
    const costReader = makeCostReader(5.0, 28.0);  // $28 of $30 monthly used

    const result = await preflight({
      customerId: "cust-1",
      budget,
      estimatedUsd: 5.0,  // would push to $33 of $30 cap
      costReader,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("monthly");
  });

  it("treats null (no prior spend) as $0 for new customer — allows through", async () => {
    const budget = makeBudget({ weeklyUsdCap: 10, monthlyUsdCap: 30 });
    const costReader = makeCostReader(null, null);  // brand-new customer, no CAGG rows

    const result = await preflight({
      customerId: "new-cust",
      budget,
      estimatedUsd: 1.0,
      costReader,
    });

    // New customer: null → $0 spend → should pass
    expect(result.ok).toBe(true);
    expect(result.weeklySpent).toBe(0);
    expect(result.monthlySpent).toBe(0);
  });

  it("reads from CostReadPort (rollup), not full llm_call scan", async () => {
    // Verify that the CostReadPort.getRollingSpendUsd is called with window params,
    // demonstrating it reads from the rollup (cost_daily CAGG abstraction).
    const budget = makeBudget();
    const costReader = makeCostReader(1.0, 5.0);

    await preflight({ customerId: "cust-1", budget, estimatedUsd: 0.5, costReader });

    // getRollingSpendUsd should have been called with windowDays=7 and windowDays=30
    expect(costReader.getRollingSpendUsd).toHaveBeenCalledWith("cust-1", 7);
    expect(costReader.getRollingSpendUsd).toHaveBeenCalledWith("cust-1", 30);
    // Should NOT have been called with any other window (no full scan)
    expect(costReader.getRollingSpendUsd).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// assertWithinCap — per-call guard (FAIL-CLOSED)
// ---------------------------------------------------------------------------

describe("assertWithinCap — per-call budget guard (fail-CLOSED)", () => {
  it("does not throw when within both caps", async () => {
    const budget = makeBudget({ weeklyUsdCap: 10, monthlyUsdCap: 30 });
    const costReader = makeCostReader(2.0, 5.0);

    await expect(
      assertWithinCap({ customerId: "cust-1", budget, costReader })
    ).resolves.toBeUndefined();
  });

  it("FAIL-CLOSED: throws CostDataMissingError when weeklySpend is null", async () => {
    const budget = makeBudget();
    const costReader = makeCostReader(null, 5.0);  // weekly null = CAGG missing

    await expect(
      assertWithinCap({ customerId: "cust-1", budget, costReader })
    ).rejects.toThrow(CostDataMissingError);
  });

  it("FAIL-CLOSED: throws CostDataMissingError when monthlySpend is null", async () => {
    const budget = makeBudget();
    const costReader = makeCostReader(2.0, null);  // monthly null = CAGG missing

    await expect(
      assertWithinCap({ customerId: "cust-1", budget, costReader })
    ).rejects.toThrow(CostDataMissingError);
  });

  it("FAIL-CLOSED: throws CostDataMissingError when BOTH are null", async () => {
    const budget = makeBudget();
    const costReader = makeCostReader(null, null);

    await expect(
      assertWithinCap({ customerId: "cust-1", budget, costReader })
    ).rejects.toThrow(CostDataMissingError);
  });

  it("throws BudgetExceededError when weekly cap reached", async () => {
    const budget = makeBudget({ weeklyUsdCap: 10 });
    const costReader = makeCostReader(10.0, 15.0);  // exactly at weekly cap

    await expect(
      assertWithinCap({ customerId: "cust-1", budget, costReader })
    ).rejects.toThrow(BudgetExceededError);
  });

  it("BudgetExceededError.capType='weekly' when weekly cap hit", async () => {
    const budget = makeBudget({ weeklyUsdCap: 10 });
    const costReader = makeCostReader(10.5, 5.0);

    try {
      await assertWithinCap({ customerId: "cust-1", budget, costReader });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).capType).toBe("weekly");
    }
  });

  it("throws BudgetExceededError when monthly cap reached", async () => {
    const budget = makeBudget({ weeklyUsdCap: 50, monthlyUsdCap: 30 });
    const costReader = makeCostReader(5.0, 30.0);  // exactly at monthly cap

    await expect(
      assertWithinCap({ customerId: "cust-1", budget, costReader })
    ).rejects.toThrow(BudgetExceededError);
  });

  it("BudgetExceededError.capType='monthly' when monthly cap hit", async () => {
    const budget = makeBudget({ weeklyUsdCap: 50, monthlyUsdCap: 30 });
    const costReader = makeCostReader(5.0, 35.0);

    try {
      await assertWithinCap({ customerId: "cust-1", budget, costReader });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).capType).toBe("monthly");
    }
  });

  it("reads from rollup CostReadPort with correct window params", async () => {
    const budget = makeBudget();
    const costReader = makeCostReader(1.0, 5.0);

    await assertWithinCap({ customerId: "cust-42", budget, costReader });

    expect(costReader.getRollingSpendUsd).toHaveBeenCalledWith("cust-42", 7);
    expect(costReader.getRollingSpendUsd).toHaveBeenCalledWith("cust-42", 30);
    expect(costReader.getRollingSpendUsd).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// assertWithinCapOrNew — variant for first call of fresh run
// ---------------------------------------------------------------------------

describe("assertWithinCapOrNew — new customer variant", () => {
  it("allows through when isNewCustomer=true and data missing", async () => {
    const budget = makeBudget();
    const costReader = makeCostReader(null, null);

    await expect(
      assertWithinCapOrNew({
        customerId: "new-cust",
        budget,
        costReader,
        isNewCustomer: true,
      })
    ).resolves.toBeUndefined();
  });

  it("fails closed when isNewCustomer=false and data missing", async () => {
    const budget = makeBudget();
    const costReader = makeCostReader(null, null);

    await expect(
      assertWithinCapOrNew({
        customerId: "existing-cust",
        budget,
        costReader,
        isNewCustomer: false,
      })
    ).rejects.toThrow(CostDataMissingError);
  });

  it("still enforces weekly cap for existing customer with data", async () => {
    const budget = makeBudget({ weeklyUsdCap: 10 });
    const costReader = makeCostReader(12.0, 5.0);

    await expect(
      assertWithinCapOrNew({
        customerId: "cust-1",
        budget,
        costReader,
        isNewCustomer: false,
      })
    ).rejects.toThrow(BudgetExceededError);
  });
});

// ---------------------------------------------------------------------------
// estimatePlanCost — pure utility
// ---------------------------------------------------------------------------

describe("estimatePlanCost — rough pre-execution estimate", () => {
  it("0 work-units → 0 cost", () => {
    expect(estimatePlanCost(0, 0.001, 0.0005)).toBe(0);
  });

  it("N work-units × (genUsd + judgeUsd)", () => {
    // 10 work-units, gen=$0.001, judge=$0.0005 → total = 10 × 0.0015 = 0.015
    expect(estimatePlanCost(10, 0.001, 0.0005)).toBeCloseTo(0.015);
  });

  it("is linear in nWorkUnits", () => {
    const single = estimatePlanCost(1, 0.01, 0.005);
    const ten = estimatePlanCost(10, 0.01, 0.005);
    expect(ten).toBeCloseTo(single * 10);
  });
});
