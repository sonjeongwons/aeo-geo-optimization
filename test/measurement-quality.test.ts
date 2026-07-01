/** test/measurement-quality.test.ts — hi-end audit MUST #7 thresholds. */
import { describe, it, expect } from "vitest";
import { computeMeasurementQuality, wilsonInterval } from "../src/domain/metrics.types.js";

describe("computeMeasurementQuality (MUST #7 abstain thresholds)", () => {
  it("good when abstainRate <= 0.2", () => {
    expect(computeMeasurementQuality(0).status).toBe("good");
    expect(computeMeasurementQuality(0.2).status).toBe("good");
  });
  it("warn when 0.2 < abstainRate <= 0.4", () => {
    expect(computeMeasurementQuality(0.21).status).toBe("warn");
    expect(computeMeasurementQuality(0.4).status).toBe("warn");
  });
  it("critical when abstainRate > 0.4", () => {
    expect(computeMeasurementQuality(0.41).status).toBe("critical");
    expect(computeMeasurementQuality(0.9).status).toBe("critical");
  });
  it("carries the rate and a non-empty customer-facing note", () => {
    const q = computeMeasurementQuality(0.35);
    expect(q.abstainRate).toBe(0.35);
    expect(q.note).toContain("35%");
    expect(q.note.length).toBeGreaterThan(20);
  });
});

describe("wilsonInterval (MUST #3 95% CI)", () => {
  it("returns [0,0] for n=0", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 0 });
  });
  it("brackets the point estimate within [0,1]", () => {
    const ci = wilsonInterval(15, 100);
    expect(ci.lower).toBeGreaterThanOrEqual(0);
    expect(ci.upper).toBeLessThanOrEqual(1);
    expect(ci.lower).toBeLessThan(0.15);
    expect(ci.upper).toBeGreaterThan(0.15);
  });
  it("zero hits has lower=0 and a small positive upper", () => {
    const ci = wilsonInterval(0, 100);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0);
    expect(ci.upper).toBeLessThan(0.1);
  });
  it("tightens as n grows (more data → narrower interval)", () => {
    const small = wilsonInterval(15, 50);
    const large = wilsonInterval(150, 500);
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
  });
});
