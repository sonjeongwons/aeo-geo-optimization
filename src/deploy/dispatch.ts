/**
 * src/deploy/dispatch.ts
 *
 * T13 — publish.dispatch handler.
 *
 * The dispatcher is the entry point for the deploy pipeline. It is triggered by
 * a durable pg-boss cron (registered in worker.ts by T15) or manually by the
 * publishContent CLI (T16).
 *
 * FLOW (DESIGN-phase3.md §"Queue Consumption"):
 *
 *   1. Reap stale leases: reclaim 'leased' rows whose leased_at < now-DEPLOY_LEASE_TIMEOUT_MS
 *      back to 'queued' so transient worker crashes do not permanently strand rows.
 *
 *   2. For each channel in registry.readiness():
 *      - SKIP channels that are not status:'ready' (stub/not_configured).
 *        Their rows stay 'queued', recoverable when keys arrive.
 *      - Compute remaining throttle budget (non-transactional estimate for batch sizing).
 *      - claimNextDeployBatch: atomic UPDATE ... FOR UPDATE SKIP LOCKED, throttle
 *        check + counter increment + lease all in ONE transaction (§7#5).
 *
 *   3. Enqueue one publish.unit job per claimed row with:
 *        singletonKey = `publish:${assetId}:${channelClass}`
 *        deadLetter  = DLQ_PUBLISH_UNIT
 *      (singletonKey prevents double-enqueue of the same asset+channel pair
 *       if the dispatcher fires twice before a worker picks up the job.)
 *
 *   4. Pass dryRun from the dispatch payload (or env default) through to each
 *      publish.unit job.
 *
 * SAFETY PROPERTIES:
 *   §0  OFF-SITE: the dispatcher never resolves URLs; §0 enforcement lives in
 *       OwnedNetConnector.publish() + publishUnit.ts. Dispatcher only selects
 *       rows and routes to publish.unit.
 *
 *   §7#3 community/review: channel class 'community'/'review' are not in
 *       ChannelClass and are never returned by registry.readiness() — structural
 *       exclusion from the pipeline. The registry deny-default prevents any
 *       escaped string from reaching a real connector.
 *
 *   §7#5 NATURALNESS THROTTLE: claimNextDeployBatch atomically enforces the cap;
 *       the pre-check here is only a non-binding estimate used to avoid claiming
 *       100 rows when 0 budget remains (perf optimisation, not the safety gate).
 *
 *   STUB SKIP: channels with status !== 'ready' are filtered BEFORE the claim
 *       call. Their rows stay 'queued' and are NEVER enqueued — so the DLQ is
 *       never hit by stub channels (no infinite re-claim/re-fail loop).
 *
 *   DRY-RUN: when dryRun=true (default), the dispatch passes through dryRun=true
 *       to each publish.unit job. The claim and throttle counter are still
 *       transactionally incremented by claimNextDeployBatch. Dry-run budget
 *       consumption is intentional for dispatch — the actual connector.publish()
 *       call in publish.unit respects dryRun and does NOT write side effects or
 *       increment url_registry live rows. The counter behaviour here is
 *       deliberately conservative; production should use --execute / DEPLOY_DRY_RUN=false.
 *
 * SPEC §0, §7#3, §7#5, §7#6, §8, §9.
 * DESIGN-phase3.md §"Queue Consumption", §"Naturalness Throttle".
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import pino from 'pino';
import {
  reapStaleLeases,
  claimNextDeployBatchForCustomer,
  readDistinctCustomersWithQueuedRows,
  readThrottlePolicy,
  readThrottleState,
} from '../db/repo.js';
import {
  JOB_NAMES,
  DLQ_PUBLISH_UNIT,
  PublishDispatchPayloadSchema,
  type PublishDispatchPayload,
  type PublishUnitPayload,
} from '../scheduler/jobs.js';
import type { JobQueue } from '../scheduler/queue.js';
import type { ChannelRegistry } from './registry.js';
import { computeRemainingBudget, currentWindowStart } from './throttle.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = pino({ name: 'deploy.dispatch' });

// ---------------------------------------------------------------------------
// Dispatch handler
// ---------------------------------------------------------------------------

/**
 * handlePublishDispatch — the publish.dispatch job handler.
 *
 * Exported as a pure async function so worker.ts (T15) can inject it into the
 * pg-boss work() call. The registry and queue are injected for testability.
 *
 * @param rawPayload - The raw job data (zod-validated before dispatch logic).
 * @param queue      - The JobQueue used to enqueue publish.unit jobs.
 * @param registry   - The ChannelRegistry used to determine which channels are ready.
 */
