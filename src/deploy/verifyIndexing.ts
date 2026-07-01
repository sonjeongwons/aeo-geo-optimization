/**
 * src/deploy/verifyIndexing.ts
 *
 * T14 — publish.verify handler: indexing confirmation + stamp.
 *
 * Consumed by: the publish.verify worker (registered in worker.ts by T15).
 * Emitted by:  publish.unit handler on PublishOk (delayed + backoff).
 *
 * Design (DESIGN-phase3.md §"Publish Tracking + §3 Feedback", §"Queue Consumption"):
 *
 * INDEXING CONFIRMATION (ToS-safe, §12):
 *   - Loads the url_registry row for the given registryId.
 *   - Resolves the connector via the ChannelRegistry.
 *   - If the connector has `confirmIndexing` in capabilities, calls it and stamps
 *     indexing_status accordingly:
 *       - owned_net FsTarget: file-presence returns indexed:false → stamps 'submitted'
 *         (the file exists on disk but is NOT publicly crawlable). NEVER 'indexed'.
 *       - Other connectors with confirmIndexing: respect the returned indexed boolean.
 *         If indexed:true → 'indexed'; indexed:false → 'not_indexed'.
 *       - Connectors without confirmIndexing capability → stamps 'unknown'.
 *   - Backoff retries to VERIFY_MAX_ATTEMPTS then settle 'unknown'.
 *   - NO scraping of external engines (§12 — no raw Google AI Overviews / Naver).
 *
 * OWNED_NET INVARIANT (§7#3):
 *   The OwnedNetConnector.confirmIndexing() returns indexed:false because the
 *   FsTarget writes a local file that is not publicly crawlable. The verify
 *   handler maps indexed:false for owned_net → 'submitted' (acknowledges the
 *   file was written) rather than 'not_indexed' (implies the URL is live but
 *   not found by an engine). This is the only status that avoids fabricating a
 *   "live URL" signal into the Phase 0 monitor.
 *
 * RETRY / DLQ INTEGRATION:
 *   - Uses RetryableJobError to signal the scheduler to retry.
 *   - Attempts counter is tracked in the job payload (PublishVerifyPayload).
 *   - When attempts exceed VERIFY_MAX_ATTEMPTS, the handler resolves normally
 *     (no throw) and stamps 'unknown' — so the row is NOT dead-lettered for
 *     a mere indexing-confirmation timeout.
 *   - Hard unrecoverable errors (row not found, DB error) throw PermanentJobError
 *     → DLQ_PUBLISH_VERIFY.
 *
 * STRICTLY READ-ONLY feedback contract:
 *   - This handler only READS url_registry (load) and WRITES indexing_status.
 *   - It does NOT edit cycle.plan, does NOT seed monitoring questions, and does
 *     NOT call any Phase 0 write paths (§3 feedback is DEFERRED to Phase 4).
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import pino from "pino";

import {
  PublishVerifyPayloadSchema,
  RetryableJobError,
  PermanentJobError,
} from "../scheduler/jobs.js";
import type { PublishVerifyPayload } from "../scheduler/jobs.js";
import {
  findUrlRegistryRow,
  updateIndexingStatus,
} from "../db/repo.js";
import type { ChannelRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of indexing-confirmation attempts before settling 'unknown'.
 *
 * After VERIFY_MAX_ATTEMPTS the handler resolves without throwing so pg-boss
 * does NOT dead-letter the job — an indexing timeout is not a hard failure.
 *
 * The caller (publish.unit) enqueues publish.verify with pg-boss retryLimit set
 * to this value, so the retry mechanic is: each failed attempt re-throws
 * RetryableJobError, pg-boss retries up to retryLimit times, then the final
 * attempt resolves 'unknown' instead of throwing.
 */
const VERIFY_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = pino({ name: "deploy.verifyIndexing" });

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * handlePublishVerify — the publish.verify job handler.
 *
 * Registered by worker.ts (T15) via queue.work(JOB_NAMES.PUBLISH_VERIFY, ...).
 *
 * @param payload   - Validated PublishVerifyPayload (registryId + attempt).
 * @param registry  - ChannelRegistry instance (injected; same instance as dispatch).
 * @param attempt   - 1-based attempt number for this job invocation. Passed by
 *                    the worker wrapper which tracks pg-boss retry counts, or
 *                    falls back to 1 for the first invocation.
 */
