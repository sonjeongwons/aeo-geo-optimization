/** test/engineOverlap.test.ts — cross-engine cited-domain overlap metric (X25). */
import { describe, it, expect } from "vitest";
import { computeEngineOverlap } from "../src/metrics/engineOverlap.js";
import type { ResponseSourceSignal } from "../src/metrics/earnedSources.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sig(modelId: string, citedDomains: string[]): ResponseSourceSignal {
  return { modelId, citedDomains, fetchedDomains: [], brandMentioned: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeEngineOverlap", () => {
  // ── identical sets ────────────────────────────────────────────────────────
  it("two engines citing identical domain sets → jaccard 1, pooledSafe true", () => {
    const signals: ResponseSourceSignal[] = [
      sig("gpt4", ["alpha.com", "beta.com", "gamma.com"]),
      sig("gemini", ["alpha.com", "beta.com", "gamma.com"]),
    ];
    const report = computeEngineOverlap(signals);
    expect(report.pairs).toHaveLength(1);
    const pair = report.pairs[0]!;
    expect(pair.jaccard).toBeCloseTo(1, 10);
    expect(pair.pooledSafe).toBe(true);
    expect(pair.intersectionSize).toBe(3);
    expect(pair.unionSize).toBe(3);
  });

  // ── disjoint sets ─────────────────────────────────────────────────────────
  it("two engines with disjoint domain sets → jaccard 0, pooledSafe false", () => {
    const signals: ResponseSourceSignal[] = [
      sig("gpt4", ["alpha.com", "beta.com", "gamma.com"]),
      sig("gemini", ["x.com", "y.com", "z.com"]),
    ];
    const report = computeEngineOverlap(signals, { threshold: 0.2 });
    const pair = report.pairs[0]!;
    expect(pair.jaccard).toBe(0);
    expect(pair.pooledSafe).toBe(false);
    expect(pair.intersectionSize).toBe(0);
    expect(pair.unionSize).toBe(6);
  });

  // ── partial overlap ───────────────────────────────────────────────────────
  it("partial overlap: A={a,b,c}, B={b,c,d} → jaccard 2/4 = 0.5", () => {
    const signals: ResponseSourceSignal[] = [
      sig("engine1", ["a.com", "b.com", "c.com"]),
      sig("engine2", ["b.com", "c.com", "d.com"]),
    ];
    const report = computeEngineOverlap(signals);
    const pair = report.pairs[0]!;
    expect(pair.jaccard).toBeCloseTo(2 / 4, 10);
    expect(pair.intersectionSize).toBe(2);
    expect(pair.unionSize).toBe(4);
  });

  // ── lowData flag ──────────────────────────────────────────────────────────
  it("engine below minDomains → lowData true on its pairs", () => {
    // engine1 has 3 domains (>= default minDomains=3), engine2 has 2 (< 3)
    const signals: ResponseSourceSignal[] = [
      sig("engine1", ["a.com", "b.com", "c.com"]),
      sig("engine2", ["a.com", "b.com"]),
    ];
    const report = computeEngineOverlap(signals, { minDomains: 3 });
    const pair = report.pairs[0]!;
    expect(pair.lowData).toBe(true);
    expect(pair.nDomainsB).toBe(2);
  });

  it("both engines meet minDomains → lowData false", () => {
    const signals: ResponseSourceSignal[] = [
      sig("engine1", ["a.com", "b.com", "c.com"]),
      sig("engine2", ["a.com", "b.com", "c.com"]),
    ];
    const report = computeEngineOverlap(signals, { minDomains: 3 });
    const pair = report.pairs[0]!;
    expect(pair.lowData).toBe(false);
  });

  // ── single engine ─────────────────────────────────────────────────────────
  it("single engine → engines length 1, pairs empty, meanJaccard null", () => {
    const signals: ResponseSourceSignal[] = [
      sig("solo", ["a.com", "b.com"]),
      sig("solo", ["c.com"]),
    ];
    const report = computeEngineOverlap(signals);
    expect(report.engines).toHaveLength(1);
    expect(report.engines[0]).toBe("solo");
    expect(report.pairs).toHaveLength(0);
    expect(report.meanJaccard).toBeNull();
  });

  // ── cosine: identical count vectors → 1 ──────────────────────────────────
  it("cosine: identical count vectors (same domain counts) → cosine ≈ 1", () => {
    // Each engine cites exactly the same two domains with the same frequencies.
    // engine1: a.com cited 2x (two responses), b.com cited 1x
    // engine2: a.com cited 2x, b.com cited 1x
    const signals: ResponseSourceSignal[] = [
      sig("engine1", ["a.com", "b.com"]),
      sig("engine1", ["a.com"]),
      sig("engine2", ["a.com", "b.com"]),
      sig("engine2", ["a.com"]),
    ];
    const report = computeEngineOverlap(signals);
    const pair = report.pairs[0]!;
    expect(pair.cosine).toBeCloseTo(1, 10);
  });

  // ── cosine: orthogonal vectors → 0 ───────────────────────────────────────
  it("cosine: orthogonal count vectors (disjoint domains) → cosine 0", () => {
    const signals: ResponseSourceSignal[] = [
      sig("engine1", ["a.com", "b.com", "c.com"]),
      sig("engine2", ["x.com", "y.com", "z.com"]),
    ];
    const report = computeEngineOverlap(signals);
    const pair = report.pairs[0]!;
    expect(pair.cosine).toBe(0);
  });

  // ── domain lowercasing and dedup ──────────────────────────────────────────
  it("lowercases and dedups cited domains within an engine", () => {
    const signals: ResponseSourceSignal[] = [
      // 'Reddit.com' and 'reddit.com' are the same after lowercasing
      sig("engine1", ["Reddit.com", "reddit.com", "A.com"]),
      sig("engine2", ["reddit.com", "a.com"]),
    ];
    const report = computeEngineOverlap(signals);
    const pair = report.pairs[0]!;
    // Both engines have {reddit.com, a.com} → jaccard = 1
    expect(pair.jaccard).toBeCloseTo(1, 10);
    expect(pair.nDomainsA).toBe(2);
    expect(pair.nDomainsB).toBe(2);
  });

  // ── engine pair ordering: engineA < engineB lexicographically ─────────────
  it("pair ordering: engineA < engineB lexicographically", () => {
    const signals: ResponseSourceSignal[] = [
      sig("zebra", ["a.com", "b.com", "c.com"]),
      sig("alpha", ["a.com", "b.com", "c.com"]),
    ];
    const report = computeEngineOverlap(signals);
    const pair = report.pairs[0]!;
    expect(pair.engineA).toBe("alpha");
    expect(pair.engineB).toBe("zebra");
    expect(pair.engineA < pair.engineB).toBe(true);
  });

  // ── engines list is sorted ────────────────────────────────────────────────
  it("engines list is sorted lexicographically", () => {
    const signals: ResponseSourceSignal[] = [
      sig("z-engine", ["a.com"]),
      sig("a-engine", ["b.com"]),
      sig("m-engine", ["c.com"]),
    ];
    const report = computeEngineOverlap(signals);
    expect(report.engines).toEqual(["a-engine", "m-engine", "z-engine"]);
  });

  // ── meanJaccard ───────────────────────────────────────────────────────────
  it("meanJaccard is the average of all pair jaccards", () => {
    // Three engines: A,B identical (jaccard=1), A,C disjoint (jaccard=0),
    // B,C disjoint (jaccard=0). Mean = (1+0+0)/3 ≈ 0.333
    const signals: ResponseSourceSignal[] = [
      sig("A", ["a.com", "b.com", "c.com"]),
      sig("B", ["a.com", "b.com", "c.com"]),
      sig("C", ["x.com", "y.com", "z.com"]),
    ];
    const report = computeEngineOverlap(signals);
    expect(report.pairs).toHaveLength(3);
    expect(report.meanJaccard).toBeCloseTo(1 / 3, 10);
  });

  // ── threshold wiring ──────────────────────────────────────────────────────
  it("threshold is reflected in the report and used for pooledSafe", () => {
    const signals: ResponseSourceSignal[] = [
      sig("engine1", ["a.com", "b.com", "c.com"]),
      sig("engine2", ["b.com", "c.com", "d.com"]),
    ];
    // jaccard = 0.5; with threshold=0.6 → NOT safe; with threshold=0.4 → safe
    const reportHigh = computeEngineOverlap(signals, { threshold: 0.6 });
    const reportLow = computeEngineOverlap(signals, { threshold: 0.4 });
    expect(reportHigh.threshold).toBe(0.6);
    expect(reportHigh.pairs[0]!.pooledSafe).toBe(false);
    expect(reportLow.threshold).toBe(0.4);
    expect(reportLow.pairs[0]!.pooledSafe).toBe(true);
  });

  // ── engine with zero cited domains still appears in engines list ──────────
  it("engine with zero cited domains appears in engines list; pair is lowData with jaccard 0", () => {
    const signals: ResponseSourceSignal[] = [
      sig("empty-engine", []),
      sig("rich-engine", ["a.com", "b.com", "c.com"]),
    ];
    const report = computeEngineOverlap(signals, { minDomains: 1 });
    expect(report.engines).toContain("empty-engine");
    const pair = report.pairs[0]!;
    expect(pair.jaccard).toBe(0);
    expect(pair.lowData).toBe(true);
  });

  // ── determinism ───────────────────────────────────────────────────────────
  it("determinism: same input → identical output across two calls", () => {
    const signals: ResponseSourceSignal[] = [
      sig("engine1", ["a.com", "b.com", "c.com"]),
      sig("engine2", ["b.com", "c.com", "d.com"]),
      sig("engine3", ["x.com", "y.com", "z.com"]),
      sig("engine1", ["a.com", "e.com"]),
      sig("engine2", ["b.com", "f.com"]),
    ];
    const result1 = computeEngineOverlap(signals, { threshold: 0.3, minDomains: 2 });
    const result2 = computeEngineOverlap(signals, { threshold: 0.3, minDomains: 2 });
    expect(result1).toEqual(result2);
  });
});
