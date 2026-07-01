/** test/significance.test.ts — hi-end audit MUST #4 Fisher exact + Newcombe CI. */
import { describe, it, expect } from "vitest";
import {
  fisherExactTwoSided,
  newcombeDiffCI,
  compareProportions,
  lgamma,
} from "../src/metrics/significance.js";

describe("lgamma", () => {
  it("matches known factorials via lgamma(n+1)=log(n!)", () => {
    expect(Math.exp(lgamma(1))).toBeCloseTo(1, 6); // 0! = 1
    expect(Math.exp(lgamma(6))).toBeCloseTo(120, 4); // 5! = 120
    expect(Math.exp(lgamma(11))).toBeCloseTo(3628800, 1); // 10!
  });
});

describe("fisherExactTwoSided (against known references)", () => {
  it("lady-tasting-tea [[3,1],[1,3]] ≈ 0.4857", () => {
    expect(fisherExactTwoSided(3, 1, 1, 3)).toBeCloseTo(0.4857, 3);
  });

  it("complete separation [[10,0],[0,10]] ≈ 1.08e-5", () => {
    expect(fisherExactTwoSided(10, 0, 0, 10)).toBeCloseTo(1.0825e-5, 8);
  });

  it("identical proportions give p=1", () => {
    expect(fisherExactTwoSided(5, 5, 5, 5)).toBeCloseTo(1, 6);
  });

  it("empty table returns 1", () => {
    expect(fisherExactTwoSided(0, 0, 0, 0)).toBe(1);
  });

  it("p-value is in [0,1]", () => {
    const p = fisherExactTwoSided(7, 13, 2, 18);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});

describe("newcombeDiffCI", () => {
  it("brackets the observed delta", () => {
    const ci = newcombeDiffCI(20, 100, 8, 100); // 0.20 vs 0.08, delta 0.12
    expect(ci.lower).toBeLessThan(0.12);
    expect(ci.upper).toBeGreaterThan(0.12);
  });

  it("a large clear uplift has a CI that excludes 0", () => {
    const ci = newcombeDiffCI(60, 200, 20, 200);
    expect(ci.lower).toBeGreaterThan(0);
  });

  it("no difference → CI straddles 0", () => {
    const ci = newcombeDiffCI(10, 100, 10, 100);
    expect(ci.lower).toBeLessThan(0);
    expect(ci.upper).toBeGreaterThan(0);
  });

  it("degenerate n returns {0,0}", () => {
    expect(newcombeDiffCI(0, 0, 5, 50)).toEqual({ lower: 0, upper: 0 });
  });
});

describe("compareProportions (MUST #4 end-to-end)", () => {
  it("flags a large uplift at big n as significant", () => {
    const r = compareProportions(60, 200, 20, 200);
    expect(r.delta).toBeCloseTo(0.2, 6);
    expect(r.significant).toBe(true);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.deltaCi95.lower).toBeGreaterThan(0);
    expect(r.lowPower).toBe(false);
  });

  it("does NOT flag a small noisy uplift as significant", () => {
    // 3/20 vs 2/20 — visually 'up' but pure noise.
    const r = compareProportions(3, 20, 2, 20);
    expect(r.significant).toBe(false);
    expect(r.lowPower).toBe(true); // both arms n<100
    expect(r.deltaCi95.lower).toBeLessThan(0); // CI straddles 0
  });

  it("reports baseline/operating values and method", () => {
    const r = compareProportions(14, 100, 8, 100);
    expect(r.baselineValue).toBeCloseTo(0.08, 6);
    expect(r.operatingValue).toBeCloseTo(0.14, 6);
    expect(r.method).toBe("fisher_exact_two_sided");
  });
});
