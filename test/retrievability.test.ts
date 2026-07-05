/**
 * test/retrievability.test.ts — pure retrievability leading-indicator scorer.
 */
import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  retrievabilityScore,
  assetRetrievability,
  scoreAssetWithAdapter,
  type EmbeddingAdapter,
} from "../src/metrics/retrievability.js";
import { mapEmbedResponse, GeminiEmbeddingAdapter } from "../src/providers/geminiEmbed.js";

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

describe("mapEmbedResponse (Gemini embedContent → vectors)", () => {
  it("maps embeddings[].values to plain vectors", () => {
    expect(mapEmbedResponse({ embeddings: [{ values: [1, 2, 3] }, { values: [4, 5] }] })).toEqual([[1, 2, 3], [4, 5]]);
  });
  it("is defensive (missing/short fields → empty)", () => {
    expect(mapEmbedResponse({})).toEqual([]);
    expect(mapEmbedResponse({ embeddings: [{}, { values: null }] })).toEqual([[], []]);
    expect(mapEmbedResponse(null)).toEqual([]);
  });
});

describe("GeminiEmbeddingAdapter (gated off without key)", () => {
  it("is not_configured + embeds to [] without an API key (no network)", async () => {
    const a = new GeminiEmbeddingAdapter(undefined);
    expect(a.status()).toBe("not_configured");
    expect(await a.embed(["hello", "world"])).toEqual([]);
  });
});

describe("scoreAssetWithAdapter", () => {
  // Stub adapter: deterministic 3-dim vectors keyed by first char so we control cosines.
  const stub: EmbeddingAdapter = {
    async embed(texts) {
      return texts.map((t) => (t.startsWith("mem") ? [1, 0, 0] : t.startsWith("chat") ? [0, 1, 0] : [0, 0, 1]));
    },
  };

  it("scores passages against queries via the adapter", async () => {
    const r = await scoreAssetWithAdapter(stub, ["memory system", "chat rooms"], ["memory question", "unrelated topic"]);
    expect(r.skipped).toBeUndefined();
    expect(r.perQuery).toHaveLength(2);
    expect(r.perQuery[0]!.band).toBe("strong"); // memory query hits the memory passage
    expect(r.coverage).toBeGreaterThan(0);
  });

  it("skips (no-op) when adapter returns no embeddings (off/quota)", async () => {
    const off: EmbeddingAdapter = { async embed() { return []; } };
    const r = await scoreAssetWithAdapter(off, ["p"], ["q"]);
    expect(r.skipped).toContain("no embeddings");
    expect(r.coverage).toBe(0);
  });

  it("skips when there are no passages or queries", async () => {
    expect((await scoreAssetWithAdapter(stub, [], ["q"])).skipped).toBe("no passages or queries");
  });
});
