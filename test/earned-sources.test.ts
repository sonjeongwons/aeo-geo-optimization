/** test/earned-sources.test.ts — earned-source corpus aggregation (v2-critic #1). */
import { describe, it, expect } from "vitest";
import { aggregateEarnedSources, type ResponseSourceSignal } from "../src/metrics/earnedSources.js";

const r = (cited: string[], fetched: string[], brandMentioned = false, modelId = "m1"): ResponseSourceSignal =>
  ({ citedDomains: cited, fetchedDomains: fetched, brandMentioned, modelId });

describe("aggregateEarnedSources", () => {
  it("empty input → empty corpus", () => {
    const c = aggregateEarnedSources([]);
    expect(c.nResponses).toBe(0);
    expect(c.domains).toEqual([]);
  });

  it("ranks domains by citation frequency (targeting list)", () => {
    const signals = [
      r(["reddit.com"], ["reddit.com", "example.com"]),
      r(["reddit.com", "g2.com"], ["reddit.com", "g2.com"]),
      r(["reddit.com"], ["reddit.com"]),
    ];
    const c = aggregateEarnedSources(signals);
    expect(c.nResponses).toBe(3);
    expect(c.domains[0]!.domain).toBe("reddit.com"); // cited 3
    expect(c.domains[0]!.citedResponses).toBe(3);
    expect(c.domains.find((d) => d.domain === "example.com")!.citedResponses).toBe(0); // fetched not cited
    expect(c.domains.find((d) => d.domain === "example.com")!.fetchedResponses).toBe(1);
  });

  it("computes citedWhenFetched and a Wilson CI per domain", () => {
    const signals = [
      r(["g2.com"], ["g2.com"]),
      r([], ["g2.com"]), // fetched, not cited
    ];
    const c = aggregateEarnedSources(signals);
    const g2 = c.domains.find((d) => d.domain === "g2.com")!;
    expect(g2.fetchedResponses).toBe(2);
    expect(g2.citedResponses).toBe(1);
    expect(g2.citedWhenFetchedRate).toBeCloseTo(0.5, 6);
    expect(g2.citationRate).toBeCloseTo(0.5, 6);
    expect(g2.ci95.lower).toBeGreaterThanOrEqual(0);
    expect(g2.ci95.upper).toBeLessThanOrEqual(1);
    expect(g2.lowPower).toBe(true); // n=2 < 100
  });

  it("tracks brand co-citation", () => {
    const signals = [
      r(["reddit.com"], ["reddit.com"], true), // brand mentioned + reddit cited
      r(["reddit.com"], ["reddit.com"], false),
    ];
    const c = aggregateEarnedSources(signals);
    const reddit = c.domains.find((d) => d.domain === "reddit.com")!;
    expect(reddit.citedResponses).toBe(2);
    expect(reddit.brandCoCitedResponses).toBe(1);
  });

  it("EXCLUDES owned/brand domains from the earned (third-party) list (§0)", () => {
    const signals = [r(["emora.ai", "reddit.com"], ["emora.ai", "reddit.com"])];
    const c = aggregateEarnedSources(signals, ["emora.ai"]);
    expect(c.domains.map((d) => d.domain)).not.toContain("emora.ai");
    expect(c.domains.map((d) => d.domain)).toContain("reddit.com");
  });
});
