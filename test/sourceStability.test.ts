/**
 * test/sourceStability.test.ts — unit tests for src/metrics/sourceStability.ts
 *
 * Covers: jaccardSet, rbo, gini, computeSourceStability.
 * All tests are deterministic; no IO or randomness.
 */

import { describe, it, expect } from "vitest";
import {
  jaccardSet,
  rbo,
  gini,
  computeSourceStability,
} from "../src/metrics/sourceStability.js";

// ---------------------------------------------------------------------------
// jaccardSet
// ---------------------------------------------------------------------------

describe("jaccardSet", () => {
  it("identical sets → 1", () => {
    expect(jaccardSet(["a.com", "b.com"], ["a.com", "b.com"])).toBe(1);
  });

  it("disjoint sets → 0", () => {
    expect(jaccardSet(["a.com"], ["b.com"])).toBe(0);
  });

  it("both empty → 1 (vacuously identical)", () => {
    expect(jaccardSet([], [])).toBe(1);
  });

  it("partial overlap {a,b,c} vs {b,c,d} → 0.5", () => {
    // intersection={b,c}(2), union={a,b,c,d}(4) → 2/4 = 0.5
    expect(jaccardSet(["a", "b", "c"], ["b", "c", "d"])).toBe(0.5);
  });

  it("lowercases inputs internally", () => {
    expect(jaccardSet(["A.COM", "B.COM"], ["a.com", "b.com"])).toBe(1);
  });

  it("deduplicates inputs internally", () => {
    // [a,a,b] deduped → {a,b}; same as [a,b]
    expect(jaccardSet(["a", "a", "b"], ["a", "b"])).toBe(1);
  });

  it("one empty, one non-empty → 0", () => {
    expect(jaccardSet([], ["a.com"])).toBe(0);
    expect(jaccardSet(["a.com"], [])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rbo
// ---------------------------------------------------------------------------

describe("rbo", () => {
  it("identical lists → 1", () => {
    expect(rbo(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
  });

  it("both empty → 1", () => {
    expect(rbo([], [])).toBe(1);
  });

  it("exactly one empty → 0", () => {
    expect(rbo([], ["a", "b"])).toBe(0);
    expect(rbo(["a", "b"], [])).toBe(0);
  });

  it("completely disjoint lists → 0", () => {
    expect(rbo(["a", "b"], ["c", "d"])).toBe(0);
  });

  it("reversed lists < 1 (rank order matters)", () => {
    const forward = ["a", "b", "c", "d"];
    const backward = ["d", "c", "b", "a"];
    const score = rbo(forward, backward);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("p weighting: higher agreement at top scores higher than agreement only at bottom", () => {
    // Top-match case: agreement at positions 1-2, mismatch at 3-4
    const topMatch = rbo(["a", "b", "c", "d"], ["a", "b", "x", "y"]);
    // Bottom-match case: mismatch at 1-2, agreement at 3-4
    const bottomMatch = rbo(["a", "b", "c", "d"], ["x", "y", "c", "d"]);
    expect(topMatch).toBeGreaterThan(bottomMatch);
  });

  it("single-element identical → 1", () => {
    expect(rbo(["a"], ["a"])).toBe(1);
  });

  it("lowercases inputs", () => {
    expect(rbo(["A", "B"], ["a", "b"])).toBe(1);
  });

  it("throws on p out of (0,1)", () => {
    expect(() => rbo(["a"], ["a"], 0)).toThrow(RangeError);
    expect(() => rbo(["a"], ["a"], 1)).toThrow(RangeError);
    expect(() => rbo(["a"], ["a"], 1.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// gini
// ---------------------------------------------------------------------------

describe("gini", () => {
  it("perfectly equal counts → ~0", () => {
    const g = gini([5, 5, 5, 5]);
    expect(g).not.toBeNull();
    expect(g as number).toBeCloseTo(0, 10);
  });

  it("all-zero → null (§7: no distribution to measure)", () => {
    expect(gini([0, 0, 0])).toBeNull();
  });

  it("empty → null", () => {
    expect(gini([])).toBeNull();
  });

  it("one-hot [0,0,10] → high (close to 1 − 1/n)", () => {
    // For n=3, theoretical max Gini ≈ (n-1)/n = 2/3 ≈ 0.667
    const g = gini([0, 0, 10]);
    expect(g).not.toBeNull();
    expect(g as number).toBeGreaterThan(0.5);
    // Should be close to 2/3
    expect(g as number).toBeCloseTo(2 / 3, 5);
  });

  it("single element → 0 (no variance possible)", () => {
    const g = gini([7]);
    expect(g).not.toBeNull();
    expect(g as number).toBeCloseTo(0, 10);
  });

  it("more concentrated → higher Gini", () => {
    const even = gini([3, 3, 3, 3]) as number;
    const skewed = gini([10, 1, 1, 0]) as number;
    expect(skewed).toBeGreaterThan(even);
  });
});

// ---------------------------------------------------------------------------
// computeSourceStability
// ---------------------------------------------------------------------------

describe("computeSourceStability", () => {
  it("nRuns < 2 → meanPairwiseJaccard null, meanPairwiseRbo null, volatile false", () => {
    const result0 = computeSourceStability([]);
    expect(result0.nRuns).toBe(0);
    expect(result0.meanPairwiseJaccard).toBeNull();
    expect(result0.meanPairwiseRbo).toBeNull();
    expect(result0.volatile).toBe(false);

    const result1 = computeSourceStability([["a.com", "b.com"]]);
    expect(result1.nRuns).toBe(1);
    expect(result1.meanPairwiseJaccard).toBeNull();
    expect(result1.meanPairwiseRbo).toBeNull();
    expect(result1.volatile).toBe(false);
  });

  it("3 identical runs → meanPairwiseJaccard 1, volatile false", () => {
    const run = ["a.com", "b.com", "c.com"];
    const result = computeSourceStability([run, run, run]);
    expect(result.nRuns).toBe(3);
    expect(result.meanPairwiseJaccard).toBe(1);
    expect(result.meanPairwiseRbo).toBe(1);
    expect(result.volatile).toBe(false);
  });

  it("3 fully disjoint runs → meanPairwiseJaccard 0, volatile true", () => {
    const result = computeSourceStability([
      ["a.com"],
      ["b.com"],
      ["c.com"],
    ]);
    expect(result.nRuns).toBe(3);
    expect(result.meanPairwiseJaccard).toBe(0);
    expect(result.volatile).toBe(true);
  });

  it("discloses jaccardThreshold and p on the returned struct", () => {
    const result = computeSourceStability([["a"], ["b"]], { p: 0.8, jaccardThreshold: 0.6 });
    expect(result.jaccardThreshold).toBe(0.6);
    expect(result.p).toBe(0.8);
  });

  it("defaults: p=0.9, jaccardThreshold=0.5", () => {
    const result = computeSourceStability([["a"], ["b"]]);
    expect(result.p).toBe(0.9);
    expect(result.jaccardThreshold).toBe(0.5);
  });

  it("determinism: two calls with same input produce deep-equal output", () => {
    const runs = [
      ["alpha.com", "beta.org"],
      ["beta.org", "gamma.net"],
      ["alpha.com", "delta.io"],
    ];
    const r1 = computeSourceStability(runs);
    const r2 = computeSourceStability(runs);
    expect(r1).toEqual(r2);
  });

  it("2 runs with partial overlap → jaccard between 0 and 1", () => {
    const result = computeSourceStability([
      ["a.com", "b.com", "c.com"],
      ["b.com", "c.com", "d.com"],
    ]);
    expect(result.meanPairwiseJaccard).toBeCloseTo(0.5, 10);
    expect(result.meanPairwiseRbo).not.toBeNull();
    expect(result.meanPairwiseRbo as number).toBeGreaterThan(0);
    expect(result.meanPairwiseRbo as number).toBeLessThan(1);
  });
});
