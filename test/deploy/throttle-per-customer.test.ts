/**
 * test/deploy/throttle-per-customer.test.ts
 *
 * T19 — Throttle, eligibility, approval, disclosure gate tests.
 *
 * Assert: per-customer throttle isolation — one noisy customer cannot starve
 * another.  Specifically:
 *
 *   1. Per-customer isolation: customer A at cap does not block customer B.
 *   2. The NULL-customer bucket (COALESCE): generic owned-net assets (no
 *      customer_id) are tracked separately from any real customer.
 *   3. A customer at daily cap is blocked; another customer at count=0 is allowed.
 *   4. Different channel classes are tracked independently per customer.
 *
 * These are pure unit tests of canPublishNow + computeRemainingBudget with
 * explicitly constructed per-customer state objects.
 *
 * SPEC §7#5.
 * DESIGN-phase3.md §"Naturalness Throttle" (per-customer isolation, COALESCE NULL bucket).
 */

import { describe, it, expect, vi } from "vitest";

// Mock the repo dependency so the pg/DB import chain does not execute in unit tests.
vi.mock("../../src/db/repo.js", () => ({
  readThrottlePolicy: vi.fn().mockResolvedValue(null),
}));

import {
  canPublishNow,
  computeRemainingBudget,
  currentWindowStart,
  type ThrottlePolicy,
  type ThrottleState,
} from "../../src/deploy/throttle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-21T10:00:00Z");
const WINDOW_START = currentWindowStart(NOW);

const CUSTOMER_A = "aaaaaaaa-0000-0000-0000-000000000001";
const CUSTOMER_B = "bbbbbbbb-0000-0000-0000-000000000002";

function makePolicy(overrides: Partial<ThrottlePolicy> = {}): ThrottlePolicy {
  return {
    channel_class: "owned_net",
    max_per_day: 5,
    max_per_week: 30,
    min_interval_minutes: 0,
    enabled: true,
    ...overrides,
  };
}

function makeState(
  customer_id: string | null,
  count: number,
  channel_class = "owned_net",
): ThrottleState {
  return {
    id: `state-${customer_id ?? "null"}-${channel_class}`,
    customer_id,
    channel_class,
    window_start: WINDOW_START,
    count,
    week_count: count,  // mirror daily count; weekly cap (max_per_week=30) not tested here
    week_start: WINDOW_START,
    last_publish_at: null,
  };
}

// ---------------------------------------------------------------------------
// 1. Customer isolation: A at cap does NOT block B
// ---------------------------------------------------------------------------

