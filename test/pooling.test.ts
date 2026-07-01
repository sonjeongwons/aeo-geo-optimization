/** test/pooling.test.ts — SOTA v2 R3 partial pooling (shrinkage). */
import { describe, it, expect } from "vitest";
import { partialPool, DEFAULT_POOL_STRENGTH } from "../src/metrics/pooling.js";
import { tallyPerPromptVisibility, type WorkUnitSlice, type TallyJudgment } from "../src/metrics/promptVisibility.js";

describe("partialPool", () => {
  it("pooled rate lies between the raw cell rate and the grand mean", () => {
    // cell 1/3 ≈ 0.33, grand 0.10 → pooled in (0.10, 0.33)
    const p = partialPool(1, 3, 0.1);
    expect(p.rawRate).toBeCloseTo(1 / 3, 6);
    expect(p.pooledRate).toBeGreaterThan(0.1);
    expect(p.pooledRate).toBeLessThan(1 / 3);
  });

  it("a large-n cell barely moves (little shrinkage)", () => {
    const small = partialPool(1, 3, 0.1);
    const large = partialPool(30, 90, 0.1); // raw 0.333 at n=90
    const smallShrink = 1 / 3 - small.pooledRate;
    const largeShrink = 1 / 3 - large.pooledRate;
    expect(largeShrink).toBeLessThan(smallShrink);
  });

  it("a 1/3 cell has a strictly wider pooled CI than a 30/90 cell", () => {
    const small = partialPool(1, 3, 0.2);
    const large = partialPool(30, 90, 0.2);
    const wSmall = small.pooledCi95.upper - small.pooledCi95.lower;
    const wLarge = large.pooledCi95.upper - large.pooledCi95.lower;
    expect(wSmall).toBeGreaterThan(wLarge);
  });

  it("with zero strength the pooled rate equals the raw rate", () => {
    const p = partialPool(2, 5, 0.9, 0);
    expect(p.pooledRate).toBeCloseTo(2 / 5, 6);
  });

  it("default strength is the documented constant", () => {
    expect(DEFAULT_POOL_STRENGTH).toBe(5);
  });
});

describe("tallyPerPromptVisibility pooled fields (R3 wiring)", () => {
  it("attaches pooledRate/pooledCi95 and keeps raw rate + lowPower intact", () => {
    const slices: WorkUnitSlice[] = [
      { model_id: "m1", language: "en", question_id: "q1", count: 3 },
      { model_id: "m1", language: "en", question_id: "q2", count: 90 },
    ];
    const j = (q: string, hits: number): TallyJudgment[] =>
      Array.from({ length: hits }, (_, i) => ({
        model_id: "m1", language: "en", question_id: q,
        brand_mentioned: true, guardrail_status: "pass", response_raw_id: `${q}-${i}`,
      }));
    // q1 = 3/3 (rate 1.0), q2 = 9/90 (rate 0.1) → grand ≈ 12/93 ≈ 0.13 (low)
    const out = tallyPerPromptVisibility(slices, [...j("q1", 3), ...j("q2", 9)]);
    const c1 = out.find((o) => o.questionId === "q1")!;
    const c2 = out.find((o) => o.questionId === "q2")!;
    // raw untouched
    expect(c1.mentionRate).toBeCloseTo(1, 6);
    expect(c1.lowPower).toBe(true); // raw n=3 < 30
    // pooled present + shrunk DOWN toward the low grand mean
    expect(c1.pooledRate).toBeDefined();
    expect(c1.pooledRate!).toBeLessThan(c1.mentionRate);
    expect(c1.pooledRate!).toBeGreaterThan(0.13); // but not all the way to the grand mean
    expect(c2.pooledRate).toBeDefined();
    // the small high cell moves far more than the large cell
    const move1 = Math.abs(c1.mentionRate - c1.pooledRate!);
    const move2 = Math.abs(c2.mentionRate - c2.pooledRate!);
    expect(move1).toBeGreaterThan(move2);
  });
});
