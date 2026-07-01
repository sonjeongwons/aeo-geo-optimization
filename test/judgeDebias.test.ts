/** test/judgeDebias.test.ts — Rogan-Gladen debiased visibility (X11). */
import { describe, it, expect } from "vitest";
import { roganGladen, debiasedVisibility } from "../src/judge/judgeDebias.js";

// ---------------------------------------------------------------------------
// roganGladen — point estimator
// ---------------------------------------------------------------------------

describe("roganGladen", () => {
  it("perfect detector Se=Sp=1 → correctedRate equals pObs", () => {
    expect(roganGladen(0.3, 1, 1)).toBeCloseTo(0.3, 9);
    expect(roganGladen(0.7, 1, 1)).toBeCloseTo(0.7, 9);
    expect(roganGladen(0, 1, 1)).toBeCloseTo(0, 9);
    expect(roganGladen(1, 1, 1)).toBeCloseTo(1, 9);
  });

  it("known reference: pObs=0.5, se=0.9, sp=0.8 → ≈0.4286", () => {
    // (0.5 + 0.8 - 1) / (0.9 + 0.8 - 1) = 0.3 / 0.7
    const expected = 0.3 / 0.7;
    expect(roganGladen(0.5, 0.9, 0.8)).toBeCloseTo(expected, 9);
  });

  it("not identifiable: se=sp=0.5 (Se+Sp=1) → null", () => {
    expect(roganGladen(0.5, 0.5, 0.5)).toBeNull();
  });

  it("not identifiable: se+sp < 1 → null", () => {
    expect(roganGladen(0.5, 0.4, 0.4)).toBeNull();
  });

  it("clamps negative raw result to 0", () => {
    // pObs=0.05, se=0.99, sp=0.99 → (0.05+0.99-1)/(0.99+0.99-1)=0.04/0.98≈0.0408 — positive
    // pObs=0.0, se=0.7, sp=0.8 → (0+0.8-1)/(0.7+0.8-1) = -0.2/0.5 = -0.4 → clamp to 0
    expect(roganGladen(0, 0.7, 0.8)).toBe(0);
  });

  it("clamps result above 1 to 1", () => {
    // pObs=1, se=0.6, sp=0.8 → (1+0.8-1)/(0.6+0.8-1) = 0.8/0.4 = 2 → clamp to 1
    expect(roganGladen(1, 0.6, 0.8)).toBe(1);
  });

  it("returns null when pObs out of [0,1]", () => {
    expect(roganGladen(-0.1, 0.9, 0.9)).toBeNull();
    expect(roganGladen(1.1, 0.9, 0.9)).toBeNull();
  });

  it("returns null when se <= 0 or se > 1", () => {
    expect(roganGladen(0.5, 0, 0.8)).toBeNull();
    expect(roganGladen(0.5, -0.1, 0.8)).toBeNull();
    expect(roganGladen(0.5, 1.1, 0.8)).toBeNull();
  });

  it("returns null when sp <= 0 or sp > 1", () => {
    expect(roganGladen(0.5, 0.9, 0)).toBeNull();
    expect(roganGladen(0.5, 0.9, -0.1)).toBeNull();
    expect(roganGladen(0.5, 0.9, 1.1)).toBeNull();
  });

  it("is deterministic — same inputs always return same value", () => {
    const r1 = roganGladen(0.4, 0.85, 0.90);
    const r2 = roganGladen(0.4, 0.85, 0.90);
    expect(r1).toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// debiasedVisibility — full estimate with delta-method CI
// ---------------------------------------------------------------------------

describe("debiasedVisibility", () => {
  it("perfect detector Se=Sp=1 → correctedRate equals observedRate", () => {
    const r = debiasedVisibility(0.4, 100, 1, 1, { seN: 50, spN: 50 });
    expect(r.correctedRate).toBeCloseTo(0.4, 9);
    expect(r.identifiable).toBe(true);
    expect(r.observedRate).toBe(0.4);
  });

  it("known reference point: pObs=0.5, se=0.9, sp=0.8 → ≈0.4286", () => {
    const r = debiasedVisibility(0.5, 200, 0.9, 0.8, { seN: 100, spN: 100 });
    expect(r.correctedRate).toBeCloseTo(0.3 / 0.7, 9);
    expect(r.identifiable).toBe(true);
  });

  it("not identifiable: se=sp=0.5 → correctedRate/ciLow/ciHigh null, identifiable false", () => {
    const r = debiasedVisibility(0.5, 100, 0.5, 0.5);
    expect(r.identifiable).toBe(false);
    expect(r.correctedRate).toBeNull();
    expect(r.ciLow).toBeNull();
    expect(r.ciHigh).toBeNull();
    expect(r.calibrated).toBe(false);
    expect(r.note).toMatch(/non-informative/i);
  });

  it("CI widens as nObs shrinks (Se/Sp fixed, no calibration variance)", () => {
    const large = debiasedVisibility(0.5, 1000, 0.9, 0.8);
    const small = debiasedVisibility(0.5, 30, 0.9, 0.8);
    const largeWidth = large.ciHigh! - large.ciLow!;
    const smallWidth = small.ciHigh! - small.ciLow!;
    expect(smallWidth).toBeGreaterThan(largeWidth);
  });

  it("CI widens as seN/spN shrink (adds Se/Sp variance terms)", () => {
    const highCal = debiasedVisibility(0.5, 200, 0.9, 0.8, {
      seN: 500,
      spN: 500,
    });
    const lowCal = debiasedVisibility(0.5, 200, 0.9, 0.8, {
      seN: 20,
      spN: 20,
    });
    const highWidth = highCal.ciHigh! - highCal.ciLow!;
    const lowWidth = lowCal.ciHigh! - lowCal.ciLow!;
    expect(lowWidth).toBeGreaterThan(highWidth);
  });

  it("calibrated=true only when nObs>=minN AND seN>=minCal AND spN>=minCal", () => {
    const calibrated = debiasedVisibility(0.5, 30, 0.9, 0.8, {
      seN: 20,
      spN: 20,
    });
    expect(calibrated.calibrated).toBe(true);
  });

  it("calibrated=false when nObs < minN (default 30)", () => {
    const r = debiasedVisibility(0.5, 29, 0.9, 0.8, { seN: 30, spN: 30 });
    expect(r.calibrated).toBe(false);
    expect(r.note).toMatch(/sample too small/i);
  });

  it("calibrated=false when seN < minCal (default 20)", () => {
    const r = debiasedVisibility(0.5, 100, 0.9, 0.8, { seN: 15, spN: 30 });
    expect(r.calibrated).toBe(false);
    expect(r.note).toMatch(/sensitivity calibration sample too small/i);
  });

  it("calibrated=false when spN < minCal (default 20)", () => {
    const r = debiasedVisibility(0.5, 100, 0.9, 0.8, { seN: 30, spN: 10 });
    expect(r.calibrated).toBe(false);
    expect(r.note).toMatch(/specificity calibration sample too small/i);
  });

  it("calibrated=false (but correctedRate still returned) when seN/spN not provided", () => {
    const r = debiasedVisibility(0.5, 100, 0.9, 0.8);
    expect(r.calibrated).toBe(false);
    // Still computes a point estimate — not nulled just because low-cal
    expect(r.correctedRate).not.toBeNull();
    expect(r.identifiable).toBe(true);
  });

  it("lowCalibration=true when seN provided but below minCal", () => {
    const r = debiasedVisibility(0.5, 100, 0.9, 0.8, { seN: 10, spN: 30 });
    expect(r.lowCalibration).toBe(true);
  });

  it("lowCalibration=true when spN provided but below minCal", () => {
    const r = debiasedVisibility(0.5, 100, 0.9, 0.8, { seN: 30, spN: 5 });
    expect(r.lowCalibration).toBe(true);
  });

  it("lowCalibration=false when both seN and spN meet minCal", () => {
    const r = debiasedVisibility(0.5, 100, 0.9, 0.8, { seN: 20, spN: 20 });
    expect(r.lowCalibration).toBe(false);
  });

  it("lowCalibration=false when seN/spN not provided at all", () => {
    // Not provided ≠ provided-but-small
    const r = debiasedVisibility(0.5, 100, 0.9, 0.8);
    expect(r.lowCalibration).toBe(false);
  });

  it("CI is clamped to [0,1] when half-width would exceed bounds", () => {
    // Very small nObs and calibration → huge CI → should clamp to [0,1]
    const r = debiasedVisibility(0.05, 5, 0.6, 0.6, { seN: 5, spN: 5 });
    if (r.correctedRate !== null) {
      expect(r.ciLow).toBeGreaterThanOrEqual(0);
      expect(r.ciHigh).toBeLessThanOrEqual(1);
    }
  });

  it("custom z widens CI (z=2.576 vs default 1.96)", () => {
    const base = debiasedVisibility(0.5, 100, 0.9, 0.8, {
      seN: 50,
      spN: 50,
    });
    const wide = debiasedVisibility(0.5, 100, 0.9, 0.8, {
      seN: 50,
      spN: 50,
      z: 2.576,
    });
    const baseWidth = base.ciHigh! - base.ciLow!;
    const wideWidth = wide.ciHigh! - wide.ciLow!;
    expect(wideWidth).toBeGreaterThan(baseWidth);
  });

  it("custom minN / minCal respected", () => {
    // Default minN=30, minCal=20; set tighter thresholds to force calibrated=false
    const r = debiasedVisibility(0.5, 50, 0.9, 0.8, {
      seN: 25,
      spN: 25,
      minN: 60,
      minCal: 30,
    });
    expect(r.calibrated).toBe(false);
  });

  it("is deterministic — same inputs always return same object values", () => {
    const opts = { seN: 40, spN: 40 };
    const r1 = debiasedVisibility(0.35, 80, 0.88, 0.92, opts);
    const r2 = debiasedVisibility(0.35, 80, 0.88, 0.92, opts);
    expect(r1.correctedRate).toBe(r2.correctedRate);
    expect(r1.ciLow).toBe(r2.ciLow);
    expect(r1.ciHigh).toBe(r2.ciHigh);
    expect(r1.calibrated).toBe(r2.calibrated);
  });
});
