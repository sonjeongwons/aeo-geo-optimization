/** test/grounding-gap.test.ts — SOTA v3 fan-out + fetched-vs-cited trace. */
import { describe, it, expect } from "vitest";
import { computeGroundingGap, registrableDomain, domainForChunk, type GroundingTrace } from "../src/judge/groundingGap.js";

describe("registrableDomain", () => {
  it("extracts eTLD+1 and strips www", () => {
    expect(registrableDomain("https://www.reddit.com/r/SEO/x")).toBe("reddit.com");
    expect(registrableDomain("http://blog.character.ai/memory")).toBe("character.ai");
  });
  it("handles multi-part TLDs", () => {
    expect(registrableDomain("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
  });
  it("returns null for junk", () => {
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain("not a url")).toBeNull();
  });
});

describe("domainForChunk (redirect-wrapper fix, v4)", () => {
  it("uses the title domain when the uri is a vertexaisearch redirect wrapper", () => {
    const uri = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEf123";
    expect(domainForChunk(uri, "reddit.com")).toBe("reddit.com");
    expect(domainForChunk(uri, "Best AI apps — g2.com")).toBe("g2.com");
  });
  it("returns null for a wrapper with no domain-like title (excluded, not google.com)", () => {
    const uri = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x";
    expect(domainForChunk(uri, "Some Article Title")).toBeNull();
    expect(domainForChunk(uri, undefined)).toBeNull();
  });
  it("uses the uri directly for a real (non-wrapper) source", () => {
    expect(domainForChunk("https://www.reddit.com/r/SEO", "Reddit")).toBe("reddit.com");
  });
});

describe("computeGroundingGap", () => {
  it("resolves real domains through redirect wrappers via title", () => {
    const trace: GroundingTrace = {
      webSearchQueries: ["q"],
      chunks: [
        { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/a", title: "reddit.com" },
        { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/b", title: "g2.com" },
      ],
      supports: [{ chunkIndices: [0] }],
    };
    const g = computeGroundingGap(trace);
    expect(g.fetchedDomains.sort()).toEqual(["g2.com", "reddit.com"]);
    expect(g.citedDomains).toEqual(["reddit.com"]);
    expect(g.gapDomains).toEqual(["g2.com"]);
  });

  it("returns empty diagnostics for an absent trace", () => {
    const g = computeGroundingGap(null);
    expect(g.fetchedCount).toBe(0);
    expect(g.pCitedGivenFetched).toBeNull();
  });

  it("computes fetched, cited, and the fetched-but-not-cited gap", () => {
    const trace: GroundingTrace = {
      webSearchQueries: ["best ai companion app", "emora alternatives"],
      chunks: [
        { uri: "https://reddit.com/r/x" },       // idx 0 — cited
        { uri: "https://character.ai/blog" },     // idx 1 — cited
        { uri: "https://example.com/listicle" },  // idx 2 — fetched, NOT cited
        { uri: "https://reddit.com/r/y" },        // idx 3 — same domain as 0, cited
      ],
      supports: [
        { chunkIndices: [0, 1] },
        { chunkIndices: [3] },
      ],
    };
    const g = computeGroundingGap(trace);
    expect(g.fanoutQueries).toContain("emora alternatives");
    expect(g.fetchedDomains.sort()).toEqual(["character.ai", "example.com", "reddit.com"]);
    expect(g.citedDomains.sort()).toEqual(["character.ai", "reddit.com"]);
    expect(g.gapDomains).toEqual(["example.com"]); // fetched but not cited
    expect(g.pCitedGivenFetched).toBeCloseTo(2 / 3, 6); // 2 of 3 fetched domains cited
  });

  it("pCitedGivenFetched is null when nothing fetched", () => {
    const g = computeGroundingGap({ webSearchQueries: ["q"], chunks: [], supports: [] });
    expect(g.pCitedGivenFetched).toBeNull();
  });
});
