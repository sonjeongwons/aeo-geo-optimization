/**
 * test/sweep-v7-self-audit-fixes.test.ts
 *
 * Regression locks for the SOTA sweep v7 self-audit bugs in the M-tier modules
 * shipped this session (X9/X11/X30). Each was critic-verified in the source.
 *
 *   Z1  confidenceSequence radius was NOT anytime-valid (per-look budget diverged)
 *   Z2  proportionCS pointEstimate unclamped (successes>n → out-of-[0,1])
 *   Z3  debiasedVisibility zero-width CI from zero observations
 *   Z4  debiasedVisibility zero-width CI at boundary rates p_obs∈{0,1}
 *   Z6  calibrated note hardcoded "95 %" ignoring caller z
 *   Z8  confidenceSequence missing alpha-domain guard
 *   Z9  gini missing negative/non-finite guard
 */

import { describe, it, expect } from "vitest";
import { proportionCS, proportionDiffCS } from "../src/metrics/confidenceSequence.js";
import { debiasedVisibility } from "../src/judge/judgeDebias.js";
import { gini } from "../src/metrics/sourceStability.js";

// Reference: the corrected union-bound radius h(n) = sqrt(log(π²n²/(3α))/(2n)).
const hRef = (n: number, alpha: number) =>
  Math.sqrt(Math.log((Math.PI * Math.PI * n * n) / (3 * alpha)) / (2 * n));

describe("Z1 — confidenceSequence radius is the anytime-valid union-bound form", () => {
  it("single-arm half-width matches sqrt(log(π²n²/(3α))/(2n))", () => {
    const cs = proportionCS(50, 100, 0.05);
    expect(cs.halfWidth).toBeCloseTo(hRef(100, 0.05), 12);
  });
  it("difference combines additively with α/2 per arm (triangle, not RSS)", () => {
    // Choose values far from the clamp so the width is exact.
    const ds = proportionDiffCS(600, 1000, 400, 1000, 0.05);
    const expectedCombined = hRef(1000, 0.025) + hRef(1000, 0.025);
    expect(ds.upper - ds.lower).toBeCloseTo(2 * expectedCombined, 10);
    // Additive width is strictly wider than the (invalid) root-sum-of-squares.
    const rss = Math.SQRT2 * hRef(1000, 0.05);
    expect(expectedCombined).toBeGreaterThan(rss);
  });
});

describe("Z2 — proportionCS clamps the point estimate", () => {
  it("successes>n clamps pointEstimate to 1 and keeps the interval in [0,1]", () => {
    const cs = proportionCS(10, 5, 0.05);
    expect(cs.pointEstimate).toBe(1);
    expect(cs.lower).toBeGreaterThanOrEqual(0);
    expect(cs.upper).toBeLessThanOrEqual(1);
  });
});

describe("Z8 — confidenceSequence guards the alpha domain", () => {
  it("throws RangeError for alpha<=0 or alpha>=1", () => {
    expect(() => proportionCS(5, 10, 0)).toThrow(RangeError);
    expect(() => proportionCS(5, 10, 1)).toThrow(RangeError);
    expect(() => proportionDiffCS(5, 10, 4, 10, 1.5)).toThrow(RangeError);
  });
});

describe("Z3 — debiasedVisibility: zero observations → undefined CI, not zero-width", () => {
  it("nObs=0 returns a point estimate with null CI bounds", () => {
    const r = debiasedVisibility(0.5, 0, 0.9, 0.8);
    expect(r.correctedRate).not.toBeNull();
    expect(r.ciLow).toBeNull();
    expect(r.ciHigh).toBeNull();
    expect(r.calibrated).toBe(false);
  });
});

describe("Z4 — debiasedVisibility: boundary rates do not collapse the CI", () => {
  it("p_obs=1 yields a positive-width CI from 50 observations", () => {
    const r = debiasedVisibility(1, 50, 0.9, 0.9);
    expect(r.ciLow).not.toBeNull();
    expect(r.ciHigh! - r.ciLow!).toBeGreaterThan(0);
  });
  it("p_obs=0 yields a positive-width CI from 50 observations", () => {
    const r = debiasedVisibility(0, 50, 0.9, 0.9);
    expect(r.ciHigh! - r.ciLow!).toBeGreaterThan(0);
  });
});

describe("Z6 — calibrated note derives the CI level from z", () => {
  it("default z=1.96 labels the CI 95 %", () => {
    const r = debiasedVisibility(0.5, 100, 0.9, 0.8, { seN: 50, spN: 50 });
    expect(r.calibrated).toBe(true);
    expect(r.note).toMatch(/95(\.0)? %/);
  });
  it("z=2.576 labels the CI ~99 %, not 95 %", () => {
    const r = debiasedVisibility(0.5, 100, 0.9, 0.8, { seN: 50, spN: 50, z: 2.576 });
    expect(r.note).toMatch(/99(\.0)? %/);
    expect(r.note).not.toMatch(/95 %/);
  });
});

describe("Z9 — gini rejects invalid frequency vectors", () => {
  it("returns null on negative or non-finite counts", () => {
    expect(gini([-2, -1])).toBeNull();
    expect(gini([0, 100, NaN])).toBeNull();
    expect(gini([Infinity, 1])).toBeNull();
  });
  it("still computes for a valid non-negative vector (equal → ~0)", () => {
    expect(gini([5, 5, 5])).toBeCloseTo(0, 10);
  });
});
