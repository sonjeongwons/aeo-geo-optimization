/** test/botAccessibility.test.ts — robots.txt parser + bot accessibility (W1). */
import { describe, it, expect } from "vitest";
import {
  parseRobots,
  isAllowed,
  botAccessibility,
  aggregateAccessibility,
  ANSWER_ENGINE_BOTS,
} from "../src/metrics/botAccessibility.js";

// ---------------------------------------------------------------------------
// parseRobots + isAllowed
// ---------------------------------------------------------------------------

describe("parseRobots", () => {
  it("empty robots.txt → no groups", () => {
    const rules = parseRobots("");
    expect(rules.groups).toHaveLength(0);
  });

  it("parses a single group with allow and disallow", () => {
    const text = `User-agent: GPTBot\nDisallow: /private\nAllow: /public`;
    const rules = parseRobots(text);
    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0]!.agents).toEqual(["GPTBot"]);
    expect(rules.groups[0]!.disallow).toContain("/private");
    expect(rules.groups[0]!.allow).toContain("/public");
  });

  it("groups consecutive User-agent lines into one group", () => {
    const text = `User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /`;
    const rules = parseRobots(text);
    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0]!.agents).toEqual(["GPTBot", "CCBot"]);
    expect(rules.groups[0]!.disallow).toEqual(["/"]);
  });

  it("blank line separates groups", () => {
    const text = `User-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /api`;
    const rules = parseRobots(text);
    expect(rules.groups).toHaveLength(2);
  });

  it("ignores comments and blank lines", () => {
    const text = `# This is a comment\nUser-agent: *\n# another comment\nDisallow: /secret`;
    const rules = parseRobots(text);
    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0]!.disallow).toEqual(["/secret"]);
  });

  it("empty Disallow: value means 'allow all' (not added to disallow list)", () => {
    const text = `User-agent: *\nDisallow: `;
    const rules = parseRobots(text);
    expect(rules.groups[0]!.disallow).toHaveLength(0);
  });

  it("directive matching is case-insensitive", () => {
    const text = `USER-AGENT: GPTBot\nDISALLOW: /\nALLOW: /open`;
    const rules = parseRobots(text);
    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0]!.agents).toEqual(["GPTBot"]);
    expect(rules.groups[0]!.disallow).toEqual(["/"]);
    expect(rules.groups[0]!.allow).toEqual(["/open"]);
  });
});

// ---------------------------------------------------------------------------
// isAllowed
// ---------------------------------------------------------------------------

