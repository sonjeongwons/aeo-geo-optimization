/**
 * src/deploy/publishUnit.ts
 *
 * T12 — publish.unit handler core.
 *
 * Implements the publish.unit job handler: the atomic, idempotent, fail-closed
 * unit of publish work for one (queue row, channel) pair.
 *
 * FLOW (DESIGN-phase3.md §"Queue Consumption" / §"Idempotency & Safety"):
 *
 *   1. Zod-validate payload (PublishUnitPayloadSchema).
 *   2. Load asset + queue row (JOIN content_asset ← content_deploy_queue by queueId).
 *   3. Re-derive eligibility (isPublishEligible) — fail-closed; gate_status re-read.
 *   4. Run disclosure gate (assertDisclosure) — fail-closed for external channels.
 *   5. Resolve connector from registry.
 *   6. CLAIM url_registry 'publishing' row (claimUrlRegistry, ON CONFLICT DO NOTHING).
 *      If not winner → resolve as no-op (another worker already published / is publishing).
 *   7. Build PublishRequest (carry disclosure_tag, dryRun, customerId).
 *   8. Call connector.publish(req).
 *   9. Branch on result:
 *      - PublishOk      → markUrlRegistryPublished + markDeployStatus('published')
 *                          + enqueue publish.verify (delayed).
 *      - PublishDryRun  → insertUrlRegistryDryRun + markDeployStatus('queued')
 *                          (dry-run never strands the queue row).
 *      - PublishThrottled → markDeployStatus('queued') + throw RetryableJobError.
 *      - NOT_CONFIGURED → markUrlRegistryFailed + markDeployStatus('queued') + resolve.
 *      - PublishError (retryable) → markUrlRegistryFailed + throw RetryableJobError.
 *      - PublishError (permanent) → markUrlRegistryFailed + markDeployStatus('failed')
 *                                   + resolve (DLQ handled by pg-boss via deadLetter).
 *
 * KEY INVARIANTS:
 *   - CLAIM-BEFORE-SIDE-EFFECT: connector.publish() is called ONLY if THIS worker
 *     won the url_registry claim (rows-affected = 1). Retried jobs that lost the
 *     claim exit as no-ops — no double-publish on irreversible channels.
 *   - Unique violations on url_registry are caught as no-ops (not failures).
 *   - dry_run is NOT a queue status; dry-run releases the lease back to 'queued'.
 *   - NOT_CONFIGURED path resolves without retry (never enqueued by dispatch,
 *     so this is a fallback; resolving avoids an infinite loop).
 *   - Eligibility is re-derived from the DB, not trusted from the job payload.
 *
 * SPEC §0, §7#5, §7#6, §8, §9, §11, §12.
 * DESIGN-phase3.md §"Queue Consumption", §"Idempotency & Safety".
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import pino from 'pino';
import { getDb } from '../db/kysely.js';
import {
  claimUrlRegistry,
  markUrlRegistryPublished,
  markUrlRegistryFailed,
  insertUrlRegistryDryRun,
  markDeployStatus,
} from '../db/repo.js';
import {
  JOB_NAMES,
  DLQ_PUBLISH_UNIT,
  PublishUnitPayloadSchema,
  RetryableJobError,
  type PublishUnitPayload,
  type PublishVerifyPayload,
} from '../scheduler/jobs.js';
import type { JobQueue } from '../scheduler/queue.js';
import { isPublishEligible } from './eligibility.js';
import { assertDisclosure } from './disclosureGate.js';
import type { ChannelRegistry } from './registry.js';
import { NOT_CONFIGURED } from './connector.js';
import type { PublishRequest, ChannelClass } from './connector.js';
import type { ContentBody } from '../content/types.js';
import { assertNotBlocklisted } from './connectors/ownedNet.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = pino({ name: 'deploy.publishUnit' });

// ---------------------------------------------------------------------------
// AssetQueueRow — join result of content_asset + content_deploy_queue
// ---------------------------------------------------------------------------

/**
 * Enriched row loaded by publishUnit from the DB JOIN.
 * Carries all fields needed for eligibility check, disclosure gate,
 * PublishRequest construction, and url_registry claim.
 */
interface AssetQueueRow {
  // content_deploy_queue fields
  queue_id: string;
  queue_status: string;
  approved_by: string | null;
  approved_at: Date | null;
  // content_asset fields
  asset_id: string;
  content_set_id: string;
  customer_id: string | null;
  channel_class: string;
  language: string;
  industry: string;
  phrasing_group_id: string;
  gate_status: string;
  disclosure_tag: string | null;
  body: unknown;
}