export async function handlePublishDispatch(
  rawPayload: unknown,
  queue: JobQueue,
  registry: ChannelRegistry,
): Promise<void> {
  // ── 1. Validate payload ───────────────────────────────────────────────────
  const parseResult = PublishDispatchPayloadSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    log.error(
      { errors: parseResult.error.issues },
      'publish.dispatch: invalid payload — aborting',
    );
    // Resolve (don't throw) so pg-boss does not retry a malformed dispatch job.
    return;
  }

  const payload: PublishDispatchPayload = parseResult.data;

  // dryRun from payload overrides env default (payload already applies the zod
  // default of true; the CLI can pass false explicitly).
  const dryRun: boolean = payload.dryRun;

  log.info(
    { channelClass: payload.channelClass ?? 'all', dryRun },
    'publish.dispatch: starting',
  );

  // ── 2. Reap stale leases ─────────────────────────────────────────────────
  try {
    const { reclaimed } = await reapStaleLeases(env.DEPLOY_LEASE_TIMEOUT_MS);
    if (reclaimed > 0) {
      log.info({ reclaimed }, 'publish.dispatch: stale leases reclaimed');
    }
  } catch (err) {
    // Stale-lease reap failure is non-fatal: log and continue dispatch.
    // A stuck lease will be picked up on the next cron tick.
    log.warn({ err }, 'publish.dispatch: stale-lease reap failed — continuing');
  }

  // ── 3. Determine channels to dispatch ────────────────────────────────────
  //
  // registry.readiness() returns only REGISTERED connectors.
  // Filter to 'ready' status — stub/not_configured channels are skipped here;
  // their rows stay 'queued', never enqueued or DLQ'd.
  const allReadiness = registry.readiness();
  const readyChannels = allReadiness.filter((c) => c.status === 'ready');

  // If a specific channelClass was requested, further restrict to that channel.
  const channelsToDispatch = payload.channelClass
    ? readyChannels.filter((c) => c.channelClass === payload.channelClass)
    : readyChannels;

  log.info(
    {
      totalRegistered: allReadiness.length,
      readyCount: readyChannels.length,
      dispatchCount: channelsToDispatch.length,
      dryRun,
    },
    'publish.dispatch: channel readiness evaluated',
  );

  // Log which channels are being skipped (for observability).
  const skippedChannels = allReadiness.filter((c) => c.status !== 'ready');
  for (const ch of skippedChannels) {
    log.debug(
      { channelClass: ch.channelClass, status: ch.status },
      'publish.dispatch: skipping non-ready channel — rows stay queued',
    );
  }

  // ── 4. Per-channel dispatch ───────────────────────────────────────────────
  //
  // THR-02 fix: iterate per-(customer_id, channel_class) so each customer's
  // throttle state row is locked and incremented independently.
  // claimNextDeployBatchForCustomer is used (not claimNextDeployBatch) so that
  // one noisy customer cannot starve another and the COALESCE(customer_id)
  // index key is correctly targeted per customer.
  const now = new Date();
  const windowStart = currentWindowStart(now);

  let totalEnqueued = 0;

  for (const channel of channelsToDispatch) {
    const channelClass = channel.channelClass;

    try {
      // ── 4a. Estimate per-channel global budget (non-binding pre-check) ──
      // This is a NON-BINDING estimate on the NULL-customer bucket used only
      // to skip the entire channel early when there is no global budget at all.
      // The actual per-customer enforcement happens atomically inside each
      // claimNextDeployBatchForCustomer call.
      let globalBudgetEstimate = 0;
      try {
        const [policy, state] = await Promise.all([
          readThrottlePolicy(channelClass),
          readThrottleState(null, channelClass),
        ]);
        globalBudgetEstimate = computeRemainingBudget(policy, state, windowStart);
        log.debug(
          { channelClass, globalBudgetEstimate, dryRun },
          'publish.dispatch: global throttle budget estimated',
        );
      } catch (throttleErr) {
        log.warn(
          { channelClass, err: throttleErr },
          'publish.dispatch: throttle policy/state read failed — skipping channel (fail-closed)',
        );
        // globalBudgetEstimate stays 0 → skip channel.
      }

      if (globalBudgetEstimate === 0) {
        log.info(
          { channelClass },
          'publish.dispatch: no remaining throttle budget — skipping channel',
        );
        continue;
      }

      // ── 4b. Enumerate distinct customers with eligible queued rows ──────
      //
      // THR-02 fix: call claimNextDeployBatchForCustomer per customer so each
      // customer's throttle state row is correctly locked + incremented, rather
      // than using the NULL-bucket claimNextDeployBatch for all customers.
      let customerIds: Array<string | null>;
      try {
        customerIds = await readDistinctCustomersWithQueuedRows(channelClass);
      } catch (err) {
        log.warn(
          { channelClass, err },
          'publish.dispatch: failed to enumerate customers — skipping channel',
        );
        continue;
      }

      if (customerIds.length === 0) {
        log.debug(
          { channelClass },
          'publish.dispatch: no eligible rows to claim',
        );
        continue;
      }

      log.debug(
        { channelClass, customerCount: customerIds.length, dryRun },
        'publish.dispatch: dispatching per customer',
      );

      // ── 4c. Per-customer atomic claim + enqueue ─────────────────────────
      for (const customerId of customerIds) {
        try {
          const claimedRows = await claimNextDeployBatchForCustomer(
            channelClass,
            customerId,
            globalBudgetEstimate, // upper bound; each customer's own cap is enforced inside the tx
            windowStart,
            dryRun,
          );

          if (claimedRows.length === 0) {
            log.debug(
              { channelClass, customerId },
              'publish.dispatch: no eligible rows for customer',
            );
            continue;
          }

          log.info(
            { channelClass, customerId, claimed: claimedRows.length, dryRun },
            'publish.dispatch: rows claimed — enqueuing publish.unit jobs',
          );

          // ── 4d. Enqueue one publish.unit per claimed row ──────────────
          for (const row of claimedRows) {
            const unitPayload: PublishUnitPayload = {
              queueId: row.queue_id,
              assetId: row.asset_id,
              channelClass,
              dryRun,
            };

            // singletonKey prevents double-enqueue of the same asset+channel pair
            // if the dispatcher fires twice before a worker picks up the job.
            const singletonKey = `publish:${row.asset_id}:${channelClass}`;

            const jobId = await queue.enqueue(
              JOB_NAMES.PUBLISH_UNIT,
              unitPayload,
              {
                retryLimit: 3,
                retryBackoff: true,
                retryDelay: 30,
                deadLetter: DLQ_PUBLISH_UNIT,
                singletonKey,
              },
            );

            if (jobId !== null) {
              log.info(
                {
                  jobId,
                  queueId: row.queue_id,
                  assetId: row.asset_id,
                  channelClass,
                  customerId: row.customer_id,
                  dryRun,
                  singletonKey,
                },
                'publish.dispatch: publish.unit job enqueued',
              );
              totalEnqueued++;
            } else {
              // singletonKey blocked the insert — job already queued.
              log.debug(
                {
                  queueId: row.queue_id,
                  assetId: row.asset_id,
                  channelClass,
                  singletonKey,
                },
                'publish.dispatch: singleton blocked enqueue — job already queued for this asset+channel',
              );
            }
          }
        } catch (customerErr) {
          log.error(
            { channelClass, customerId, err: customerErr },
            'publish.dispatch: per-customer dispatch error — continuing to next customer',
          );
        }
      }
    } catch (channelErr) {
      // Per-channel errors are non-fatal for the dispatch loop.
      log.error(
        { channelClass, err: channelErr },
        'publish.dispatch: channel dispatch error — continuing to next channel',
      );
    }
  }

  log.info(
    {
      totalEnqueued,
      channelCount: channelsToDispatch.length,
      dryRun,
    },
    'publish.dispatch: done',
  );
}
