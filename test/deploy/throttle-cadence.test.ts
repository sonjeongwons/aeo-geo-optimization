/**
 * test/deploy/throttle-cadence.test.ts
 *
 * T19 — Throttle, eligibility, approval, disclosure gate tests.
 *
 * Assert: fail-closed on missing policy; daily-cap enforcement;
 * min-interval cadence (spacing between publishes).
 *
 * These are pure unit tests — canPublishNow is tested without DB I/O.
 *
 * SPEC §7#5.
 * DESIGN-phase3.md §"Naturalness Throttle".
 */

import { describe, it, expect, vi } from "vitest";

// Mock the repo dependency so the pg/DB import chain does not execute in unit tests.
// throttle.ts imports readThrottlePolicy from repo; only the pure functions are
// under test here — no DB I/O needed.
vi.mock("../../src/db/repo.js", () => ({
  readThrottlePolicy: vi.fn().mockResolvedValue(null),
}));

import {
  canPublishNow,
  currentWindowStart,
  currentWeekStart,
  type ThrottlePolicy,
  type ThrottleState,
} from "../../src/deploy/throttle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-21T10:00:00Z");

function makePolicy(overrides: Partial<ThrottlePolicy> = {}): ThrottlePolicy {
  return {
    channel_class: "owned_net",
    max_per_day: 10,
    max_per_week: 50,
    min_interval_minutes: 5,
    enabled: true,
    ...overrides,
  };
}

