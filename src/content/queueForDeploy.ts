/**
 * src/content/queueForDeploy.ts
 *
 * T15 — queueForDeploy: select gate_status='passed' AND not-yet-queued assets
 * from a content_set and insert them into content_deploy_queue.
 *
 * §0 OFF-SITE GUARANTEE:
 *   - This module exposes NO HTTP-write verb.
 *   - It NEVER deploys content or writes to a customer property.
 *   - It ONLY inserts rows into content_deploy_queue (the Phase 3 handoff table).
 *   - Phase 3 owns any deploy transition from 'queued' → deployed.
 *
 * DESIGN-phase2.md §"Phase 0/1 Integration" (Phase 3 seam):
 *   "passed assets are queued via content_deploy_queue (status='queued',
 *   minimal/PROVISIONAL contract) OR selectable by the predicate
 *   gate_status='passed' AND not-yet-queued — THAT predicate IS the structural
 *   deploy gate; a blocked/needs_human asset is simply not selectable."
 *
 * IDEMPOTENCY:
 *   queuePassedAssets() uses the uq_deploy_queue_asset UNIQUE index
 *   (ON CONFLICT DO NOTHING) so calling queueForDeploy() multiple times for
 *   the same content_set_id is safe and produces no duplicates.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { queuePassedAssets } from "../db/repo.js";

// ---------------------------------------------------------------------------
// QueueForDeployResult
// ---------------------------------------------------------------------------

/**
 * Result returned by queueForDeploy().
 */
export interface QueueForDeployResult {
  /**
   * Number of NEW queue rows inserted (excludes already-queued assets that
   * were skipped by ON CONFLICT DO NOTHING).
   */
  queued: number;
  /** The content_set_id that was processed. */
  contentSetId: string;
}

// ---------------------------------------------------------------------------
// queueForDeploy — main export
// ---------------------------------------------------------------------------

/**
 * Queue all gate_status='passed' assets in a content_set for Phase 3 deploy.
 *
 * Only assets whose gate_status='passed' AND are NOT already in
 * content_deploy_queue are inserted.  Blocked and needs_human assets are
 * structurally excluded from the selection predicate — they are NOT selectable.
 *
 * This function is IDEMPOTENT: calling it twice for the same content_set_id
 * produces exactly the same queue state (the unique index prevents duplicates).
 *
 * NO HTTP-WRITE VERB: this function never deploys content, calls any external
 * API, or writes to a customer property.  It only inserts into the local DB's
 * content_deploy_queue table (the Phase 3 handoff).
 *
 * §0 structural check: the gate_status='passed' predicate in queuePassedAssets
 * is the ONLY path to a deploy queue row.  The generator never emits 'passed'
 * except via the runContentGates fold result, so this predicate is the
 * structural off-site/deploy gate.
 *
 * @param contentSetId - The content_set to process.
 * @returns QueueForDeployResult with the count of newly queued rows.
 */
export async function queueForDeploy(
  contentSetId: string
): Promise<QueueForDeployResult> {
  const result = await queuePassedAssets(contentSetId);

  console.info(
    `[queueForDeploy] content_set_id=${contentSetId}: queued ${result.queued} new assets.`
  );

  return {
    queued: result.queued,
    contentSetId,
  };
}

// ---------------------------------------------------------------------------
// Structural §0 enforcement helpers (no HTTP-write verbs exposed below)
// ---------------------------------------------------------------------------

/**
 * Structural assertion: this module exposes NO deploy or publish function.
 *
 * This symbol is a named export that test/gateStatus-queue.test.ts can import
 * to assert the §0 contract: the module namespace contains no deploy/publish
 * verb beyond the queue operation.
 *
 * All callers of queueForDeploy receive only content_deploy_queue rows with
 * status='queued'.  Phase 3 owns the transition from 'queued' → published.
 */
export const NO_HTTP_WRITE_VERB = true as const;

/**
 * Returns true if an asset is eligible for queueing.
 *
 * PURE predicate function: gate_status must be 'passed'.
 * Blocked and needs_human assets return false (structurally excluded).
 *
 * This function is exported for test assertions and CLI display; the actual
 * DB-level filtering is done by queuePassedAssets() in repo.ts.
 */
export function isQueueEligible(gateStatus: string): boolean {
  return gateStatus === "passed";
}