describe("isAllowed", () => {
  it("empty robots.txt → all bots allowed at any path", () => {
    const rules = parseRobots("");
    expect(isAllowed(rules, "GPTBot", "/")).toBe(true);
    expect(isAllowed(rules, "GPTBot", "/private")).toBe(true);
  });

  it("User-agent: * Disallow: / → everything disallowed", () => {
    const rules = parseRobots(`User-agent: *\nDisallow: /`);
    expect(isAllowed(rules, "GPTBot", "/")).toBe(false);
    expect(isAllowed(rules, "PerplexityBot", "/anything")).toBe(false);
  });

  it("specific UA group beats wildcard '*' group", () => {
    const text = `User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /`;
    const rules = parseRobots(text);
    // GPTBot has its own Allow: / → allowed
    expect(isAllowed(rules, "GPTBot", "/")).toBe(true);
    // PerplexityBot falls through to * → disallowed
    expect(isAllowed(rules, "PerplexityBot", "/")).toBe(false);
  });

  it("Allow overrides Disallow when the Allow path is longer (more specific)", () => {
    const text = `User-agent: *\nDisallow: /private\nAllow: /private/open`;
    const rules = parseRobots(text);
    expect(isAllowed(rules, "GPTBot", "/private")).toBe(false);
    expect(isAllowed(rules, "GPTBot", "/private/open")).toBe(true);
  });

  it("Allow wins a tie on equal-length match", () => {
    // Both /abc match with equal length → Allow wins
    const text = `User-agent: *\nDisallow: /abc\nAllow: /abc`;
    const rules = parseRobots(text);
    expect(isAllowed(rules, "GPTBot", "/abc")).toBe(true);
  });

  it("'$' end-anchor in path pattern", () => {
    const text = `User-agent: *\nDisallow: /page$`;
    const rules = parseRobots(text);
    // Exact path /page → disallowed
    expect(isAllowed(rules, "GPTBot", "/page")).toBe(false);
    // /page/sub → allowed (doesn't end at /page)
    expect(isAllowed(rules, "GPTBot", "/page/sub")).toBe(true);
  });

  it("'*' wildcard in path pattern", () => {
    const text = `User-agent: *\nDisallow: /search*`;
    const rules = parseRobots(text);
    expect(isAllowed(rules, "GPTBot", "/search")).toBe(false);
    expect(isAllowed(rules, "GPTBot", "/search?q=test")).toBe(false);
    expect(isAllowed(rules, "GPTBot", "/results")).toBe(true);
  });

  it("no group matching UA at all → allowed (true)", () => {
    const rules = parseRobots(`User-agent: GPTBot\nDisallow: /`);
    // PerplexityBot has no matching group → allowed
    expect(isAllowed(rules, "PerplexityBot", "/")).toBe(true);
  });

  it("empty disallow list in the matched group → allowed", () => {
    const rules = parseRobots(`User-agent: *\nDisallow: `);
    expect(isAllowed(rules, "GPTBot", "/anything")).toBe(true);
  });

  it("default path is '/'", () => {
    const rules = parseRobots(`User-agent: *\nDisallow: /`);
    expect(isAllowed(rules, "GPTBot")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// botAccessibility
// ---------------------------------------------------------------------------

describe("botAccessibility", () => {
  it("null text → all bots 'unknown' (§7 honesty)", () => {
    const result = botAccessibility(null);
    expect(result).toHaveLength(ANSWER_ENGINE_BOTS.length);
    for (const { status } of result) {
      expect(status).toBe("unknown");
    }
  });

  it("null text → still unknown with custom bot list", () => {
    const result = botAccessibility(null, ["GPTBot", "ClaudeBot"]);
    expect(result).toEqual([
      { bot: "GPTBot", status: "unknown" },
      { bot: "ClaudeBot", status: "unknown" },
    ]);
  });

  it("empty robots.txt → all bots 'allowed'", () => {
    const result = botAccessibility("");
    for (const { status } of result) {
      expect(status).toBe("allowed");
    }
  });

  it("GPTBot disallowed by specific rule; PerplexityBot allowed (no matching group → allowed)", () => {
    const text = `User-agent: GPTBot\nDisallow: /`;
    const result = botAccessibility(text, ["GPTBot", "PerplexityBot"]);
    expect(result.find((r) => r.bot === "GPTBot")!.status).toBe("disallowed");
    expect(result.find((r) => r.bot === "PerplexityBot")!.status).toBe("allowed");
  });

  it("User-agent: * Disallow: / → all tracked bots disallowed", () => {
    const text = `User-agent: *\nDisallow: /`;
    const result = botAccessibility(text);
    for (const { status } of result) {
      expect(status).toBe("disallowed");
    }
  });

  it("returns results in the same order as the bots list", () => {
    const bots = ["ClaudeBot", "GPTBot", "CCBot"] as const;
    const result = botAccessibility("", bots);
    expect(result.map((r) => r.bot)).toEqual(["ClaudeBot", "GPTBot", "CCBot"]);
  });

  it("is deterministic: same input produces identical output on repeated calls", () => {
    const text = `User-agent: *\nDisallow: /private\nAllow: /public`;
    const r1 = botAccessibility(text);
    const r2 = botAccessibility(text);
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// aggregateAccessibility
// ---------------------------------------------------------------------------

describe("aggregateAccessibility", () => {
  it("empty corpus → nDomains 0, all counts 0, allowedShare 0", () => {
    const corpus = aggregateAccessibility([]);
    expect(corpus.nDomains).toBe(0);
    expect(corpus.perBot).toHaveLength(ANSWER_ENGINE_BOTS.length);
    for (const b of corpus.perBot) {
      expect(b.allowed).toBe(0);
      expect(b.disallowed).toBe(0);
      expect(b.unknown).toBe(0);
      expect(b.allowedShare).toBe(0);
    }
    expect(corpus.perDomain).toHaveLength(0);
  });

  it("all-allowed domain: crawlEligibility = 1", () => {
    const corpus = aggregateAccessibility(
      [{ domain: "example.com", robotsText: "" }],
      ["GPTBot", "ClaudeBot"],
    );
    expect(corpus.nDomains).toBe(1);
    expect(corpus.perDomain[0]!.crawlEligibility).toBe(1);
    for (const b of corpus.perBot) {
      expect(b.allowed).toBe(1);
      expect(b.disallowed).toBe(0);
      expect(b.allowedShare).toBe(1);
    }
  });

  it("all-disallowed domain: crawlEligibility = 0", () => {
    const corpus = aggregateAccessibility(
      [{ domain: "blocked.com", robotsText: "User-agent: *\nDisallow: /" }],
      ["GPTBot", "ClaudeBot"],
    );
    expect(corpus.perDomain[0]!.crawlEligibility).toBe(0);
    for (const b of corpus.perBot) {
      expect(b.disallowed).toBe(1);
      expect(b.allowedShare).toBe(0);
    }
  });

  it("null robots.txt: all bots unknown; crawlEligibility = 0 (no known bots)", () => {
    const corpus = aggregateAccessibility(
      [{ domain: "unknown.com", robotsText: null }],
      ["GPTBot", "ClaudeBot"],
    );
    expect(corpus.nDomains).toBe(1);
    expect(corpus.perDomain[0]!.crawlEligibility).toBe(0);
    for (const b of corpus.perBot) {
      expect(b.unknown).toBe(1);
      expect(b.allowed).toBe(0);
      expect(b.disallowed).toBe(0);
      expect(b.allowedShare).toBe(0);
    }
  });

  it("allowedShare computed over KNOWN only (unknown not in denominator)", () => {
    // 2 domains: one allows GPTBot, one has null (unknown).
    // allowedShare = 1 / (1 + 0) = 1, not 1/2.
    const corpus = aggregateAccessibility(
      [
        { domain: "open.com", robotsText: "" },
        { domain: "mystery.com", robotsText: null },
      ],
      ["GPTBot"],
    );
    const gptBotRow = corpus.perBot.find((b) => b.bot === "GPTBot")!;
    expect(gptBotRow.allowed).toBe(1);
    expect(gptBotRow.unknown).toBe(1);
    expect(gptBotRow.allowedShare).toBe(1); // 1/(1+0)
  });

  it("mixed corpus: partial allow, partial disallow, partial unknown — correct shares", () => {
    const bots = ["GPTBot"] as const;
    const corpus = aggregateAccessibility(
      [
        { domain: "a.com", robotsText: "" },                          // GPTBot allowed
        { domain: "b.com", robotsText: "User-agent: *\nDisallow: /" }, // GPTBot disallowed
        { domain: "c.com", robotsText: null },                         // unknown
      ],
      bots,
    );
    expect(corpus.nDomains).toBe(3);
    const row = corpus.perBot.find((b) => b.bot === "GPTBot")!;
    expect(row.allowed).toBe(1);
    expect(row.disallowed).toBe(1);
    expect(row.unknown).toBe(1);
    // allowedShare = 1 / (1 + 1) = 0.5 (known only)
    expect(row.allowedShare).toBeCloseTo(0.5);

    // crawlEligibility:
    // a.com: 1/1 = 1
    expect(corpus.perDomain.find((d) => d.domain === "a.com")!.crawlEligibility).toBe(1);
    // b.com: 0/1 = 0
    expect(corpus.perDomain.find((d) => d.domain === "b.com")!.crawlEligibility).toBe(0);
    // c.com: null → 0/0 → 0
    expect(corpus.perDomain.find((d) => d.domain === "c.com")!.crawlEligibility).toBe(0);
  });

  it("nDomains equals the length of the input array", () => {
    const corpus = aggregateAccessibility(
      [
        { domain: "x.com", robotsText: "" },
        { domain: "y.com", robotsText: null },
        { domain: "z.com", robotsText: "User-agent: *\nDisallow: /" },
      ],
      ["GPTBot"],
    );
    expect(corpus.nDomains).toBe(3);
  });

  it("is deterministic: repeated calls produce identical output", () => {
    const input: ReadonlyArray<{ domain: string; robotsText: string | null }> = [
      { domain: "a.com", robotsText: "User-agent: GPTBot\nDisallow: /" },
      { domain: "b.com", robotsText: null },
      { domain: "c.com", robotsText: "" },
    ];
    const r1 = aggregateAccessibility(input, ["GPTBot", "ClaudeBot"]);
    const r2 = aggregateAccessibility(input, ["GPTBot", "ClaudeBot"]);
    expect(r1).toEqual(r2);
  });
});
