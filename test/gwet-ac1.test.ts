/** test/gwet-ac1.test.ts — SOTA v2 R2 prevalence-robust agreement + bootstrap CI. */
import { describe, it, expect } from "vitest";
import { gwetAC1, cohenKappa, bootstrapAgreementCI } from "../src/judge/reliability.js";

describe("gwetAC1", () => {
  it("perfect agreement → 1", () => {
    expect(gwetAC1([true, false, true, false], [true, false, true, false]).value).toBeCloseTo(1, 6);
  });

  it("n=0 → null", () => {
    expect(gwetAC1([], []).value).toBeNull();
  });

  it("is HIGH under heavy prevalence skew where Cohen's kappa collapses", () => {
    // 100 items, both raters say 'false' on 98, agree on a true and disagree on one.
    const a = Array(100).fill(false);
    const b = Array(100).fill(false);
    a[0] = true; b[0] = true; // agree positive
    a[1] = true; b[1] = false; // one disagreement
    const k = cohenKappa(a, b).kappa!;
    const ac1 = gwetAC1(a, b).value!;
    expect(ac1).toBeGreaterThan(0.9); // AC1 reflects the 99% observed agreement
    expect(ac1).toBeGreaterThan(k); // and is much higher than the prevalence-collapsed kappa
  });

  it("chance-level agreement is near 0", () => {
    // Alternating vs all-true → po=0.5; AC1 stays modest, not 1.
    const a = Array(10).fill(true);
    const b = a.map((_, i) => i % 2 === 0);
    const ac1 = gwetAC1(a, b).value!;
    expect(ac1).toBeLessThan(0.6);
  });
});

describe("bootstrapAgreementCI", () => {
  const a = [true, false, true, false, true, true, false, false, true, false];
  const b = [true, false, true, true, true, false, false, false, true, false];

  it("returns a [lower,upper] interval bracketing the point AC1", () => {
    const point = gwetAC1(a, b).value!;
    const ci = bootstrapAgreementCI(a, b, gwetAC1, { B: 500, seed: 42 })!;
    expect(ci.lower).toBeLessThanOrEqual(point + 1e-9);
    expect(ci.upper).toBeGreaterThanOrEqual(point - 1e-9);
    expect(ci.lower).toBeLessThanOrEqual(ci.upper);
  });

  it("is deterministic for a fixed seed", () => {
    const c1 = bootstrapAgreementCI(a, b, gwetAC1, { B: 300, seed: 7 });
    const c2 = bootstrapAgreementCI(a, b, gwetAC1, { B: 300, seed: 7 });
    expect(c1).toEqual(c2);
  });

  it("works with cohenKappa too (reads .kappa)", () => {
    const ci = bootstrapAgreementCI(a, b, cohenKappa, { B: 200, seed: 1 });
    expect(ci).not.toBeNull();
  });

  it("n=0 → null", () => {
    expect(bootstrapAgreementCI([], [], gwetAC1)).toBeNull();
  });
});
