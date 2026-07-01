/**
 * src/deploy/throttle.ts
 *
 * T09 — Naturalness throttle decision module (§7#5).
 *
 * Enforces the §7#5 "naturalness throttle" — a fail-closed code gate that runs
 * BEFORE connector.publish() is called.  The actual atomic counter increment
 * and row-locking live in repo.ts (claimNextDeployBatch / readThrottleStateForUpdate
 * / upsertThrottleStateIncrement).  This module is:
 *
 *   1. canPublishNow(policy, state, now) — PURE decision function; no IO.
 *      Returns {allowed:true} | {allowed:false, retryAfterMs, reason}.
 *      Fail-closed: missing/disabled policy → allowed:false.
 *
 *   2. loadThrottlePolicy(channelClass) — glue: reads the channel_throttle row
 *      from the DB via repo.  Returns null on missing/disabled row (fail-closed).
 *
 *   3. computeRemainingBudget(policy, state, windowStart) — pure helper used by
 *      claimNextDeployBatch to size the batch before the atomic transaction.
 *
 *   4. currentWindowStart(now) — pure helper returning midnight-UTC of now (the
 *      daily window boundary used throughout Phase 3 dispatch).
 *
 * DRY-RUN: when dryRun is true the dispatch/publishUnit layers skip the throttle
 * counter increment entirely — dry-run passes are non-consuming (they do not
 * decrement budget nor write a channel_throttle_state row).  This module only
 * encodes the decision logic; the skip is enforced by the callers.
 *
 * SPEC §7#5 / DESIGN-phase3.md §"Naturalness Throttle".
 */

import { readThrottlePolicy } from "../db/repo.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Snapshot of a channel_throttle policy row.
 * Mirrors the shape returned by readThrottlePolicy() / ChannelThrottleTable.
 *
 * Passed as a value type to canPublishNow so the decision is testable without DB.
 */
export interface ThrottlePolicy {
  channel_class: string;
  max_per_day: number;
  max_per_week: number;
  min_interval_minutes: number;
  enabled: boolean;
}

/**
 * Snapshot of a channel_throttle_state row for the current window.
 * Passed as a value type to canPublishNow so the decision is testable without DB.
 *
 * When null, the counter row does not exist yet (first publish in this window
 * for this customer+channel pair) — treated as count=0, last_publish_at=null.
 *
 * week_count and week_start were added by migration 0011_throttle_week_count.sql
 * to support transactional enforcement of max_per_week across day boundaries.
 */
export interface ThrottleState {
  id: string;
  customer_id: string | null;
  channel_class: string;
  window_start: Date;
  count: number;
  /** Weekly publish count — accumulated across all days in the current ISO week. */
  week_count: number;
  /** Start of the current ISO week (Monday 00:00:00 UTC); null for legacy rows. */
  week_start: Date | null;
  last_publish_at: Date | null;
}

// ---------------------------------------------------------------------------
// ThrottleDecision — discriminated result of canPublishNow
// ---------------------------------------------------------------------------

/**
 * Decision returned by canPublishNow().
 *
 * allowed:true  → the publish is within budget and cadence constraints.
 * allowed:false → fail-closed; retryAfterMs indicates when to next try.
 *
 * Reason codes:
 *   'no_policy'         — channel_throttle row missing or enabled=false.
 *   'over_daily_cap'    — count for today has reached max_per_day.
 *   'over_weekly_cap'   — count for the week has reached max_per_week.
 *   'min_interval'      — too soon since last_publish_at (cadence spacing).
 */
export type ThrottleDecision =
  | { allowed: true }
  | {
      allowed: false;
      retryAfterMs: number;
      reason: "no_policy" | "over_daily_cap" | "over_weekly_cap" | "min_interval";
    };

// ---------------------------------------------------------------------------
// currentWindowStart — pure helper for the daily window boundary
// ---------------------------------------------------------------------------

/**
 * Returns midnight UTC of the given date (the daily rolling-window boundary
 * used for channel_throttle_state.window_start comparisons).
 *
 * Pure, no IO.
 */
