/**
 * test/citationPosition.test.ts — X16 first-citation-rank extractor (the safe half).
 */
import { describe, it, expect } from "vitest";
import {
  firstCitationRank,
  aggregateCitationRanks,
  type CitationPosition,
} from "../src/metrics/citationPosition.js";

describe("firstCitationRank", () => {
  it("returns 1-indexed rank among distinct cited domains", () => {
    const r = firstCitationRank(["reddit.com", "g2.com", "emora.ai"], "emora.ai");
    expect(r.rank).toBe(3);
    expect(r.nCited).toBe(3);
  });
  it("rank null when target not cited", () => {
    const r = firstCitationRank(["reddit.com", "g2.com"], "emora.ai");
    expect(r.rank).toBeNull();
    expect(r.nCited).toBe(2);
  });
  it("dedups by first occurrence (rank + nCited use distinct domains)", () => {
    const r = firstCitationRank(["reddit.com", "reddit.com", "emora.ai", "reddit.com"], "emora.ai");
    expect(r.rank).toBe(2);
    expect(r.nCited).toBe(2);
  });
  it("case-insensitive + trims", () => {
    const r = firstCitationRank([" Reddit.com ", "EMORA.ai"], "emora.ai");
    expect(r.rank).toBe(2);
  });
  it("empty citation list → rank null, nCited 0", () => {
    const r = firstCitationRank([], "emora.ai");
    expect(r.rank).toBeNull();
    expect(r.nCited).toBe(0);
  });
  it("ignores blank entries", () => {
    const r = firstCitationRank(["", "  ", "emora.ai"], "emora.ai");
    expect(r.rank).toBe(1);
    expect(r.nCited).toBe(1);
  });
});

describe("aggregateCitationRanks", () => {
  const positions: CitationPosition[] = [
    { targetDomain: "emora.ai", rank: 1, nCited: 3 },
    { targetDomain: "emora.ai", rank: 3, nCited: 5 },
    { targetDomain: "emora.ai", rank: null, nCited: 4 }, // not cited
    { targetDomain: "emora.ai", rank: 2, nCited: 2 },
  ];
  it("citedShare reported separately; ranks NOT imputed for uncited", () => {
    const a = aggregateCitationRanks(positions);
    expect(a.nAnswers).toBe(4);
    expect(a.citedAnswers).toBe(3);
    expect(a.citedShare).toBeCloseTo(0.75, 9);
  });
  it("median/p75 computed over cited answers only", () => {
    const a = aggregateCitationRanks(positions);
    // cited ranks sorted: [1,2,3] → median (ceil(0.5*3)=2 → idx1) = 2; p75 (ceil(0.75*3)=3 → idx2) = 3
    expect(a.medianRank).toBe(2);
    expect(a.p75Rank).toBe(3);
  });
  it("meanNCited over all answers", () => {
    const a = aggregateCitationRanks(positions);
    expect(a.meanNCited).toBeCloseTo((3 + 5 + 4 + 2) / 4, 9);
  });
  it("empty → zeros and nulls (no fabrication)", () => {
    const a = aggregateCitationRanks([]);
    expect(a.nAnswers).toBe(0);
    expect(a.citedShare).toBe(0);
    expect(a.medianRank).toBeNull();
    expect(a.p75Rank).toBeNull();
    expect(a.meanNCited).toBeNull();
  });
});