function makeState(overrides: Partial<ThrottleState> = {}): ThrottleState {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    customer_id: null,
    channel_class: "owned_net",
    window_start: currentWindowStart(NOW),
    count: 0,
    week_count: 0,
    week_start: currentWeekStart(NOW),
    last_publish_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Fail-closed: missing / disabled policy
// ---------------------------------------------------------------------------

describe("canPublishNow — fail-closed on missing/disabled policy", () => {
  it("returns allowed:false when policy is null", () => {
    const decision = canPublishNow(null, null, NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("no_policy");
    }
  });

  it("returns allowed:false when policy.enabled is false", () => {
    const policy = makePolicy({ enabled: false });
    const decision = canPublishNow(policy, null, NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("no_policy");
    }
  });

  it("returns a positive retryAfterMs even for missing policy", () => {
    const decision = canPublishNow(null, null, NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("returns allowed:false (not a throw) — fail-closed, not crash", () => {
    expect(() => canPublishNow(null, null, NOW)).not.toThrow();
    const decision = canPublishNow(null, null, NOW);
    expect(decision.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Daily cap enforcement
// ---------------------------------------------------------------------------

describe("canPublishNow — daily cap enforcement", () => {
  it("returns allowed:true when count is 0 and policy has budget", () => {
    const policy = makePolicy({ max_per_day: 5, min_interval_minutes: 0 });
    const state = makeState({ count: 0, last_publish_at: null });
    const decision = canPublishNow(policy, state, NOW);
    expect(decision.allowed).toBe(true);
  });

  it("returns allowed:true when count is below max_per_day", () => {
    const policy = makePolicy({ max_per_day: 10, min_interval_minutes: 0 });
    const state = makeState({ count: 9 });
    const decision = canPublishNow(policy, state, NOW);
    expect(decision.allowed).toBe(true);
  });

  it("returns allowed:false when count equals max_per_day", () => {
    const policy = makePolicy({ max_per_day: 10, min_interval_minutes: 0 });
    const state = makeState({ count: 10 });
    const decision = canPublishNow(policy, state, NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("over_daily_cap");
    }
  });

  it("returns allowed:false when count exceeds max_per_day", () => {
    const policy = makePolicy({ max_per_day: 3, min_interval_minutes: 0 });
    const state = makeState({ count: 5 });
    const decision = canPublishNow(policy, state, NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("over_daily_cap");
    }
  });

  it("retryAfterMs for over_daily_cap is roughly time until next midnight UTC", () => {
    const policy = makePolicy({ max_per_day: 1, min_interval_minutes: 0 });
    const state = makeState({ count: 1 });
    const decision = canPublishNow(policy, state, NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // Next day start minus NOW — should be positive and less than 24h+1ms
      expect(decision.retryAfterMs).toBeGreaterThan(0);
      expect(decision.retryAfterMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    }
  });

  it("resets count to 0 when state window_start is from a prior day (prior week)", () => {
    // Use a date two weeks ago so the state window is outside both the daily AND weekly window.
    // This ensures todayCount=0 AND weekCount=0, so the test purely validates daily-window reset.
    const twoWeeksAgo = new Date(NOW);
    twoWeeksAgo.setUTCDate(twoWeeksAgo.getUTCDate() - 14);
    const state = makeState({
      count: 100, // huge count, but from a different day AND week
      window_start: currentWindowStart(twoWeeksAgo),
      last_publish_at: null,
    });
    const policy = makePolicy({ max_per_day: 5, max_per_week: 30, min_interval_minutes: 0 });
    const decision = canPublishNow(policy, state, NOW);
    // count treated as 0 for today (and this week) → should be allowed
    expect(decision.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Min-interval cadence spacing
// ---------------------------------------------------------------------------

describe("canPublishNow — min_interval_minutes cadence", () => {
  it("allows publish when no prior last_publish_at", () => {
    const policy = makePolicy({ max_per_day: 10, min_interval_minutes: 60 });
    const state = makeState({ count: 1, last_publish_at: null });
    const decision = canPublishNow(policy, state, NOW);
    expect(decision.allowed).toBe(true);
  });

  it("allows publish when min_interval has passed", () => {
    // Published 2 hours ago, min_interval is 60 minutes → allowed
    const lastPublish = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const policy = makePolicy({ max_per_day: 10, min_interval_minutes: 60 });
    const state = makeState({ count: 1, last_publish_at: lastPublish });
    const decision = canPublishNow(policy, state, NOW);
    expect(decision.allowed).toBe(true);
  });

  it("blocks publish when min_interval has NOT passed", () => {
    // Published 10 minutes ago, min_interval is 60 minutes → blocked
    const lastPublish = new Date(NOW.getTime() - 10 * 60 * 1000);
    const policy = makePolicy({ max_per_day: 10, min_interval_minutes: 60 });
    const state = makeState({ count: 1, last_publish_at: lastPublish });
    const decision = canPublishNow(policy, state, NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("min_interval");
    }
  });

  it("retryAfterMs for min_interval reflects time until interval expires", () => {
    // Published 10 minutes ago, min_interval is 60 minutes → 50 minutes until next
    const lastPublish = new Date(NOW.getTime() - 10 * 60 * 1000);
    const policy = makePolicy({ max_per_day: 10, min_interval_minutes: 60 });
    const state = makeState({ count: 1, last_publish_at: lastPublish });
    const decision = canPublishNow(policy, state, NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // ~50 minutes = 3000000ms, allow some float tolerance
      expect(decision.retryAfterMs).toBeGreaterThan(49 * 60 * 1000);
      expect(decision.retryAfterMs).toBeLessThanOrEqual(51 * 60 * 1000);
    }
  });

  it("min_interval_minutes=0 never blocks on cadence alone", () => {
    const lastPublish = new Date(NOW.getTime() - 1); // 1ms ago
    const policy = makePolicy({ max_per_day: 10, min_interval_minutes: 0 });
    const state = makeState({ count: 1, last_publish_at: lastPublish });
    const decision = canPublishNow(policy, state, NOW);
    expect(decision.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. currentWindowStart and currentWeekStart pure helpers
// ---------------------------------------------------------------------------

describe("currentWindowStart — midnight UTC", () => {
  it("returns midnight UTC of the given date", () => {
    const date = new Date("2026-06-21T15:30:00Z");
    const ws = currentWindowStart(date);
    expect(ws.toISOString()).toBe("2026-06-21T00:00:00.000Z");
  });

  it("already-midnight date returns same midnight", () => {
    const date = new Date("2026-06-21T00:00:00Z");
    const ws = currentWindowStart(date);
    expect(ws.toISOString()).toBe("2026-06-21T00:00:00.000Z");
  });
});

describe("currentWeekStart — Monday midnight UTC", () => {
  it("Sunday maps back to previous Monday", () => {
    const sunday = new Date("2026-06-21T10:00:00Z"); // Sunday
    const weekStart = currentWeekStart(sunday);
    expect(weekStart.toISOString()).toBe("2026-06-15T00:00:00.000Z"); // previous Monday
  });

  it("Monday returns itself at midnight UTC", () => {
    const monday = new Date("2026-06-22T10:00:00Z"); // Monday
    const weekStart = currentWeekStart(monday);
    expect(weekStart.toISOString()).toBe("2026-06-22T00:00:00.000Z");
  });

  it("Wednesday maps back to the Monday of the same week", () => {
    const wednesday = new Date("2026-06-24T10:00:00Z"); // Wednesday
    const weekStart = currentWeekStart(wednesday);
    expect(weekStart.toISOString()).toBe("2026-06-22T00:00:00.000Z");
  });
});