describe("per-customer throttle isolation", () => {
  it("customer A at daily cap is blocked while customer B is allowed", () => {
    const policy = makePolicy({ max_per_day: 5 });

    // Customer A has exhausted their daily budget
    const stateA = makeState(CUSTOMER_A, 5);
    const decisionA = canPublishNow(policy, stateA, NOW);
    expect(decisionA.allowed).toBe(false);
    if (!decisionA.allowed) {
      expect(decisionA.reason).toBe("over_daily_cap");
    }

    // Customer B has used none of their budget — different state row
    const stateB = makeState(CUSTOMER_B, 0);
    const decisionB = canPublishNow(policy, stateB, NOW);
    expect(decisionB.allowed).toBe(true);
  });

  it("customer B at cap does NOT block customer A", () => {
    const policy = makePolicy({ max_per_day: 3 });

    const stateA = makeState(CUSTOMER_A, 1); // A has 2 remaining
    const stateB = makeState(CUSTOMER_B, 3); // B is at cap

    expect(canPublishNow(policy, stateA, NOW).allowed).toBe(true);
    expect(canPublishNow(policy, stateB, NOW).allowed).toBe(false);
  });

  it("both customers independently approaching cap", () => {
    const policy = makePolicy({ max_per_day: 2 });

    // Both at 1 publish (1 remaining each)
    expect(canPublishNow(policy, makeState(CUSTOMER_A, 1), NOW).allowed).toBe(true);
    expect(canPublishNow(policy, makeState(CUSTOMER_B, 1), NOW).allowed).toBe(true);

    // Both at 2 publishes (at cap)
    expect(canPublishNow(policy, makeState(CUSTOMER_A, 2), NOW).allowed).toBe(false);
    expect(canPublishNow(policy, makeState(CUSTOMER_B, 2), NOW).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. NULL-customer bucket (COALESCE NULL) — generic owned-net
// ---------------------------------------------------------------------------

describe("NULL-customer bucket — COALESCE NULL generic owned-net", () => {
  it("NULL customer (generic owned-net) is tracked separately from real customers", () => {
    const policy = makePolicy({ max_per_day: 3 });

    // Generic NULL bucket is at cap
    const nullState = makeState(null, 3);
    expect(canPublishNow(policy, nullState, NOW).allowed).toBe(false);

    // Customer A has its own fresh budget
    const customerAState = makeState(CUSTOMER_A, 0);
    expect(canPublishNow(policy, customerAState, NOW).allowed).toBe(true);
  });

  it("customer A at cap does not affect NULL bucket", () => {
    const policy = makePolicy({ max_per_day: 5 });

    // Customer A exhausted
    const stateA = makeState(CUSTOMER_A, 5);
    expect(canPublishNow(policy, stateA, NOW).allowed).toBe(false);

    // NULL bucket (generic owned-net) unaffected
    const nullState = makeState(null, 0);
    expect(canPublishNow(policy, nullState, NOW).allowed).toBe(true);
  });

  it("NULL bucket at cap is blocked while named customers are allowed", () => {
    const policy = makePolicy({ max_per_day: 2 });

    const nullState = makeState(null, 2);
    expect(canPublishNow(policy, nullState, NOW).allowed).toBe(false);

    expect(canPublishNow(policy, makeState(CUSTOMER_A, 0), NOW).allowed).toBe(true);
    expect(canPublishNow(policy, makeState(CUSTOMER_B, 1), NOW).allowed).toBe(true);
  });

  it("NULL bucket remaining budget is computed independently", () => {
    const policy = makePolicy({ max_per_day: 10 });

    // NULL bucket used 7 → 3 remaining
    expect(computeRemainingBudget(policy, makeState(null, 7), WINDOW_START)).toBe(3);

    // Customer A used 2 → 8 remaining (independent)
    expect(computeRemainingBudget(policy, makeState(CUSTOMER_A, 2), WINDOW_START)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 3. Different channels tracked independently per customer
// ---------------------------------------------------------------------------

describe("per-channel isolation within a customer", () => {
  it("customer A at cap for owned_net is not blocked for pr_wire", () => {
    // owned_net policy
    const ownedNetPolicy = makePolicy({ channel_class: "owned_net", max_per_day: 5 });
    // pr_wire policy
    const prWirePolicy = makePolicy({ channel_class: "pr_wire", max_per_day: 2 });

    // Customer A is at owned_net cap
    const stateOwnedNet = makeState(CUSTOMER_A, 5, "owned_net");
    expect(canPublishNow(ownedNetPolicy, stateOwnedNet, NOW).allowed).toBe(false);

    // But pr_wire state is fresh for customer A
    const statePrWire = makeState(CUSTOMER_A, 0, "pr_wire");
    expect(canPublishNow(prWirePolicy, statePrWire, NOW).allowed).toBe(true);
  });

  it("throttle state is keyed per (customer_id, channel_class) pair", () => {
    // 4 separate (customer, channel) combinations, all with max_per_day=3:
    const combinations: Array<{ cid: string | null; ch: string; count: number; expectedAllowed: boolean }> = [
      { cid: CUSTOMER_A, ch: "owned_net", count: 2, expectedAllowed: true },  // 2/3 → allowed
      { cid: CUSTOMER_A, ch: "pr_wire",   count: 3, expectedAllowed: false }, // 3/3 → blocked
      { cid: CUSTOMER_B, ch: "owned_net", count: 0, expectedAllowed: true },  // 0/3 → allowed
      { cid: null,       ch: "owned_net", count: 3, expectedAllowed: false }, // 3/3 → blocked
    ];

    for (const { cid, ch, count, expectedAllowed } of combinations) {
      // Each combination uses a policy with max_per_day=3 for that specific channel
      const p = makePolicy({ channel_class: ch, max_per_day: 3 });
      const state = makeState(cid, count, ch);
      const decision = canPublishNow(p, state, NOW);
      expect(decision.allowed).toBe(expectedAllowed);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. computeRemainingBudget reflects per-customer state correctly
// ---------------------------------------------------------------------------

describe("computeRemainingBudget — per-customer isolation", () => {
  it("returns correct remaining for customer A, B, and NULL independently", () => {
    const policy = makePolicy({ max_per_day: 10 });

    expect(computeRemainingBudget(policy, makeState(CUSTOMER_A, 3), WINDOW_START)).toBe(7);
    expect(computeRemainingBudget(policy, makeState(CUSTOMER_B, 9), WINDOW_START)).toBe(1);
    expect(computeRemainingBudget(policy, makeState(null, 0), WINDOW_START)).toBe(10);
  });
});