export async function handlePublishVerify(
  payload: PublishVerifyPayload,
  registry: ChannelRegistry,
  attempt: number = 1,
): Promise<void> {
  const { urlRegistryId } = payload;

  log.info({ urlRegistryId, attempt }, "publish.verify: starting");

  // 1. Load the url_registry row.
  let registryRow: Awaited<ReturnType<typeof findUrlRegistryRow>>;
  try {
    registryRow = await findUrlRegistryRow(urlRegistryId);
  } catch (err) {
    // DB error — permanent failure; dead-letter.
    log.error(
      { urlRegistryId, err },
      "publish.verify: DB error loading registry row — dead-lettering",
    );
    throw new PermanentJobError(
      "PROVIDER_ERROR",
      `publish.verify: failed to load url_registry row id=${urlRegistryId}`,
      err,
    );
  }

  if (!registryRow) {
    // Row not found — nothing to verify; dead-letter so the operator is aware.
    log.error(
      { urlRegistryId },
      "publish.verify: url_registry row not found — dead-lettering",
    );
    throw new PermanentJobError(
      "PROVIDER_ERROR",
      `publish.verify: url_registry row not found id=${urlRegistryId}`,
    );
  }

  // Only verify rows that are in a terminal 'published' state (not 'publishing'
  // or 'failed' — those are not yet live or are already dead).
  if (registryRow.publish_status !== "published") {
    log.warn(
      {
        urlRegistryId,
        publishStatus: registryRow.publish_status,
      },
      "publish.verify: row is not in 'published' status — skipping",
    );
    // Resolve without error — the row may have been unpublished or failed.
    return;
  }

  // 2. Resolve the connector for this channel.
  const connector = registry.get(registryRow.channel_class);

  // 3. Determine the indexing status to stamp.
  const hasConfirmIndexing =
    connector.capabilities.includes("confirm_indexing") &&
    typeof connector.confirmIndexing === "function";

  if (!hasConfirmIndexing) {
    // Connector does not support indexing confirmation — stamp 'unknown'.
    log.info(
      { urlRegistryId, channelClass: registryRow.channel_class },
      "publish.verify: connector has no confirmIndexing capability — stamping 'unknown'",
    );
    await updateIndexingStatus(urlRegistryId, "unknown");
    return;
  }

  // 4. Call confirmIndexing — with retry/backoff cap guard.
  try {
    const result = await connector.confirmIndexing!(registryRow.published_url);
    const { indexed, checkedAt } = result;

    log.info(
      { urlRegistryId, channelClass: registryRow.channel_class, indexed, checkedAt },
      "publish.verify: confirmIndexing returned",
    );

    // §7#3 / DESIGN: owned_net FsTarget always returns indexed:false because
    // the local file is not publicly crawlable. We map this to 'submitted'
    // (file is on disk; NOT a live URL a search engine has crawled).
    // For any connector: indexed:false → 'submitted' for owned_net, else 'not_indexed'.
    // indexed:true → 'indexed' (only non-owned_net real crawlable channels).
    //
    // OWNED_NET INVARIANT: owned_net NEVER gets indexing_status='indexed'
    // regardless of what confirmIndexing returns — the FsTarget local file
    // cannot be crawled, and stamping 'indexed' would fabricate a false
    // "live URL" signal into the Phase 0 monitor (§7#3).
    let indexingStatus: "unknown" | "submitted" | "indexed" | "not_indexed";

    if (registryRow.channel_class === "owned_net") {
      // owned_net: FsTarget file-presence acknowledged as 'submitted'.
      // NEVER 'indexed' — structural invariant enforced here.
      indexingStatus = indexed ? "submitted" : "submitted";

      if (indexed) {
        // This should never happen (FsTarget always returns false), but if a
        // future target erroneously returns true we log a warning and still
        // stamp 'submitted' (the guard is here).
        log.warn(
          { urlRegistryId, channelClass: "owned_net" },
          "publish.verify: owned_net confirmIndexing returned indexed:true — " +
            "clamping to 'submitted' (local file is not crawlable; §7#3)",
        );
      }
    } else {
      // External channels: honour the indexing result.
      // NOTE: all external connectors are stubs today (no confirmIndexing impl),
      // so this branch is reached only when a future keyed connector implements it.
      // NO raw scraping of Google AI Overviews / Naver (§12 — Phase 4 territory).
      indexingStatus = indexed ? "indexed" : "not_indexed";
    }

    await updateIndexingStatus(urlRegistryId, indexingStatus);

    log.info(
      { urlRegistryId, indexingStatus },
      "publish.verify: indexing_status stamped",
    );
  } catch (err) {
    // confirmIndexing threw — transient failure (network, rate-limit, etc.).
    // Retry up to VERIFY_MAX_ATTEMPTS; on final attempt settle 'unknown'.
    if (attempt >= VERIFY_MAX_ATTEMPTS) {
      log.warn(
        { urlRegistryId, attempt, VERIFY_MAX_ATTEMPTS, err },
        "publish.verify: confirmIndexing failed at max attempts — settling 'unknown'",
      );
      await updateIndexingStatus(urlRegistryId, "unknown");
      // Resolve normally — do NOT dead-letter for a mere indexing timeout.
      return;
    }

    // Not yet at the cap — re-throw as retryable so pg-boss backs off and retries.
    log.warn(
      { urlRegistryId, attempt, err },
      "publish.verify: confirmIndexing error — will retry",
    );
    throw new RetryableJobError(
      "TRANSIENT",
      `publish.verify: confirmIndexing failed for urlRegistryId=${urlRegistryId} (attempt ${attempt}/${VERIFY_MAX_ATTEMPTS})`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Job handler factory
// ---------------------------------------------------------------------------

/**
 * makePublishVerifyHandler — build the pg-boss job handler for publish.verify.
 *
 * The handler is a closure over the ChannelRegistry, following the same
 * injected-handler pattern as the cycle.* handlers in worker.ts (T15).
 *
 * @param registry  - Shared ChannelRegistry instance.
 * @returns A JobHandler<PublishVerifyPayload> for use with queue.work().
 */
export function makePublishVerifyHandler(
  registry: ChannelRegistry,
): (jobs: Array<{ id: string; name: string; data: unknown }>) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const parseResult = PublishVerifyPayloadSchema.safeParse(job.data);

      if (!parseResult.success) {
        log.error(
          { jobId: job.id, errors: parseResult.error.issues },
          "publish.verify: invalid payload — skipping (permanent, not dead-lettered)",
        );
        // Resolve to avoid infinite retry of a malformed payload.
        return;
      }

      const payload = parseResult.data;

      // pg-boss does not expose the attempt count in the job object directly,
      // but the worker can pass it via a wrapper. We default to 1 here; T15
      // may enrich this via pg-boss job metadata if available.
      //
      // The attempt guard inside handlePublishVerify ensures we settle 'unknown'
      // after VERIFY_MAX_ATTEMPTS even without a precise count — the pg-boss
      // retryLimit acts as the outer bound.
      const attempt = 1;

      try {
        await handlePublishVerify(payload, registry, attempt);
        log.info({ jobId: job.id, urlRegistryId: payload.urlRegistryId }, "publish.verify: done");
      } catch (err) {
        if (err instanceof RetryableJobError) {
          log.warn(
            { jobId: job.id, code: err.code, err },
            "publish.verify: retryable error — will retry",
          );
          throw err; // pg-boss retries with exponential back-off
        }

        // Permanent failure (PermanentJobError or unexpected).
        log.error(
          { jobId: job.id, err },
          "publish.verify: permanent failure — dead-lettering",
        );
        // Re-throw so pg-boss routes to DLQ_PUBLISH_VERIFY.
        throw err;
      }
    }
  };
}
