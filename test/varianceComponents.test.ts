/**
 * test/varianceComponents.test.ts — X10 G-theory variance decomposition + D-study.
 * Tests the MoM math at boundaries (per the v7 lesson: verify the statistics,
 * not just the happy path).
 */
import { describe, it, expect } from "vitest";
import {
  estimateVarianceComponents,
  predictMeanSe,
  dStudy,
  type PromptTally,
} from "../src/metrics/varianceComponents.js";

describe("estimateVarianceComponents — estimability guards", () => {
  it("not estimable with <2 prompts", () => {
    const vc = estimateVarianceComponents([{ hits: 3, n: 10 }]);
    expect(vc.estimable).toBe(false);
    expect(vc.icc).toBeNull();
    expect(vc.nPrompts).toBe(1);
  });
  it("not estimable when every prompt has n=1 (no residual df)", () => {
    const vc = estimateVarianceComponents([
      { hits: 1, n: 1 },
      { hits: 0, n: 1 },
      { hits: 1, n: 1 },
    ]);
    expect(vc.estimable).toBe(false);
    expect(vc.note).toMatch(/residual/i);
  });
  it("empty input → not estimable, grandMean 0", () => {
    const vc = estimateVarianceComponents([]);
    expect(vc.estimable).toBe(false);
    expect(vc.grandMean).toBe(0);
  });
  it("drops invalid prompts (hits>n, negative, non-finite n)", () => {
    const vc = estimateVarianceComponents([
      { hits: 5, n: 3 }, // invalid hits>n
      { hits: 2, n: 4 },
      { hits: 3, n: 4 },
    ]);
    expect(vc.nPrompts).toBe(2);
  });
});

describe("estimateVarianceComponents — decomposition math", () => {
  it("all prompts identical rate → ~0 between-prompt variance", () => {
    // Every prompt 5/10 → no between-prompt variation; residual = 0.25.
    const prompts: PromptTally[] = Array.from({ length: 6 }, () => ({ hits: 5, n: 10 }));
    const vc = estimateVarianceComponents(prompts);
    expect(vc.estimable).toBe(true);
    expect(vc.sigma2Prompt).toBeCloseTo(0, 6);
    // MSW = ΣSSW/(N−P): each prompt SSW = n·p̂(1−p̂)=10·0.25=2.5, ×6=15, /(60−6)=15/54
    // (the unbiased pooled estimate; = Bernoulli 0.25 × 60/54), NOT a naive 0.25.
    expect(vc.sigma2Resid).toBeCloseTo(15 / 54, 6);
    expect(vc.icc).toBeCloseTo(0, 6);
  });
  it("strong between-prompt separation → positive σ²_prompt and ICC", () => {
    // Half the prompts ~all hits, half ~no hits → large between-prompt variance.
    const prompts: PromptTally[] = [
      { hits: 10, n: 10 }, { hits: 9, n: 10 }, { hits: 10, n: 10 },
      { hits: 0, n: 10 }, { hits: 1, n: 10 }, { hits: 0, n: 10 },
    ];
    const vc = estimateVarianceComponents(prompts);
    expect(vc.sigma2Prompt).toBeGreaterThan(vc.sigma2Resid);
    expect(vc.icc!).toBeGreaterThan(0.8);
  });
  it("negative MoM between-variance is clamped to 0 with a note", () => {
    // Balanced, rates very close → MSB can dip below MSW → negative raw → clamp.
    const prompts: PromptTally[] = [
      { hits: 5, n: 10 }, { hits: 5, n: 10 }, { hits: 5, n: 10 }, { hits: 5, n: 10 },
    ];
    const vc = estimateVarianceComponents(prompts);
    expect(vc.sigma2Prompt).toBe(0);
  });
  it("grandMean is the pooled rate", () => {
    const vc = estimateVarianceComponents([
      { hits: 2, n: 10 },
      { hits: 8, n: 10 },
    ]);
    expect(vc.grandMean).toBeCloseTo(0.5, 9);
  });
});

describe("predictMeanSe", () => {
  it("SE shrinks as prompts grow", () => {
    const vc = { sigma2Prompt: 0.1, sigma2Resid: 0.2 };
    expect(predictMeanSe(vc, 100, 3)).toBeLessThan(predictMeanSe(vc, 10, 3));
  });
  it("SE shrinks as runs grow (but floored by between-prompt term)", () => {
    const vc = { sigma2Prompt: 0.1, sigma2Resid: 0.2 };
    const many = predictMeanSe(vc, 10, 1000);
    const few = predictMeanSe(vc, 10, 2);
    expect(many).toBeLessThan(few);
    // Adding runs cannot beat sqrt(σ²_prompt/P).
    expect(many).toBeGreaterThan(Math.sqrt(0.1 / 10) - 1e-9);
  });
  it("Infinity for non-positive design", () => {
    expect(predictMeanSe({ sigma2Prompt: 0.1, sigma2Resid: 0.2 }, 0, 5)).toBe(Infinity);
  });
});

describe("dStudy", () => {
  const vc = estimateVarianceComponents([
    { hits: 8, n: 10 }, { hits: 7, n: 10 }, { hits: 2, n: 10 }, { hits: 3, n: 10 },
  ]);

  it("throws on targetSe <= 0", () => {
    expect(() => dStudy(vc, { targetSe: 0, nPromptsCurrent: 4, nRunsPerPromptCurrent: 10 })).toThrow(RangeError);
  });
  it("samplingAdequate true when target is loose", () => {
    const d = dStudy(vc, { targetSe: 1, nPromptsCurrent: 4, nRunsPerPromptCurrent: 10 });
    expect(d.samplingAdequate).toBe(true);
  });
  it("recommends MORE PROMPTS for a tight target, always reachable", () => {
    const d = dStudy(vc, { targetSe: 0.02, nPromptsCurrent: 4, nRunsPerPromptCurrent: 10 });
    expect(d.samplingAdequate).toBe(false);
    expect(d.recommendedPrompts).toBeGreaterThan(4);
  });
  it("recommendedRunsPerPrompt is null when between-prompt variance alone exceeds target", () => {
    // σ²_prompt is large; a tiny target can't be reached by adding runs at fixed P.
    const d = dStudy(vc, { targetSe: 0.01, nPromptsCurrent: 4, nRunsPerPromptCurrent: 10 });
    expect(d.recommendedRunsPerPrompt).toBeNull();
  });
});
