/**
 * test/sweep-v8-self-audit-fixes.test.ts
 *
 * Regression locks for the SOTA sweep v8 self-audit bugs in X10 (varianceComponents).
 *   Z1  dStudy certified a non-estimable design as a perfect SE=0 result
 *   Z2  non-integer hits/n bypassed the filter and broke the binary SSW identity
 *   Z3  (doc-only) currentSe disclosed as a balanced projection — covered by Z1's path
 */
import { describe, it, expect } from "vitest";
import { estimateVarianceComponents, dStudy } from "../src/metrics/varianceComponents.js";

describe("Z1 — dStudy never certifies a non-estimable design", () => {
  it("non-estimable vc → currentSe Infinity, samplingAdequate false, no recommendations", () => {
    const vc = estimateVarianceComponents([{ hits: 1, n: 3 }]); // P<2 → not estimable
    expect(vc.estimable).toBe(false);
    const d = dStudy(vc, { targetSe: 0.05, nPromptsCurrent: 1, nRunsPerPromptCurrent: 3 });
    expect(d.currentSe).toBe(Infinity);
    expect(d.samplingAdequate).toBe(false);
    expect(d.recommendedRunsPerPrompt).toBeNull();
    expect(d.recommendedPrompts).toBeNull();
  });

  it("all-n=1 design (no residual df) is also refused", () => {
    const vc = estimateVarianceComponents([
      { hits: 1, n: 1 },
      { hits: 0, n: 1 },
    ]);
    const d = dStudy(vc, { targetSe: 0.1, nPromptsCurrent: 2, nRunsPerPromptCurrent: 1 });
    expect(d.samplingAdequate).toBe(false);
    expect(d.currentSe).toBe(Infinity);
  });
});

describe("Z2 — non-integer tallies are dropped", () => {
  it("fractional hits/n are excluded (would break the binary SSW identity)", () => {
    const vc = estimateVarianceComponents([
      { hits: 2.5, n: 3 }, // fractional → dropped
      { hits: 2, n: 4 },
      { hits: 3, n: 4 },
    ]);
    expect(vc.nPrompts).toBe(2);
  });
  it("non-integer n is excluded", () => {
    const vc = estimateVarianceComponents([
      { hits: 1, n: 2.5 },
      { hits: 2, n: 4 },
      { hits: 3, n: 4 },
    ]);
    expect(vc.nPrompts).toBe(2);
  });
});
