/**
 * test/confidenceSequence.test.ts
 *
 * Tests for the anytime-valid confidence sequence module (Feature X30).
 * All tests are deterministic — no randomness, no IO.
 */
import { describe, it, expect } from "vitest";
import {
  proportionCS,
  proportionDiffCS,
} from "../src/metrics/confidenceSequence.js";

// ---------------------------------------------------------------------------
// proportionCS — single-proportion anytime-valid CS
// ---------------------------------------------------------------------------

describe("proportionCS — point estimate", () => {
  it("returns the correct sample proportion as pointEstimate", () => {
    const cs = proportionCS(30, 100);
    expect(cs.pointEstimate).toBeCloseTo(0.3, 10);
  });

  it("returns pointEstimate 0 when n = 0", () => {
    const cs = proportionCS(0, 0);
    expect(cs.pointEstimate).toBe(0);
  });

  it("returns pointEstimate 1 for all-success arm", () => {
    const cs = proportionCS(50, 50);
    expect(cs.pointEstimate).toBeCloseTo(1, 10);
  });
});

describe("proportionCS — interval bounds", () => {
  it("lower and upper are within [0, 1]", () => {
    for (const [s, n] of [[0, 10], [5, 10], [10, 10], [1, 1000]] as const) {
      const cs = proportionCS(s, n);
      expect(cs.lower).toBeGreaterThanOrEqual(0);
      expect(cs.upper).toBeLessThanOrEqual(1);
      expect(cs.lower).toBeLessThanOrEqual(cs.upper);
    }
  });

  it("interval brackets pointEstimate (before clamping effects)", () => {
    const cs = proportionCS(40, 100);
    expect(cs.lower).toBeLessThan(cs.pointEstimate);
    expect(cs.upper).toBeGreaterThan(cs.pointEstimate);
  });
});

describe("proportionCS — n = 0 degenerate case", () => {
  it("n = 0 returns [0, 1] with halfWidth Infinity", () => {
    const cs = proportionCS(0, 0);
    expect(cs.lower).toBe(0);
    expect(cs.upper).toBe(1);
    expect(cs.halfWidth).toBe(Infinity);
    expect(cs.n).toBe(0);
  });
});

describe("proportionCS — halfWidth shrinks as n grows", () => {
  it("halfWidth at n=10_000 is strictly smaller than at n=10", () => {
    const small = proportionCS(5, 10);
    const large = proportionCS(5000, 10_000);
    expect(large.halfWidth).toBeLessThan(small.halfWidth);
  });

  it("halfWidth at n=1_000 is smaller than at n=100", () => {
    const cs100 = proportionCS(50, 100);
    const cs1000 = proportionCS(500, 1_000);
    expect(cs1000.halfWidth).toBeLessThan(cs100.halfWidth);
  });
});

describe("proportionCS — alpha effect", () => {
  it("smaller alpha produces a wider interval (more conservative)", () => {
    const cs05 = proportionCS(50, 200, 0.05);
    const cs01 = proportionCS(50, 200, 0.01);
    expect(cs01.halfWidth).toBeGreaterThan(cs05.halfWidth);
  });
});

describe("proportionCS — determinism", () => {
  it("two identical calls produce deep-equal results", () => {
    const a = proportionCS(37, 200, 0.05);
    const b = proportionCS(37, 200, 0.05);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// proportionDiffCS — two-proportion difference anytime-valid CS
// ---------------------------------------------------------------------------

describe("proportionDiffCS — equal arms", () => {
  it("diff is 0 when both arms are identical", () => {
    const ds = proportionDiffCS(20, 100, 20, 100);
    expect(ds.diff).toBeCloseTo(0, 10);
  });

  it("crossedZero is true when arms are identical (interval straddles 0)", () => {
    const ds = proportionDiffCS(20, 100, 20, 100);
    expect(ds.crossedZero).toBe(true);
  });
});

describe("proportionDiffCS — large-n with clear difference", () => {
  it("crossedZero is false when proportions differ substantially at large n", () => {
    // 80% vs 20% at n = 50_000 each — the CS should exclude 0.
    const ds = proportionDiffCS(40_000, 50_000, 10_000, 50_000);
    expect(ds.crossedZero).toBe(false);
  });

  it("diff sign is correct: pA > pB → diff > 0", () => {
    const ds = proportionDiffCS(40_000, 50_000, 10_000, 50_000);
    expect(ds.diff).toBeGreaterThan(0);
  });

  it("diff sign is correct: pA < pB → diff < 0", () => {
    const ds = proportionDiffCS(10_000, 50_000, 40_000, 50_000);
    expect(ds.diff).toBeLessThan(0);
  });
});

describe("proportionDiffCS — interval bounds", () => {
  it("lower and upper are within [-1, 1]", () => {
    const cases: Array<[number, number, number, number]> = [
      [0, 10, 10, 10],
      [10, 10, 0, 10],
      [5, 1000, 8, 1000],
      [999, 1000, 1, 1000],
    ];
    for (const [sA, nA, sB, nB] of cases) {
      const ds = proportionDiffCS(sA, nA, sB, nB);
      expect(ds.lower).toBeGreaterThanOrEqual(-1);
      expect(ds.upper).toBeLessThanOrEqual(1);
      expect(ds.lower).toBeLessThanOrEqual(ds.upper);
    }
  });

  it("interval brackets diff (before clamping) at moderate n", () => {
    const ds = proportionDiffCS(60, 200, 30, 200);
    expect(ds.lower).toBeLessThan(ds.diff);
    expect(ds.upper).toBeGreaterThan(ds.diff);
  });
});

describe("proportionDiffCS — n = 0 degenerate case", () => {
  it("nA = 0 → [−1, 1] with crossedZero true", () => {
    const ds = proportionDiffCS(0, 0, 5, 50);
    expect(ds.lower).toBe(-1);
    expect(ds.upper).toBe(1);
    expect(ds.crossedZero).toBe(true);
  });

  it("nB = 0 → [−1, 1] with crossedZero true", () => {
    const ds = proportionDiffCS(5, 50, 0, 0);
    expect(ds.lower).toBe(-1);
    expect(ds.upper).toBe(1);
    expect(ds.crossedZero).toBe(true);
  });

  it("both n = 0 → [−1, 1] with crossedZero true", () => {
    const ds = proportionDiffCS(0, 0, 0, 0);
    expect(ds.lower).toBe(-1);
    expect(ds.upper).toBe(1);
    expect(ds.crossedZero).toBe(true);
  });
});

describe("proportionDiffCS — alpha effect", () => {
  it("smaller alpha gives a wider interval (more conservative)", () => {
    const ds05 = proportionDiffCS(60, 200, 40, 200, 0.05);
    const ds01 = proportionDiffCS(60, 200, 40, 200, 0.01);
    const width05 = ds05.upper - ds05.lower;
    const width01 = ds01.upper - ds01.lower;
    expect(width01).toBeGreaterThan(width05);
  });
});

describe("proportionDiffCS — alpha is stored in result", () => {
  it("result.alpha equals the argument passed in", () => {
    expect(proportionDiffCS(10, 50, 8, 50, 0.1).alpha).toBe(0.1);
    expect(proportionDiffCS(10, 50, 8, 50, 0.01).alpha).toBe(0.01);
  });
});

describe("proportionDiffCS — determinism", () => {
  it("two identical calls produce deep-equal results", () => {
    const a = proportionDiffCS(37, 200, 22, 180, 0.05);
    const b = proportionDiffCS(37, 200, 22, 180, 0.05);
    expect(a).toEqual(b);
  });
});
