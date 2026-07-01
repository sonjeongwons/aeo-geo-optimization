/**
 * test/deploy/throttle-transactional-cap.test.ts
 *
 * T19 — Throttle, eligibility, approval, disclosure gate tests.
 *
 * Assert: transactional cap — concurrent claims cannot over-publish beyond
 * max_per_day. Because we cannot spin up two real DB transactions in a unit
 * test without a live DB, we validate the PURE decision function's behavior
 * under simulated concurrent scenarios:
 *
 *   1. Sequential invocations with a state that increments between calls
 *      (as the transactional increment would produce) → the (N+1)th call is
 *      blocked once the cap is reached.
 *
 *   2. computeRemainingBudget returns 0 once the state count meets max_per_day,
 *      preventing dispatch from over-claiming a batch.
 *
 *   3. Multiple callers passing the same state (stale read before the lock) are
 *      all "allowed" by the pure function — showing WHY the repo-level FOR UPDATE
 *      + atomic increment is the real enforcement. The pure function alone is
 *      insufficient; the lock is in the transaction.
 *
 * Together these tests document the layered design: pure canPublishNow encodes
 * the policy; the DB transaction (FOR UPDATE + upsertThrottleStateIncrement)
 * enforces atomicity.  Both layers must be present for the cap to hold.
 *
 * SPEC §7#5.
 * DESIGN-phase3.md §"Naturalness Throttle", §"Key Decisions" (transactional cap).
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

function makePolicy(max_per_day = 3, overrides: Partial<ThrottlePolicy> = {}): ThrottlePolicy {
  return {
    channel_class: "pr_wire",
    max_per_day,
    max_per_week: max_per_day * 7,
    min_interval_minutes: 0,
    enabled: true,
    ...overrides,
  };
}

function makeState(count: number, last_publish_at: Date | null = null): ThrottleState {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    customer_id: null,
    channel_class: "pr_wire",
    window_start: WINDOW_START,
    count,
    week_count: count, // mirror daily count for simplicity in cap tests
    week_start: currentWindowStart(NOW), // same as day start for intra-day tests
    last_publish_at,
  };
}

// ---------------------------------------------------------------------------
// 1. Sequential publish simulation: cap is enforced on the (N+1)th call
// ---------------------------------------------------------------------------

describe("canPublishNow — sequential calls simulate transactional cap", () => {
  it("allows up to max_per_day sequential publishes, blocks the next", () => {
    const policy = makePolicy(3);
    const decisions: boolean[] = [];

    // Simulate 4 sequential publish attempts where each increments the count.
    for (let i = 0; i <= 3; i++) {
      const state = makeState(i);
      const decision = canPublishNow(policy, state, NOW);
      decisions.push(decision.allowed);
    }

    // First 3 allowed (count 0,1,2 < max_per_day=3); 4th blocked (count=3)
    expect(decisions[0]).toBe(true);   // count=0
    expect(decisions[1]).toBe(true);   // count=1
    expect(decisions[2]).toBe(true);   // count=2
    expect(decisions[3]).toBe(false);  // count=3 → blocked
  });

  it("reason is 'over_daily_cap' on the blocking call", () => {
    const policy = makePolicy(2);
    const decision = canPublishNow(policy, makeState(2), NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("over_daily_cap");
    }
  });

  it("no more than max_per_day unique allowed decisions exist in the sequence", () => {
    const policy = makePolicy(5);
    let allowedCount = 0;
    for (let i = 0; i < 10; i++) {
      const state = makeState(i);
      if (canPublishNow(policy, state, NOW).allowed) {
        allowedCount++;
      }
    }
    expect(allowedCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 2. computeRemainingBudget — used by dispatch to pre-size the batch claim
// ---------------------------------------------------------------------------

describe("computeRemainingBudget — batch-size pre-computation", () => {
  it("returns max_per_day when no state row exists (null state)", () => {
    const policy = makePolicy(10);
    expect(computeRemainingBudget(policy, null, WINDOW_START)).toBe(10);
  });

  it("returns 0 when count equals max_per_day", () => {
    const policy = makePolicy(5);
    const state = makeState(5);
    expect(computeRemainingBudget(policy, state, WINDOW_START)).toBe(0);
  });

  it("returns remaining slots when partially consumed", () => {
    const policy = makePolicy(10);
    const state = makeState(7);
    expect(computeRemainingBudget(policy, state, WINDOW_START)).toBe(3);
  });

  it("never returns a negative value (clamps at 0)", () => {
    const policy = makePolicy(3);
    const state = makeState(100); // over cap
    expect(computeRemainingBudget(policy, state, WINDOW_START)).toBe(0);
  });

  it("returns 0 when policy is null (fail-closed)", () => {
    expect(computeRemainingBudget(null, null, WINDOW_START)).toBe(0);
  });

  it("returns 0 when policy is disabled", () => {
    const policy = makePolicy(10, { enabled: false });
    expect(computeRemainingBudget(policy, makeState(2), WINDOW_START)).toBe(0);
  });

  it("resets budget to max_per_day when state is from a prior window", () => {
    // State from yesterday — budget should reset
    const yesterday = new Date(NOW);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const oldWindowStart = currentWindowStart(yesterday);
    const policy = makePolicy(10);
    const state: ThrottleState = {
      id: "00000000-0000-0000-0000-000000000003",
      customer_id: null,
      channel_class: "pr_wire",
      window_start: oldWindowStart,
      count: 8, // from yesterday, should not apply today
      week_count: 8,
      week_start: oldWindowStart,
      last_publish_at: null,
    };
    // computeRemainingBudget checks window_start >= provided windowStart
    expect(computeRemainingBudget(policy, state, WINDOW_START)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 3. The pure-function limitation: shows why the DB lock is necessary
// ---------------------------------------------------------------------------

describe("the pure function alone cannot prevent concurrent over-publish", () => {
  it("two calls with the SAME state both return allowed:true (illustrating race without lock)", () => {
    // This test documents WHY the DB FOR UPDATE lock is required.
    // If two workers read the SAME state row (count=2, max=3) before either
    // increments, both canPublishNow() calls return allowed:true.
    // The real enforcement is in the atomic SQL transaction.
    const policy = makePolicy(3);
    const sharedState = makeState(2); // 1 slot remaining

    const d1 = canPublishNow(policy, sharedState, NOW);
    const d2 = canPublishNow(policy, sharedState, NOW);

    // Both say allowed because they both see count=2 < max=3
    expect(d1.allowed).toBe(true);
    expect(d2.allowed).toBe(true);

    // THIS IS EXPECTED AND INTENTIONAL:
    // The actual atomicity comes from the DB: one of the two concurrent
    // transactions will lose the FOR UPDATE race and see count=3 after
    // upsertThrottleStateIncrement completes in the other transaction.
    // canPublishNow is the POLICY function; the DB lock is the ENFORCEMENT.
  });
});

// ---------------------------------------------------------------------------
// 4. Max cap = 1 (tightest possible throttle)
// ---------------------------------------------------------------------------

describe("canPublishNow — max_per_day=1 tightest throttle", () => {
  it("allows exactly one publish per day", () => {
    const policy = makePolicy(1, { min_interval_minutes: 0 });

    const first = canPublishNow(policy, makeState(0), NOW);
    expect(first.allowed).toBe(true);

    const second = canPublishNow(policy, makeState(1), NOW);
    expect(second.allowed).toBe(false);
    if (!second.allowed) {
      expect(second.reason).toBe("over_daily_cap");
    }
  });
});
