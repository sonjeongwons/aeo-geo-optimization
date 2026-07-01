/**
 * test/sweep-v10-self-audit-fixes.test.ts
 *
 * Regression lock for SOTA sweep v10 Z1 (§7 false-certainty): a CONSTANT binary
 * outcome (brand never mentioned — the common "SMR 0%" baseline, or always
 * mentioned) is estimable but has zero total variance, so dStudy must NOT certify
 * it as a perfect zero-SE / samplingAdequate design.
 * (Z2 is a UI-only fix in the Next.js pages — covered by web tsc + review.)
 */
import { describe, it, expect } from "vitest";
import { estimateVarianceComponents, dStudy } from "../src/metrics/varianceComponents.js";

describe("Z1 — dStudy refuses a constant (zero-variance) outcome", () => {
  it("all-zero outcome (brand never mentioned) is NOT certified adequate", () => {
    const vc = estimateVarianceComponents([
      { hits: 0, n: 10 },
      { hits: 0, n: 10 },
      { hits: 0, n: 10 },
    ]);
    expect(vc.estimable).toBe(true); // estimable...
    expect(vc.sigma2Prompt + vc.sigma2Resid).toBe(0); // ...but zero variance
    const d = dStudy(vc, { targetSe: 0.05, nPromptsCurrent: 3, nRunsPerPromptCurrent: 10 });
    expect(d.currentSe).toBe(Infinity); // → null in the wrapper, "측정 불가" in UI
    expect(d.samplingAdequate).toBe(false);
    expect(d.recommendedRunsPerPrompt).toBeNull();
    expect(d.recommendedPrompts).toBeNull();
  });

  it("all-one outcome (brand always mentioned) is likewise not certified", () => {
    const vc = estimateVarianceComponents([
      { hits: 10, n: 10 },
      { hits: 10, n: 10 },
    ]);
    const d = dStudy(vc, { targetSe: 0.05, nPromptsCurrent: 2, nRunsPerPromptCurrent: 10 });
    expect(d.samplingAdequate).toBe(false);
    expect(d.currentSe).toBe(Infinity);
  });

  it("a genuinely varied outcome is STILL evaluated normally", () => {
    const vc = estimateVarianceComponents([
      { hits: 8, n: 10 },
      { hits: 2, n: 10 },
      { hits: 5, n: 10 },
    ]);
    const d = dStudy(vc, { targetSe: 1, nPromptsCurrent: 3, nRunsPerPromptCurrent: 10 });
    expect(Number.isFinite(d.currentSe)).toBe(true);
    expect(d.samplingAdequate).toBe(true); // loose target → adequate
  });
});
