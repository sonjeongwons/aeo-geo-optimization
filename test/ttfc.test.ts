/** test/ttfc.test.ts — Time-To-First-Citation (TTFC) KPI, X23. */
import { describe, it, expect } from "vitest";
import { computeTtfc, kmPercentile } from "../src/metrics/ttfc.js";
import type { TtfcObservation } from "../src/metrics/ttfc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = 1_000_000; // arbitrary epoch-ms anchor

/** Build an observation with a known event (firstCitedAt = observedSince + durationMs). */
function eventObs(durationMs: number, sinceMs = BASE): TtfcObservation {
  return {
    observedSinceMs: sinceMs,
    firstCitedAtMs: sinceMs + durationMs,
    asOfMs: sinceMs + durationMs + 1,
  };
}

/** Build a right-censored observation (not yet cited). */
function censoredObs(observedDurationMs: number, sinceMs = BASE): TtfcObservation {
  return {
    observedSinceMs: sinceMs,
    firstCitedAtMs: null,
    asOfMs: sinceMs + observedDurationMs,
  };
}

// ---------------------------------------------------------------------------
// kmPercentile — unit tests
// ---------------------------------------------------------------------------

describe("kmPercentile", () => {
  it("throws RangeError when p = 0", () => {
    expect(() => kmPercentile([], 0)).toThrow(RangeError);
  });

  it("throws RangeError when p = 1", () => {
    expect(() => kmPercentile([], 1)).toThrow(RangeError);
  });

  it("throws RangeError when p > 1", () => {
    expect(() => kmPercentile([], 1.5)).toThrow(RangeError);
  });

  it("throws RangeError when p < 0", () => {
    expect(() => kmPercentile([], -0.1)).toThrow(RangeError);
  });

  it("returns null for empty array", () => {
    expect(kmPercentile([], 0.5)).toBeNull();
  });

  it("returns null when there are no events (all censored)", () => {
    const data = [
      { timeMs: 10, event: false },
      { timeMs: 20, event: false },
    ];
    expect(kmPercentile(data, 0.5)).toBeNull();
  });

  it("is deterministic — same input yields same output", () => {
    const data = [
      { timeMs: 10, event: true },
      { timeMs: 20, event: true },
      { timeMs: 30, event: false },
    ];
    const r1 = kmPercentile(data, 0.5);
    const r2 = kmPercentile(data, 0.5);
    expect(r1).toBe(r2);
  });

  it("all events — median is the second event time for 3 equal-weight events", () => {
    // 3 events at t=10,20,30, no censoring.
    // KM: after t=10: S=2/3, F=1/3. after t=20: S=1/3, F=2/3 ≥ 0.5 → median=20.
    const data = [
      { timeMs: 10, event: true },
      { timeMs: 20, event: true },
      { timeMs: 30, event: true },
    ];
    expect(kmPercentile(data, 0.5)).toBe(20);
  });

  it("4 events at times 5,10,15,20 — median resolves correctly", () => {
    // After t=5:  S=3/4, F=1/4
    // After t=10: S=2/4, F=2/4=0.5 → median=10
    const data = [
      { timeMs: 5, event: true },
      { timeMs: 10, event: true },
      { timeMs: 15, event: true },
      { timeMs: 20, event: true },
    ];
    expect(kmPercentile(data, 0.5)).toBe(10);
  });

  it("heavy censoring: 1 event at t=10, 9 censored at t=100 — F never reaches 0.5 → null", () => {
    // n=10; at t=10: atRisk=10, events=1 → S=0.9, F=0.1 < 0.5.
    // No more event times → null.
    const data: Array<{ timeMs: number; event: boolean }> = [
      { timeMs: 10, event: true },
      ...Array.from({ length: 9 }, () => ({ timeMs: 100, event: false })),
    ];
    expect(kmPercentile(data, 0.5)).toBeNull();
  });

  it("returns the smallest t where F first crosses p", () => {
    // 2 events at t=5 and t=15 out of 4 total (2 censored at t=20).
    // At t=5: atRisk=4, events=1 → S=3/4, F=1/4.
    // At t=15: atRisk=3 (durations: 5✓, 15✓, 20✗, 20✗ — 3 have timeMs≥15), events=1 → S=3/4*(2/3)=1/2, F=1/2≥0.5 → p50=15.
    const data = [
      { timeMs: 5, event: true },
      { timeMs: 15, event: true },
      { timeMs: 20, event: false },
      { timeMs: 20, event: false },
    ];
    expect(kmPercentile(data, 0.5)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// computeTtfc — integration tests
// ---------------------------------------------------------------------------

describe("computeTtfc", () => {
  it("empty input → zero counts, all percentiles null", () => {
    const r = computeTtfc([]);
    expect(r.n).toBe(0);
    expect(r.events).toBe(0);
    expect(r.censored).toBe(0);
    expect(r.medianMs).toBeNull();
    expect(r.p75Ms).toBeNull();
    expect(r.p90Ms).toBeNull();
  });

  it("all events with known times → KM median matches expected", () => {
    // 3 events at t=10, 20, 30 ms.
    const obs: TtfcObservation[] = [
      eventObs(10),
      eventObs(20),
      eventObs(30),
    ];
    const r = computeTtfc(obs);
    expect(r.n).toBe(3);
    expect(r.events).toBe(3);
    expect(r.censored).toBe(0);
    // KM median for 3 events at 10,20,30: F crosses 0.5 at t=20 (see kmPercentile test above).
    expect(r.medianMs).toBe(20);
  });

  it("events=0 → all percentiles null, note describes no-event situation", () => {
    const obs: TtfcObservation[] = [
      censoredObs(1000),
      censoredObs(2000),
    ];
    const r = computeTtfc(obs);
    expect(r.n).toBe(2);
    expect(r.events).toBe(0);
    expect(r.censored).toBe(2);
    expect(r.medianMs).toBeNull();
    expect(r.p75Ms).toBeNull();
    expect(r.p90Ms).toBeNull();
    expect(r.note).toMatch(/no events observed/i);
  });

  it("heavy censoring: 1 event, 9 censored → medianMs null (KM curve never reaches 0.5)", () => {
    // 1 event at t=10ms; 9 censored at t=100ms.
    // After KM step at t=10: F=0.1 < 0.5 → medianMs null.
    const obs: TtfcObservation[] = [
      eventObs(10),
      ...Array.from({ length: 9 }, () => censoredObs(100)),
    ];
    const r = computeTtfc(obs);
    expect(r.n).toBe(10);
    expect(r.events).toBe(1);
    expect(r.censored).toBe(9);
    expect(r.medianMs).toBeNull();
    // p75 and p90 are also unreachable.
    expect(r.p75Ms).toBeNull();
    expect(r.p90Ms).toBeNull();
  });

  it("censored vs event classification: firstCitedAtMs=null → censored", () => {
    const obs: TtfcObservation[] = [
      { observedSinceMs: BASE, firstCitedAtMs: null, asOfMs: BASE + 500 },
    ];
    const r = computeTtfc(obs);
    expect(r.events).toBe(0);
    expect(r.censored).toBe(1);
  });

  it("censored vs event classification: firstCitedAtMs set → event", () => {
    const obs: TtfcObservation[] = [
      { observedSinceMs: BASE, firstCitedAtMs: BASE + 200, asOfMs: BASE + 500 },
    ];
    const r = computeTtfc(obs);
    expect(r.events).toBe(1);
    expect(r.censored).toBe(0);
  });

  it("firstCitedAtMs < observedSinceMs → treated as censored (invalid event time)", () => {
    // firstCitedAtMs < observedSinceMs means the citation predates tracking → not a valid event.
    const obs: TtfcObservation[] = [
      { observedSinceMs: BASE + 100, firstCitedAtMs: BASE, asOfMs: BASE + 500 },
    ];
    const r = computeTtfc(obs);
    // Should be treated as censored (not as an event).
    expect(r.events).toBe(0);
    expect(r.censored).toBe(1);
  });

  it("invalid observation: asOfMs < observedSinceMs with no event → dropped", () => {
    const obs: TtfcObservation[] = [
      { observedSinceMs: BASE + 1000, firstCitedAtMs: null, asOfMs: BASE },
    ];
    const r = computeTtfc(obs);
    expect(r.n).toBe(0);
  });

  it("note mentions censoring count and total", () => {
    const obs: TtfcObservation[] = [
      eventObs(10),
      censoredObs(50),
      censoredObs(60),
    ];
    const r = computeTtfc(obs);
    // note should say "2/3 assets not yet cited" (2 censored out of 3 total).
    expect(r.note).toMatch(/2\/3/);
  });

  it("note NEVER uses 'mean' as a reported statistic — only to say it is omitted", () => {
    const obs: TtfcObservation[] = [eventObs(10), censoredObs(50)];
    const r = computeTtfc(obs);
    // The word 'mean' must appear only in the context of omission/intentional exclusion.
    // It must NOT appear as "mean = X" or "mean: X" or "mean is Xms".
    expect(r.note).not.toMatch(/mean\s*(=|:|\bis\b\s+\d)/i);
    // Confirm the note does reference omission of mean.
    expect(r.note).toMatch(/mean.*omitted|omit.*mean/i);
  });

  it("determinism: same input produces identical output on repeated calls", () => {
    const obs: TtfcObservation[] = [
      eventObs(10),
      eventObs(20),
      censoredObs(50),
      censoredObs(80),
    ];
    const r1 = computeTtfc(obs);
    const r2 = computeTtfc(obs);
    expect(r1).toEqual(r2);
  });

  it("p75 and p90 resolve when enough events exist", () => {
    // 10 events at t=10,20,...,100. With no censoring:
    // After each step S decrements by 1/n_remaining.
    // F at t=70 (7th event) = 7/10 = 0.7 → p75 not yet reached.
    // F at t=80 (8th event) = 8/10 = 0.8 ≥ 0.75 → p75=80.
    // F at t=90 (9th event) = 9/10 = 0.9 ≥ 0.9 → p90=90.
    const obs: TtfcObservation[] = Array.from({ length: 10 }, (_, i) =>
      eventObs((i + 1) * 10),
    );
    const r = computeTtfc(obs);
    expect(r.events).toBe(10);
    expect(r.p75Ms).toBe(80);
    expect(r.p90Ms).toBe(90);
  });
});