// ---------------------------------------------------------------------------
// loadAssetQueueRow — JOIN query
// ---------------------------------------------------------------------------

/**
 * Load the (content_deploy_queue JOIN content_asset) row for a given queueId.
 * Re-reads gate_status from content_asset at execute time (eligibility re-derivation).
 * Returns null when the row is not found (e.g. already deleted).
 */
async function loadAssetQueueRow(queueId: string): Promise<AssetQueueRow | null> {
  const db = getDb();

  const row = await db
    .selectFrom('content_deploy_queue as cdq')
    .innerJoin('content_asset as ca', 'ca.id', 'cdq.asset_id')
    .select([
      'cdq.id as queue_id',
      'cdq.status as queue_status',
      'cdq.approved_by',
      'cdq.approved_at',
      'ca.id as asset_id',
      'ca.content_set_id',
      'ca.customer_id',
      'ca.channel_class',
      'ca.language',
      'ca.industry',
      'ca.phrasing_group_id',
      'ca.gate_status',
      'ca.disclosure_tag',
      'ca.body',
    ])
    .where('cdq.id', '=', queueId)
    .executeTakeFirst();

  return row ?? null;
}

// ---------------------------------------------------------------------------
// publishUnit — the handler core (exported for worker.ts to call)
// ---------------------------------------------------------------------------

/**
 * publishUnit — core logic for a publish.unit job.
 *
 * Designed to be called from the worker.ts job handler (T15). Takes the
 * validated payload + a JobQueue for enqueueing publish.verify.
 *
 * The registry is injected so tests can supply spy connectors without touching
 * the live connector infrastructure.
 *
 * @param payload   Validated PublishUnitPayload.
 * @param queue     JobQueue for enqueueing publish.verify on success.
 * @param registry  ChannelRegistry (injected — built by T15 at startup).
 * @param dryRunOverride When provided, overrides payload.dryRun (used by CLI).
 */
