/**
 * test/retrievability.test.ts — pure retrievability leading-indicator scorer.
 */
import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  retrievabilityScore,
  assetRetrievability,
} from "../src/metrics/retrievability.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal, -1 for opposite", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
  it("fails safe (0) for zero vector or length mismatch", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("retrievabilityScore", () => {
  it("picks the best passage as maxCosine and bands it", () => {
    const q = [1, 0, 0];
    const passages = [
      [0, 1, 0], // orthogonal → weak
      [0.9, 0.1, 0], // close → strong
      [0.5, 0.5, 0], // moderate-ish
    ];
    const r = retrievabilityScore(q, passages);
    expect(r.nPassages).toBe(3);
    expect(r.maxCosine).toBeGreaterThan(0.95);
    expect(r.band).toBe("strong");
    expect(r.meanTopK).toBeGreaterThan(0);
  });

  it("bands a poorly-matched passage set as weak", () => {
    const r = retrievabilityScore([1, 0, 0], [[0, 1, 0], [0, 0, 1]]);
    expect(r.band).toBe("weak");
    expect(r.maxCosine).toBeCloseTo(0);
  });

  it("returns a zeroed weak score for no passages", () => {
    expect(retrievabilityScore([1, 0], [])).toEqual({ maxCosine: 0, meanTopK: 0, band: "weak", nPassages: 0 });
  });
});

describe("assetRetrievability", () => {
  it("reports coverage (fraction of target queries at least moderate) + meanMax", () => {
    const passages = [[1, 0, 0], [0, 1, 0]];
    const queries = [
      [1, 0, 0], // strong (matches passage 1)
      [0, 1, 0], // strong (matches passage 2)
      [0, 0, 1], // weak (matches neither)
    ];
    const a = assetRetrievability(queries, passages);
    expect(a.perQuery).toHaveLength(3);
    expect(a.coverage).toBeCloseTo(2 / 3);
    expect(a.meanMax).toBeGreaterThan(0);
  });

  it("is empty-safe", () => {
    expect(assetRetrievability([], [[1, 0]])).toEqual({ perQuery: [], coverage: 0, meanMax: 0 });
  });
});
