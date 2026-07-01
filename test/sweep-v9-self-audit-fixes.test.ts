/**
 * test/sweep-v9-self-audit-fixes.test.ts
 *
 * Regression locks for SOTA sweep v9 self-audit bugs (all §7 honesty violations).
 *   Z2  botAccessibility bidirectional prefix bound a bot to a longer distinct token
 *   Z4  driftControl Wald variance → falsely exact [0,0] CI at saturated cells
 *   Z5  ttfc kmPercentile dropped an exactly-reachable percentile (float boundary)
 */
import { describe, it, expect } from "vitest";
import { parseRobots, isAllowed } from "../src/metrics/botAccessibility.js";
import { computeDriftControl } from "../src/metrics/driftControl.js";
import { kmPercentile, computeTtfc } from "../src/metrics/ttfc.js";

describe("Z2 — robots matching is forward-prefix only (RFC 9309)", () => {
  it("a group for a LONGER distinct token does not capture a shorter bot", () => {
    // "ClaudeBot-Special: Disallow /" must NOT govern "ClaudeBot"; it falls
    // through to the (absent) '*' group → allowed.
    const rules = parseRobots("User-agent: ClaudeBot-Special\nDisallow: /");
    expect(isAllowed(rules, "ClaudeBot", "/")).toBe(true);
  });
  it("a forward-prefix group still governs (UA starts with the token)", () => {
    const rules = parseRobots("User-agent: GPTBot\nDisallow: /");
    // A real GPTBot UA string starts with "GPTBot".
    expect(isAllowed(rules, "GPTBot/1.2", "/")).toBe(false);
  });
  it("exact token match still governs", () => {
    const rules = parseRobots("User-agent: GPTBot\nDisallow: /");
    expect(isAllowed(rules, "GPTBot", "/")).toBe(false);
  });
});

describe("Z4 — driftControl CI is non-degenerate at saturated cells", () => {
  it("saturated cohorts (0/1 rates) do NOT produce a falsely exact [0,0] CI", () => {
    const r = computeDriftControl({
      targetedBefore: { hits: 100, n: 100 },
      targetedAfter: { hits: 100, n: 100 },
      holdoutBefore: { hits: 0, n: 100 },
      holdoutAfter: { hits: 0, n: 100 },
    });
    expect(r.netEffect).toBeCloseTo(0, 10);
    expect(r.ci95.upper - r.ci95.lower).toBeGreaterThan(0); // not [0,0]
  });
  it("a normal (non-saturated) case still yields a sensible CI", () => {
    const r = computeDriftControl({
      targetedBefore: { hits: 40, n: 100 },
      targetedAfter: { hits: 60, n: 100 },
      holdoutBefore: { hits: 30, n: 100 },
      holdoutAfter: { hits: 35, n: 100 },
    });
    // targeted +0.2, drift +0.05 → net +0.15
    expect(r.netEffect).toBeCloseTo(0.15, 10);
    expect(r.ci95.upper - r.ci95.lower).toBeGreaterThan(0);
  });
});

describe("Z5 — kmPercentile returns exactly-reachable percentiles", () => {
  it("an event that lands F exactly on 0.5 is returned (no float off-by-one)", () => {
    // Two subjects, one event at t=10 (F steps 0→0.5), one censored at t=100.
    const durations = [
      { timeMs: 10, event: true },
      { timeMs: 100, event: false },
    ];
    // F(10) = 1 - (1 - 1/2) = 0.5 exactly → median must be 10, not null.
    expect(kmPercentile(durations, 0.5)).toBe(10);
  });
  it("a clean 10-subject curve reaches its median step", () => {
    const durations = Array.from({ length: 10 }, (_, i) => ({ timeMs: i + 1, event: true }));
    // Not null and within the observed range.
    const m = kmPercentile(durations, 0.5);
    expect(m).not.toBeNull();
    expect(m!).toBeGreaterThanOrEqual(1);
    expect(m!).toBeLessThanOrEqual(10);
  });
  it("computeTtfc still returns null under heavy censoring (contract preserved)", () => {
    const obs = [
      { firstCitedAtMs: 110, observedSinceMs: 100, asOfMs: 200 }, // 1 event at dur 10
      ...Array.from({ length: 9 }, () => ({ firstCitedAtMs: null, observedSinceMs: 100, asOfMs: 200 })),
    ];
    expect(computeTtfc(obs).medianMs).toBeNull();
  });
});