export async function publishUnit(
  payload: PublishUnitPayload,
  queue: JobQueue,
  registry: ChannelRegistry,
  dryRunOverride?: boolean,
): Promise<void> {
  const { queueId, assetId, channelClass, dryRun: payloadDryRun } = payload;
  const dryRun = dryRunOverride !== undefined ? dryRunOverride : payloadDryRun;

  log.info(
    { queueId, assetId, channelClass, dryRun },
    'publish.unit: starting',
  );

  // -------------------------------------------------------------------------
  // 2. Load asset + queue row from DB (re-read at execute time)
  // -------------------------------------------------------------------------

  const row = await loadAssetQueueRow(queueId);
  if (row === null) {
    // Row not found — may have been deleted/cleaned up; resolve as no-op.
    log.warn({ queueId, assetId }, 'publish.unit: queue row not found — no-op');
    return;
  }

  // -------------------------------------------------------------------------
  // 3. Re-derive eligibility (fail-closed)
  // -------------------------------------------------------------------------

  const eligibility = isPublishEligible({
    gateStatus: row.gate_status,
    approvedBy: row.approved_by,
    queueStatus: row.queue_status,
  });

  if (!eligibility.eligible) {
    log.warn(
      { queueId, assetId, channelClass, reason: eligibility.reason, gateStatus: row.gate_status },
      'publish.unit: not eligible — releasing back to queued',
    );
    // Release the lease back to 'queued' so it can be retried after the
    // blocking condition is resolved (e.g. human approves or re-gate passes).
    await markDeployStatus(queueId, 'queued').catch((err) => {
      log.error({ queueId, err }, 'publish.unit: failed to release non-eligible lease');
    });
    return;
  }

  // -------------------------------------------------------------------------
  // 4. Disclosure gate (fail-closed for external channels, §7#6)
  // -------------------------------------------------------------------------

  const disclosureCheck = assertDisclosure(
    channelClass as ChannelClass,
    row.disclosure_tag,
  );

  if (!disclosureCheck.allowed) {
    log.error(
      { queueId, assetId, channelClass, reason: disclosureCheck.reason },
      'publish.unit: disclosure gate failed — marking failed + DLQ',
    );
    // Disclosure violations are permanent — the missing tag must be fixed
    // before any retry can succeed. Mark failed and let DLQ handle it.
    await markDeployStatus(queueId, 'failed').catch((err) => {
      log.error({ queueId, err }, 'publish.unit: failed to mark queue failed after disclosure gate');
    });
    // Resolve (not throw) — pg-boss deadLetter option on the job handles DLQ routing.
    return;
  }

  // -------------------------------------------------------------------------
  // 5. Resolve connector from registry
  // -------------------------------------------------------------------------

  const connector = registry.get(channelClass);

  // -------------------------------------------------------------------------
  // 6. CLAIM the url_registry idempotency slot (BEFORE connector side effect)
  // -------------------------------------------------------------------------

  // Build approver_audit JSON for the claim row.
  const approverAudit = row.approved_by != null
    ? { approved_by: row.approved_by, approved_at: row.approved_at }
    : null;

  // Use a placeholder URL at claim time; updated to the real URL on success.
  const claimPlaceholder = `urn:asset:${assetId}:${channelClass}:claiming`;

  let registryId: string | null = null;

  if (!dryRun) {
    // Only claim the idempotency slot for real publishes.
    // Dry-run rows get a separate insertUrlRegistryDryRun call (not a claim).
    const claimResult = await claimUrlRegistry({
      assetId,
      contentSetId: row.content_set_id,
      customerId: row.customer_id,
      channelClass,
      publishedUrl: claimPlaceholder,
      disclosureTag: row.disclosure_tag,
      language: row.language,
      approverAudit,
    });

    if (!claimResult.claimed) {
      // Another worker already holds the slot (or completed the publish).
      // This is a no-op — the unique-violation is not a failure.
      log.info(
        { queueId, assetId, channelClass },
        'publish.unit: url_registry slot already claimed — no-op (idempotent)',
      );
      return;
    }

    registryId = claimResult.registryId;
  }

  // -------------------------------------------------------------------------
  // 7. Build PublishRequest
  // -------------------------------------------------------------------------

  // Parse the content body from the DB (it comes back as unknown JSONB).
  let body: ContentBody;
  try {
    // The body is already a parsed JS object from Kysely's JSONB handling.
    // We trust the DB value is well-formed (Phase 2 gate enforced the schema).
    body = row.body as ContentBody;
  } catch (err) {
    log.error({ queueId, assetId, err }, 'publish.unit: failed to parse body — marking failed');
    if (registryId != null) {
      await markUrlRegistryFailed(registryId).catch(() => undefined);
    }
    await markDeployStatus(queueId, 'failed').catch(() => undefined);
    return;
  }

  const publishRequest: PublishRequest = {
    assetId,
    channelClass: channelClass as ChannelClass,
    customerId: row.customer_id,
    language: row.language,
    body,
    disclosureTag: row.disclosure_tag,
    dryRun,
    idempotencyKey: assetId,
  };

  // -------------------------------------------------------------------------
  // 8. Call connector.publish()
  // -------------------------------------------------------------------------

  let result;
  try {
    result = await connector.publish(publishRequest);
  } catch (err) {
    // Unexpected throw from connector (should not happen — connectors return
    // error results, not throw; but be defensive).
    log.error({ queueId, assetId, channelClass, err }, 'publish.unit: connector threw unexpectedly');
    if (registryId != null) {
      await markUrlRegistryFailed(registryId).catch(() => undefined);
    }
    // Rethrow as retryable (transient error).
    throw new RetryableJobError('TRANSIENT', `connector.publish() threw: ${String(err)}`, err);
  }

  // -------------------------------------------------------------------------
  // 9. Branch on PublishResult
  // -------------------------------------------------------------------------

  // --- 9a. PublishOk ---
  if (result.ok === true && !('dryRun' in result)) {
    const okResult = result as import('./connector.js').PublishOk;

    // §0 DEFENSE-IN-DEPTH: second-layer blocklist check on the returned publishedUrl.
    // This is the dispatch-level guard required by DESIGN-phase3.md §"Idempotency & Safety"
    // ("§0 OFF-SITE: ... fail-closed CUSTOMER_DOMAIN_BLOCKLIST guard inside the connector
    // AND in publishUnit"). The connector's own guard runs inside connector.publish(); this
    // independent check catches any connector that becomes real without its own guard.
    const blockErr = assertNotBlocklisted(okResult.publishedUrl, env.CUSTOMER_DOMAIN_BLOCKLIST);
    if (blockErr) {
      log.error(
        { queueId, assetId, channelClass, publishedUrl: okResult.publishedUrl, code: blockErr.code },
        'publish.unit: §0 dispatch-level blocklist guard fired on publishedUrl — rolling back; marking failed + DLQ',
      );
      // Roll back: mark the url_registry claim 'failed' so the partial-unique slot
      // is released (failed rows are excluded from the idempotency arbiter) and the
      // incident is recorded.
      if (registryId != null) {
        await markUrlRegistryFailed(registryId).catch((err) => {
          log.error({ registryId, err }, 'publish.unit: failed to mark registry failed after blocklist hit');
        });
      }
      // Mark queue row 'failed' — permanent violation; DLQ via pg-boss deadLetter.
      await markDeployStatus(queueId, 'failed').catch((err) => {
        log.error({ queueId, err }, 'publish.unit: failed to mark queue failed after blocklist hit');
      });
      // Resolve (not throw) — permanent failure; pg-boss deadLetter handles DLQ routing.
      return;
    }

    log.info(
      { queueId, assetId, channelClass, publishedUrl: okResult.publishedUrl },
      'publish.unit: published successfully',
    );

    // Update url_registry to 'published' with the real URL.
    if (registryId != null) {
      await markUrlRegistryPublished({
        registryId,
        publishedUrl: okResult.publishedUrl,
        externalRef: okResult.externalRef ?? null,
        publishMeta: okResult.meta ?? null,
      }).catch((err) => {
        log.error({ registryId, err }, 'publish.unit: failed to mark registry published');
      });
    }

    // Transition queue row to 'published'.
    await markDeployStatus(queueId, 'published').catch((err) => {
      log.error({ queueId, err }, 'publish.unit: failed to mark queue published');
    });

    // Enqueue publish.verify (delayed so indexing has time to propagate).
    if (registryId != null) {
      const verifyPayload: PublishVerifyPayload = { urlRegistryId: registryId };
      await queue.enqueue(JOB_NAMES.PUBLISH_VERIFY, verifyPayload, {
        retryLimit: 5,
        retryBackoff: true,
        retryDelay: 300, // 5 minutes initial delay
        deadLetter: DLQ_PUBLISH_UNIT,
        // Singleton: at most one verify job per registry row outstanding.
        singletonKey: `verify:${registryId}`,
      }).catch((err) => {
        // Non-fatal: verify jobs are best-effort; the registry row is already published.
        log.warn({ registryId, err }, 'publish.unit: failed to enqueue publish.verify (non-fatal)');
      });
    }

    return;
  }

  // --- 9b. PublishDryRun ---
  if (result.ok === true && 'dryRun' in result && result.dryRun === true) {
    const dryResult = result as import('./connector.js').PublishDryRun;

    log.info(
      { queueId, assetId, channelClass, plannedUrl: dryResult.plannedUrl },
      'publish.unit: dry-run — no real write; releasing queue row back to queued',
    );

    // Insert a dry_run registry row (excluded from idempotency arbiter + throttle).
    await insertUrlRegistryDryRun({
      assetId,
      contentSetId: row.content_set_id,
      customerId: row.customer_id,
      channelClass,
      plannedUrl: dryResult.plannedUrl,
      disclosureTag: row.disclosure_tag,
      language: row.language,
      approverAudit,
    }).catch((err) => {
      log.warn({ queueId, assetId, err }, 'publish.unit: failed to insert dry-run registry row (non-fatal)');
    });

    // Release the lease back to 'queued' — dry-run NEVER strands a queue row.
    await markDeployStatus(queueId, 'queued').catch((err) => {
      log.error({ queueId, err }, 'publish.unit: failed to release dry-run lease back to queued');
    });

    return;
  }

  // --- 9c. PublishNotConfigured (NOT_CONFIGURED) ---
  if (result.ok === false && result.code === NOT_CONFIGURED) {
    log.info(
      { queueId, assetId, channelClass },
      'publish.unit: connector NOT_CONFIGURED — release queue, resolve without retry',
    );
    // Mark the registry row failed (if claimed — normally not, since dispatch
    // skips stub channels; but be safe in case this path is reached in tests).
    if (registryId != null) {
      await markUrlRegistryFailed(registryId).catch(() => undefined);
    }
    // Release queue back to 'queued' (stub channels stay 'queued' recoverable
    // when keys arrive — NOT marked 'failed').
    await markDeployStatus(queueId, 'queued').catch((err) => {
      log.error({ queueId, err }, 'publish.unit: failed to release NOT_CONFIGURED lease');
    });
    // Resolve (not throw) — no DLQ loop for NOT_CONFIGURED.
    return;
  }

  // --- 9d. PublishThrottled ---
  if (result.ok === false && result.code === 'THROTTLED') {
    const throttledResult = result as import('./connector.js').PublishThrottled;

    log.info(
      { queueId, assetId, channelClass, retryAfterMs: throttledResult.retryAfterMs },
      'publish.unit: throttled — re-queuing with delay',
    );

    // Re-queue to 'queued' for the next dispatch cycle.
    await markDeployStatus(queueId, 'queued').catch((err) => {
      log.error({ queueId, err }, 'publish.unit: failed to release throttled lease');
    });

    // Note: registryId won't be set here since we only claim for real publishes
    // and the throttle code could not have been returned if dryRun was true.
    // No registry row to clean up.

    // Throw RetryableJobError so pg-boss retries with backoff.
    throw new RetryableJobError(
      'TRANSIENT',
      `publish.unit throttled for ${channelClass}; retryAfterMs=${throttledResult.retryAfterMs}`,
    );
  }

  // --- 9e. PublishError (permanent or retryable) ---
  if (result.ok === false) {
    const errResult = result as import('./connector.js').PublishError;

    if (errResult.retryable) {
      log.warn(
        { queueId, assetId, channelClass, code: errResult.code, message: errResult.message },
        'publish.unit: retryable error — retrying',
      );
      // Mark registry failed (will be re-claimed on retry since 'failed' rows
      // are excluded from the idempotency arbiter partial unique).
      if (registryId != null) {
        await markUrlRegistryFailed(registryId).catch(() => undefined);
      }
      // Re-queue to 'queued' for retry via pg-boss backoff.
      await markDeployStatus(queueId, 'queued').catch(() => undefined);
      throw new RetryableJobError(
        'TRANSIENT',
        `publish.unit: connector returned retryable error: ${errResult.code}: ${errResult.message}`,
      );
    } else {
      log.error(
        { queueId, assetId, channelClass, code: errResult.code, message: errResult.message },
        'publish.unit: permanent error — marking failed',
      );
      if (registryId != null) {
        await markUrlRegistryFailed(registryId).catch(() => undefined);
      }
      await markDeployStatus(queueId, 'failed').catch(() => undefined);
      // Resolve (not throw) — permanent failure; pg-boss deadLetter handles DLQ routing.
      return;
    }
  }

  // --- Unreachable: unknown result shape ---
  log.error(
    { queueId, assetId, channelClass, result },
    'publish.unit: unrecognized PublishResult shape — marking failed',
  );
  if (registryId != null) {
    await markUrlRegistryFailed(registryId).catch(() => undefined);
  }
  await markDeployStatus(queueId, 'failed').catch(() => undefined);
}

