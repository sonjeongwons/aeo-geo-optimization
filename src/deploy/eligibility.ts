/**
 * src/deploy/eligibility.ts
 *
 * T10 — Eligibility gate (pure predicate, no IO).
 *
 * isPublishEligible() is a fail-closed predicate re-derived at execute time.
 * It mirrors the pattern of isQueueEligible() in Phase 2 and is called by
 * publishUnit.ts AFTER the queue-row lease has been taken, before any connector
 * side effect.
 *
 * Three conditions must ALL be true:
 *   1. gate_status === 'passed'   — re-read from content_asset at execute time
 *                                   (a re-gate flip to 'blocked'/'needs_human'
 *                                    after queueing closes the publish path).
 *   2. approvedBy != null         — human approver identity captured by
 *                                    approveDeploy CLI (§11 고객 승인, §12 audit).
 *                                    A bare NULL is fail-closed NOT eligible.
 *   3. queueStatus === 'leased'   — this worker holds the row lease (SKIP LOCKED
 *                                    claim succeeded). 'queued'/'published'/'failed'
 *                                    are all not-eligible.
 *
 * DESIGN-phase3.md §"Idempotency & Safety" / §"Human-Approval".
 * SPEC §11, §12.
 */

// ---------------------------------------------------------------------------
// EligibilityInput — shape of the data points re-derived at execute time
// ---------------------------------------------------------------------------

/**
 * Minimum eligibility context re-derived from the JOIN of content_deploy_queue
 * and content_asset at execute time inside publishUnit.
 *
 * These fields come from TWO sources:
 *   - gateStatus, approvedBy: content_asset (re-read from DB, not trusted from payload)
 *   - queueStatus:            content_deploy_queue (the leased row status)
 *
 * Not all columns are needed for the predicate — callers pass only these three.
 */
export interface EligibilityInput {
  /**
   * Terminal gate status from content_asset.gate_status.
   * Re-read at execute time so a post-queue re-gate flip is respected.
   */
  gateStatus: string;

  /**
   * Human approver identity from content_deploy_queue.approved_by.
   * NULL until approveDeploy CLI records a non-empty approver identity + timestamp.
   * Fail-closed: NULL → not eligible.
   */
  approvedBy: string | null;

  /**
   * Queue row status from content_deploy_queue.status.
   * Must be 'leased' (this worker holds the SKIP LOCKED claim).
   * Any other status (queued / published / failed / unpublished) → not eligible.
   */
  queueStatus: string;
}

// ---------------------------------------------------------------------------
// EligibilityResult — typed reason when not eligible
// ---------------------------------------------------------------------------

export type EligibilityReason =
  | "gate_not_passed"   // gateStatus !== 'passed'
  | "not_approved"      // approvedBy is null
  | "not_leased";       // queueStatus !== 'leased'

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: EligibilityReason };

// ---------------------------------------------------------------------------
// isPublishEligible — pure predicate
// ---------------------------------------------------------------------------

/**
 * isPublishEligible — fail-closed eligibility check, pure and synchronous.
 *
 * Returns { eligible: true } only when ALL three conditions hold:
 *   - gateStatus === 'passed'
 *   - approvedBy !== null (and not empty string)
 *   - queueStatus === 'leased'
 *
 * Called by publishUnit.ts AFTER the queue row is leased and BEFORE any
 * connector side effect. Re-derives eligibility from current DB state (the
 * caller passes freshly read values) — never trusts stale payload fields.
 *
 * A false return from this predicate means publishUnit resolves as a no-op
 * (the queue row is released back to 'queued' by the caller for re-try after
 * the blocking condition is resolved, e.g. human approves or re-gate passes).
 *
 * @param input - Freshly read eligibility context from content_asset + queue row.
 * @returns     EligibilityResult — eligible or not-eligible with reason.
 */
export function isPublishEligible(input: EligibilityInput): EligibilityResult {
  if (input.gateStatus !== "passed") {
    return { eligible: false, reason: "gate_not_passed" };
  }

  if (input.approvedBy == null || input.approvedBy.trim() === "") {
    return { eligible: false, reason: "not_approved" };
  }

  if (input.queueStatus !== "leased") {
    return { eligible: false, reason: "not_leased" };
  }

  return { eligible: true };
}
