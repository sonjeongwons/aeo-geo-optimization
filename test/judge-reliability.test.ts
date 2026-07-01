/** test/judge-reliability.test.ts — SOTA sweep E judge-reliability stats. */
import { describe, it, expect } from "vitest";
import {
  cohenKappa,
  signedBiasScore,
  positionSwapConsistency,
  classifyAgreement,
} from "../src/judge/reliability.js";

describe("cohenKappa", () => {
  it("perfect agreement with variance → κ=1", () => {
    const a = [true, false, true, false];
    const b = [true, false, true, false];
    expect(cohenKappa(a, b).kappa).toBeCloseTo(1, 6);
  });

  it("perfect disagreement → κ=-1", () => {
    const a = [true, false, true, false];
    const b = [false, true, false, true];
    expect(cohenKappa(a, b).kappa).toBeCloseTo(-1, 6);
  });

  it("chance-level agreement → κ≈0", () => {
    // A all true, B alternating: po=0.5, pe=0.5 → κ=0
    const a = [true, true, true, true];
    const b = [true, false, true, false];
    expect(cohenKappa(a, b).kappa).toBeCloseTo(0, 6);
  });

  it("n=0 → kappa null", () => {
    expect(cohenKappa([], []).kappa).toBeNull();
  });

  it("full agreement with NO variance (both all-true) → κ=1", () => {
    expect(cohenKappa([true, true], [true, true]).kappa).toBe(1);
  });

  it("matches a known reference (2x2)", () => {
    // A: 1 1 0 0 1 ; B: 1 0 0 0 1  → agree on 4/5
    const a = [true, true, false, false, true];
    const b = [true, false, false, false, true];
    const r = cohenKappa(a, b);
    expect(r.observedAgreement).toBeCloseTo(0.8, 6);
    expect(r.kappa!).toBeGreaterThan(0);
    expect(r.kappa!).toBeLessThan(1);
  });
});

describe("signedBiasScore", () => {
  it("0 when brand and competitor preferred equally", () => {
    expect(signedBiasScore(10, 10, 30)).toBeCloseTo(0, 6);
  });
  it("positive when brand favored (SMR-inflating bias)", () => {
    expect(signedBiasScore(20, 5, 30)!).toBeGreaterThan(0);
  });
  it("negative when competitor favored", () => {
    expect(signedBiasScore(5, 20, 30)!).toBeLessThan(0);
  });
  it("null when total=0", () => {
    expect(signedBiasScore(0, 0, 0)).toBeNull();
  });
});

describe("positionSwapConsistency", () => {
  it("all stable → rate 1", () => {
    const r = positionSwapConsistency([
      { original: 1, swapped: 1 },
      { original: 2, swapped: 2 },
      { original: null, swapped: null },
    ]);
    expect(r.consistencyRate).toBe(1);
  });
  it("order-flips reduce the rate", () => {
    const r = positionSwapConsistency([
      { original: 1, swapped: 2 },
      { original: 2, swapped: 2 },
    ]);
    expect(r.consistencyRate).toBe(0.5);
  });
  it("empty → null", () => {
    expect(positionSwapConsistency([]).consistencyRate).toBeNull();
  });
});

describe("classifyAgreement (measurement-quality gate)", () => {
  it("single-engine (kappa null) → not_measurable, honest note", () => {
    const c = classifyAgreement(null, 0);
    expect(c.status).toBe("not_measurable");
    expect(c.kappa).toBeNull();
    expect(c.note).toContain("second JUDGE_PROVIDER");
  });
  it("below floor → warn", () => {
    const c = classifyAgreement(0.3, 100);
    expect(c.status).toBe("warn");
    expect(c.note).toContain("0.30");
  });
  it("at/above floor → ok", () => {
    expect(classifyAgreement(0.5, 100).status).toBe("ok");
    expect(classifyAgreement(0.9, 100).status).toBe("ok");
  });
  it("too few overlapping judgments → not_measurable even with a κ", () => {
    const c = classifyAgreement(0.8, 5);
    expect(c.status).toBe("not_measurable");
    expect(c.note).toContain("overlapping");
  });
});
