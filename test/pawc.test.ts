/** test/pawc.test.ts — early-position word share (GEO KDD PAWC). SOTA sweep adopt. */
import { describe, it, expect } from "vitest";
import { computePawc } from "../src/metrics/pawc.js";

const A = ["EMORA", "EMORA AI"];

describe("computePawc", () => {
  it("returns 0 for empty/null and for no-brand text", () => {
    expect(computePawc("", A)).toBe(0);
    expect(computePawc(null, A)).toBe(0);
    expect(computePawc("Replika and Character.AI are popular options.", A)).toBe(0);
  });

  it("is in [0,1]", () => {
    const v = computePawc("EMORA is an AI companion with memory.", A);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it("gives a higher score when the brand appears EARLIER", () => {
    const early = computePawc("EMORA is a great journaling companion app indeed.", A);
    const late = computePawc("A great journaling companion app indeed is EMORA.", A);
    expect(early).toBeGreaterThan(late);
  });

  it("gives a higher score when the brand appears MORE often", () => {
    const once = computePawc("EMORA helps people. It tracks many other things here.", A);
    const twice = computePawc("EMORA helps people. EMORA tracks many other things here.", A);
    expect(twice).toBeGreaterThan(once);
  });

  it("approaches 1 when the answer is essentially all brand at the front", () => {
    const v = computePawc("EMORA EMORA EMORA", A);
    expect(v).toBeGreaterThan(0.9);
  });

  it("multi-word alias is credited across its tokens", () => {
    const v = computePawc("EMORA AI is the product.", A);
    expect(v).toBeGreaterThan(0);
  });

  it("is alias/case tolerant", () => {
    expect(computePawc("emora is lowercase here.", A)).toBeGreaterThan(0);
  });
});