// ---------------------------------------------------------------------------
// createPublishUnitHandler — factory for the pg-boss job handler
// ---------------------------------------------------------------------------

/**
 * createPublishUnitHandler — build the pg-boss job handler function for
 * publish.unit jobs.
 *
 * The returned handler is injected into worker.ts (T15) via the handlers
 * config object. The registry and queue are injected so the handler is
 * testable without live infrastructure.
 *
 * Unique-violation errors from claimUrlRegistry are caught as no-ops here
 * (the underlying claimUrlRegistry already catches '23505'; this is an
 * additional outer safety net for unexpected pg errors).
 *
 * @param registry  ChannelRegistry (built at startup by buildConnectorRegistry).
 * @param queue     JobQueue for enqueueing publish.verify on success.
 */
export function createPublishUnitHandler(
  registry: ChannelRegistry,
  queue: JobQueue,
) {
  return async (jobs: Array<{ id: string; name: string; data: object }>): Promise<void> => {
    for (const job of jobs) {
      // 1. Validate payload.
      const parseResult = PublishUnitPayloadSchema.safeParse(job.data);
      if (!parseResult.success) {
        log.error(
          { jobId: job.id, errors: parseResult.error.issues },
          'publish.unit: invalid payload — skipping (will not retry)',
        );
        // Resolve (not throw) — malformed jobs should not retry.
        continue;
      }

      const payload = parseResult.data;

      try {
        await publishUnit(payload, queue, registry);
        log.debug({ jobId: job.id, queueId: payload.queueId }, 'publish.unit: done');
      } catch (err) {
        if (err instanceof RetryableJobError) {
          log.warn(
            { jobId: job.id, queueId: payload.queueId, code: err.code },
            'publish.unit: retryable error — pg-boss will retry',
          );
          throw err;
        }

        // Unique violation on url_registry — treat as no-op (not a failure).
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          log.info(
            { jobId: job.id, queueId: payload.queueId },
            'publish.unit: unique violation on url_registry — no-op (idempotent)',
          );
          continue;
        }

        // Unexpected error — log and resolve to avoid DLQ on transient DB issues.
        log.error(
          { jobId: job.id, queueId: payload.queueId, err },
          'publish.unit: unexpected error — resolving (no retry)',
        );
      }
    }
  };
}