export function currentWindowStart(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Returns the start of the ISO week (Monday 00:00:00 UTC) for the given date.
 * Used for the max_per_week cap.
 *
 * Pure, no IO.
 */
export function currentWeekStart(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  // getUTCDay(): 0=Sun, 1=Mon, …, 6=Sat.  ISO week starts Monday.
  const day = d.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day; // Sunday wraps back 6 days
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d;
}

// ---------------------------------------------------------------------------
// computeRemainingBudget — pure helper for batch-sizing in claimNextDeployBatch
// ---------------------------------------------------------------------------

/**
 * Compute the remaining daily publish budget for a (policy, state) pair.
 *
 * Used by dispatch.ts to size the claimNextDeployBatch limit BEFORE the
 * atomic transaction — the actual enforcement happens inside the transaction,
 * but pre-computing the budget avoids claiming 100 rows when only 3 are allowed.
 *
 * Fail-closed: returns 0 when policy is null/disabled.
 *
 * @param policy        - The channel_throttle policy row (null = fail-closed).
 * @param state         - The current counter row (null = no publishes yet today).
 * @param windowStart   - Start of the current daily window (midnight UTC).
 * @returns             Number of remaining publishes allowed today (≥ 0).
 */
export function computeRemainingBudget(
  policy: ThrottlePolicy | null,
  state: ThrottleState | null,
  windowStart: Date,
): number {
  if (!policy || !policy.enabled) return 0;

  const todayCount =
    state && state.window_start >= windowStart ? state.count : 0;
  return Math.max(0, policy.max_per_day - todayCount);
}

// ---------------------------------------------------------------------------
// canPublishNow — PURE decision function
// ---------------------------------------------------------------------------

/**
 * canPublishNow — fail-closed throttle decision.  PURE, no IO.
 *
 * Enforces three constraints from the channel_throttle policy:
 *   1. max_per_day   — daily publish cap per (customer, channel).
 *   2. max_per_week  — weekly publish cap per (customer, channel).
 *   3. min_interval_minutes — minimum spacing between consecutive publishes.
 *
 * Fail-closed rules:
 *   - policy is null (missing/disabled row) → allowed:false, reason:'no_policy'.
 *   - policy.enabled is false               → allowed:false, reason:'no_policy'.
 *   - any constraint exceeded               → allowed:false with retryAfterMs.
 *   - state is null (no prior publish)      → counts treated as 0 (allow if policy permits).
 *
 * The `state` row comes from channel_throttle_state; the `window_start` field
 * on the state row must be compared to the daily/weekly window starts computed
 * from `now` — if the window has rolled over, counts reset to 0.
 *
 * DRY-RUN NOTE: callers must NOT call this function from a dry-run path that
 * should not consume budget.  The decision logic is identical; the skip is
 * enforced by dispatch.ts / publishUnit.ts by not calling canPublishNow (or by
 * ignoring the result for the counter-increment step).  Documented per design.
 *
 * @param policy    - channel_throttle policy row; null if missing/disabled.
 * @param state     - channel_throttle_state row for this (customer, channel); null if absent.
 * @param now       - current timestamp (injected for testability).
 * @returns ThrottleDecision — allowed or not-allowed with retryAfterMs.
 */
export function canPublishNow(
  policy: ThrottlePolicy | null,
  state: ThrottleState | null,
  now: Date,
): ThrottleDecision {
  // ── Fail-closed: no policy or disabled ───────────────────────────────────
  if (!policy || !policy.enabled) {
    return {
      allowed: false,
      // Suggest retrying after 1 hour; no real budget to compute.
      retryAfterMs: 60 * 60 * 1000,
      reason: "no_policy",
    };
  }

  const dayStart = currentWindowStart(now);
  const weekStart = currentWeekStart(now);

  // Count for today — reset to 0 if the state row is from a prior day.
  const todayCount =
    state && state.window_start >= dayStart ? state.count : 0;

  // Weekly count — use the dedicated week_count field (added by migration 0011)
  // so the cap accumulates correctly across day-window rollovers within a week.
  // Legacy rows with week_start=null are treated as 0 (fail-open for legacy data,
  // but new rows always carry week_start from migration 0011 onwards).
  const weekCount =
    state && state.week_start != null && state.week_start >= weekStart
      ? state.week_count
      : 0;

  // ── Daily cap ─────────────────────────────────────────────────────────────
  if (todayCount >= policy.max_per_day) {
    // Retry at start of next day UTC.
    const nextDayStart = new Date(dayStart);
    nextDayStart.setUTCDate(nextDayStart.getUTCDate() + 1);
    const retryAfterMs = Math.max(0, nextDayStart.getTime() - now.getTime());
    return {
      allowed: false,
      retryAfterMs,
      reason: "over_daily_cap",
    };
  }

  // ── Weekly cap ────────────────────────────────────────────────────────────
  if (weekCount >= policy.max_per_week) {
    // Retry at start of next Monday UTC.
    const nextWeekStart = new Date(weekStart);
    nextWeekStart.setUTCDate(nextWeekStart.getUTCDate() + 7);
    const retryAfterMs = Math.max(0, nextWeekStart.getTime() - now.getTime());
    return {
      allowed: false,
      retryAfterMs,
      reason: "over_weekly_cap",
    };
  }

  // ── min_interval cadence ──────────────────────────────────────────────────
  if (policy.min_interval_minutes > 0 && state && state.last_publish_at) {
    const minIntervalMs = policy.min_interval_minutes * 60 * 1000;
    const nextAllowedAt = new Date(
      state.last_publish_at.getTime() + minIntervalMs,
    );
    if (now < nextAllowedAt) {
      const retryAfterMs = Math.max(0, nextAllowedAt.getTime() - now.getTime());
      return {
        allowed: false,
        retryAfterMs,
        reason: "min_interval",
      };
    }
  }

  // ── All constraints satisfied ─────────────────────────────────────────────
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// loadThrottlePolicy — glue (reads DB via repo)
// ---------------------------------------------------------------------------

/**
 * Load the throttle policy for a channel class from the DB.
 *
 * Returns null when:
 *   - No channel_throttle row exists for this channel_class.
 *   - The row exists but enabled=false.
 *
 * Both cases are treated as fail-closed (canPublishNow returns allowed:false
 * with reason:'no_policy').
 *
 * Errors are surfaced as null (fail-closed) rather than propagated — a DB read
 * failure at dispatch time should not crash the worker but should block the
 * publish until the connection is restored.
 *
 * @param channelClass - One of the 6 ChannelClass values.
 * @returns            ThrottlePolicy | null
 */
export async function loadThrottlePolicy(
  channelClass: string,
): Promise<ThrottlePolicy | null> {
  try {
    return await readThrottlePolicy(channelClass);
  } catch {
    // Fail-closed: any DB error blocks publish.
    return null;
  }
}
