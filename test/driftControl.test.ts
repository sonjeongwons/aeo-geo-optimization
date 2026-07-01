/**
 * test/driftControl.test.ts — W7 DiD drift-control estimator tests.
 *
 * Covers:
 *  - Pure ecosystem shift: targeted and holdout both move equally → netEffect ≈ 0
 *  - Real content effect: targeted up more than holdout → netEffect > 0, ≈ gap
 *  - Negative net: targeted underperforms drift → netEffect < 0
 *  - CI widens as n shrinks
 *  - lowPower true when any cell < minN
 *  - RangeError on hits > n, negative n, z <= 0
 *  - note string mentions ecosystem drift
 *  - Determinism (same input → same output)
 */
import { describe, it, expect } from "vitest";
import { computeDriftControl } from "../src/metrics/driftControl.js";
import type { Cell, DriftControlResult } from "../src/metrics/driftControl.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cell(hits: number, n: number): Cell {
  return { hits, n };
}

// ---------------------------------------------------------------------------
// Pure ecosystem shift — both cohorts move equally → netEffect ≈ 0
// ---------------------------------------------------------------------------

describe("pure ecosystem shift (targeted and holdout move equally)", () => {
  it("netEffect is approximately 0 when both cohorts increase by the same amount", () => {
    // Both before: 10/100 = 0.10; both after: 20/100 = 0.20 → drift = +0.10, targeted delta = +0.10
    const result = computeDriftControl({
      targetedBefore: cell(10, 100),
      targetedAfter: cell(20, 100),
      holdoutBefore: cell(10, 100),
      holdoutAfter: cell(20, 100),
    });
    expect(result.targetedDelta).toBeCloseTo(0.1, 6);
    expect(result.ecosystemDrift).toBeCloseTo(0.1, 6);
    expect(result.netEffect).toBeCloseTo(0, 6);
  });

  it("CI straddles 0 when net effect is 0", () => {
    const result = computeDriftControl({
      targetedBefore: cell(10, 100),
      targetedAfter: cell(20, 100),
      holdoutBefore: cell(10, 100),
      holdoutAfter: cell(20, 100),
    });
    expect(result.ci95.lower).toBeLessThan(0);
    expect(result.ci95.upper).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Real content effect — targeted up MORE than holdout → netEffect > 0
// ---------------------------------------------------------------------------

describe("real content effect", () => {
  it("netEffect is positive and approximates the gap when targeted outperforms drift", () => {
    // Targeted: 0.10 → 0.30 (delta = +0.20)
    // Holdout:  0.10 → 0.15 (drift = +0.05)
    // netEffect = 0.20 − 0.05 = 0.15
    const result = computeDriftControl({
      targetedBefore: cell(100, 1000),
      targetedAfter: cell(300, 1000),
      holdoutBefore: cell(100, 1000),
      holdoutAfter: cell(150, 1000),
    });
    expect(result.netEffect).toBeGreaterThan(0);
    expect(result.netEffect).toBeCloseTo(0.15, 4);
    expect(result.targetedDelta).toBeCloseTo(0.2, 4);
    expect(result.ecosystemDrift).toBeCloseTo(0.05, 4);
  });

  it("CI excludes 0 when n is large and effect is real", () => {
    const result = computeDriftControl({
      targetedBefore: cell(100, 1000),
      targetedAfter: cell(300, 1000),
      holdoutBefore: cell(100, 1000),
      holdoutAfter: cell(150, 1000),
    });
    expect(result.ci95.lower).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Negative net effect — targeted underperforms relative to drift
// ---------------------------------------------------------------------------

describe("negative net effect", () => {
  it("netEffect is negative when targeted underperforms the ecosystem drift", () => {
    // Targeted: 0.10 → 0.12 (delta = +0.02)
    // Holdout:  0.10 → 0.20 (drift = +0.10)
    // netEffect = 0.02 − 0.10 = −0.08
    const result = computeDriftControl({
      targetedBefore: cell(100, 1000),
      targetedAfter: cell(120, 1000),
      holdoutBefore: cell(100, 1000),
      holdoutAfter: cell(200, 1000),
    });
    expect(result.netEffect).toBeLessThan(0);
    expect(result.netEffect).toBeCloseTo(-0.08, 4);
    expect(result.ecosystemDrift).toBeCloseTo(0.1, 4);
  });
});

// ---------------------------------------------------------------------------
// CI width grows as n shrinks
// ---------------------------------------------------------------------------

describe("CI width increases as n shrinks", () => {
  it("smaller n produces a wider CI than large n", () => {
    const largeN = computeDriftControl({
      targetedBefore: cell(100, 1000),
      targetedAfter: cell(150, 1000),
      holdoutBefore: cell(100, 1000),
      holdoutAfter: cell(110, 1000),
    });

    const smallN = computeDriftControl({
      targetedBefore: cell(3, 30),
      targetedAfter: cell(5, 30),
      holdoutBefore: cell(3, 30),
      holdoutAfter: cell(4, 30),
    });

    const widthLarge = largeN.ci95.upper - largeN.ci95.lower;
    const widthSmall = smallN.ci95.upper - smallN.ci95.lower;
    expect(widthSmall).toBeGreaterThan(widthLarge);
  });
});

// ---------------------------------------------------------------------------
// lowPower flag
// ---------------------------------------------------------------------------

describe("lowPower flag", () => {
  it("is false when all cells have n >= minN (default 30)", () => {
    const result = computeDriftControl({
      targetedBefore: cell(10, 100),
      targetedAfter: cell(15, 100),
      holdoutBefore: cell(10, 100),
      holdoutAfter: cell(12, 100),
    });
    expect(result.lowPower).toBe(false);
  });

  it("is true when any cell n < default minN (30)", () => {
    const result = computeDriftControl({
      targetedBefore: cell(2, 10), // n=10 < 30
      targetedAfter: cell(3, 100),
      holdoutBefore: cell(5, 100),
      holdoutAfter: cell(6, 100),
    });
    expect(result.lowPower).toBe(true);
  });

  it("respects a custom minN option", () => {
    // All cells at n=50, minN=100 → lowPower true
    const result = computeDriftControl(
      {
        targetedBefore: cell(10, 50),
        targetedAfter: cell(12, 50),
        holdoutBefore: cell(10, 50),
        holdoutAfter: cell(11, 50),
      },
      { minN: 100 }
    );
    expect(result.lowPower).toBe(true);
  });

  it("is true when a cell has n=0 (empty cell)", () => {
    const result = computeDriftControl({
      targetedBefore: cell(0, 0),
      targetedAfter: cell(10, 100),
      holdoutBefore: cell(10, 100),
      holdoutAfter: cell(12, 100),
    });
    expect(result.lowPower).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation — RangeError cases
// ---------------------------------------------------------------------------

describe("validation: RangeError", () => {
  const good = {
    targetedBefore: cell(10, 100),
    targetedAfter: cell(15, 100),
    holdoutBefore: cell(10, 100),
    holdoutAfter: cell(12, 100),
  };

  it("throws RangeError when hits > n", () => {
    expect(() =>
      computeDriftControl({ ...good, targetedBefore: cell(101, 100) })
    ).toThrow(RangeError);
  });

  it("throws RangeError when n is negative", () => {
    expect(() =>
      computeDriftControl({ ...good, holdoutAfter: cell(0, -5) })
    ).toThrow(RangeError);
  });

  it("throws RangeError when hits is negative", () => {
    expect(() =>
      computeDriftControl({ ...good, targetedAfter: cell(-1, 100) })
    ).toThrow(RangeError);
  });

  it("throws RangeError when z <= 0", () => {
    expect(() => computeDriftControl(good, { z: 0 })).toThrow(RangeError);
    expect(() => computeDriftControl(good, { z: -1 })).toThrow(RangeError);
  });

  it("throws RangeError when minN < 1", () => {
    expect(() => computeDriftControl(good, { minN: 0 })).toThrow(RangeError);
  });

  it("throws RangeError when a cell has non-finite hits", () => {
    expect(() =>
      computeDriftControl({ ...good, holdoutBefore: cell(Infinity, 100) })
    ).toThrow(RangeError);
  });

  it("throws RangeError when a cell has non-finite n", () => {
    expect(() =>
      computeDriftControl({ ...good, holdoutBefore: cell(10, NaN) })
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// note string: mentions ecosystem drift
// ---------------------------------------------------------------------------

describe("note field", () => {
  it("mentions 'ecosystem drift' and 'holdout'", () => {
    const result = computeDriftControl({
      targetedBefore: cell(10, 100),
      targetedAfter: cell(20, 100),
      holdoutBefore: cell(10, 100),
      holdoutAfter: cell(15, 100),
    });
    expect(result.note).toMatch(/ecosystem drift/i);
    expect(result.note).toMatch(/holdout/i);
  });

  it("note includes net content effect value", () => {
    const result = computeDriftControl({
      targetedBefore: cell(10, 100),
      targetedAfter: cell(20, 100),
      holdoutBefore: cell(10, 100),
      holdoutAfter: cell(15, 100),
    });
    // netEffect = 0.10 - 0.05 = 0.05
    expect(result.note).toMatch(/net content effect/i);
  });

  it("note mentions 'Caution' when lowPower is true", () => {
    const result = computeDriftControl({
      targetedBefore: cell(1, 5), // n=5 < 30
      targetedAfter: cell(2, 5),
      holdoutBefore: cell(1, 100),
      holdoutAfter: cell(2, 100),
    });
    expect(result.lowPower).toBe(true);
    expect(result.note).toMatch(/caution/i);
  });

  it("note mentions 'Caution' and n=0 when a cell is empty", () => {
    const result = computeDriftControl({
      targetedBefore: cell(0, 0),
      targetedAfter: cell(10, 100),
      holdoutBefore: cell(10, 100),
      holdoutAfter: cell(12, 100),
    });
    expect(result.note).toMatch(/caution/i);
    expect(result.note).toMatch(/n=0/i);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("produces identical results for identical inputs", () => {
    const input = {
      targetedBefore: cell(15, 200),
      targetedAfter: cell(40, 200),
      holdoutBefore: cell(15, 200),
      holdoutAfter: cell(22, 200),
    };
    const r1: DriftControlResult = computeDriftControl(input);
    const r2: DriftControlResult = computeDriftControl(input);

    expect(r1.targetedDelta).toBe(r2.targetedDelta);
    expect(r1.ecosystemDrift).toBe(r2.ecosystemDrift);
    expect(r1.netEffect).toBe(r2.netEffect);
    expect(r1.ci95.lower).toBe(r2.ci95.lower);
    expect(r1.ci95.upper).toBe(r2.ci95.upper);
    expect(r1.lowPower).toBe(r2.lowPower);
    expect(r1.note).toBe(r2.note);
  });
});

// ---------------------------------------------------------------------------
// DiD formula correctness
// ---------------------------------------------------------------------------

describe("DiD formula correctness", () => {
  it("netEffect = targetedDelta − ecosystemDrift (identity check)", () => {
    const result = computeDriftControl({
      targetedBefore: cell(30, 300),
      targetedAfter: cell(90, 300),
      holdoutBefore: cell(30, 300),
      holdoutAfter: cell(45, 300),
    });
    expect(result.netEffect).toBeCloseTo(
      result.targetedDelta - result.ecosystemDrift,
      10
    );
  });

  it("ci95 lower <= netEffect <= ci95 upper", () => {
    const result = computeDriftControl({
      targetedBefore: cell(50, 500),
      targetedAfter: cell(100, 500),
      holdoutBefore: cell(50, 500),
      holdoutAfter: cell(60, 500),
    });
    expect(result.ci95.lower).toBeLessThanOrEqual(result.netEffect);
    expect(result.ci95.upper).toBeGreaterThanOrEqual(result.netEffect);
  });

  it("ci95 bounds are clamped to [−2, 2]", () => {
    // Extreme case: very small n → wide CI, clamped at boundaries
    const result = computeDriftControl(
      {
        targetedBefore: cell(0, 1),
        targetedAfter: cell(1, 1),
        holdoutBefore: cell(0, 1),
        holdoutAfter: cell(0, 1),
      },
      { minN: 1 }
    );
    expect(result.ci95.lower).toBeGreaterThanOrEqual(-2);
    expect(result.ci95.upper).toBeLessThanOrEqual(2);
  });
});
