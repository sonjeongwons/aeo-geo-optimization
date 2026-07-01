/**
 * src/scheduler/worker.ts
 *
 * Scheduler worker — registers job handlers, weekly operating cron per active
 * customer, daily publish.dispatch cron, and BOOT CATCH-UP that enqueues any
 * missed operating cycle.
 *
 * Design (DESIGN.md §5.6 / §9 / T12; DESIGN-phase3.md §"Queue Consumption" / T15):
 *
 * ## Job flow
 *   weekly cron → cycle.plan → [fan-out] response.run × N → cycle.aggregate
 *
 * ## Phase 3 deploy job flow
 *   daily cron → publish.dispatch → [fan-out] publish.unit × N → publish.verify
 *
 * ## Per-provider Bottleneck limiter
 *   Gemini calls are bounded by a per-provider Bottleneck instance so we never
 *   burst past the Google RPM limit. The limiter is threaded through to the
 *   pipeline via dependency injection (not hard-imported here).
 *
 * ## Boot catch-up
 *   On every process start, after registering handlers and schedules, we query
 *   each active customer's most recent operating run. If that run is older than
 *   the weekly cadence (CATCH_UP_WINDOW_MS = 7 days + grace), we immediately
 *   enqueue a cycle.plan job so no weekly window is silently skipped. This is
 *   the key advantage of pg-boss over node-cron.
 *
 * ## Error handling
 *   RATE_LIMITED / TIMEOUT → throw RetryableJobError (pg-boss retries with backoff)
 *   NOT_CONFIGURED / PROVIDER_ERROR → catch + resolve (pg-boss does NOT retry;
 *   work-unit is marked 'error' and permanently failed)
 *
 * ## Dependency injection seams
 *   The worker accepts explicit handler callbacks for all job types instead of
 *   hard-importing from pipeline/ or deploy/. This keeps each module independently
 *   testable and lets tests inject doubles.
 */

import Bottleneck from 'bottleneck';
import pino from 'pino';
import { getDb } from '../db/kysely.js';
import {
  JOB_NAMES,
  CyclePlanPayloadSchema,
  ResponseRunPayloadSchema,
  CycleAggregatePayloadSchema,
  PublishDispatchPayloadSchema,
  PublishUnitPayloadSchema,
  PublishVerifyPayloadSchema,
  ReportDeliverPayloadSchema,
  RetryableJobError,
  DLQ_RESPONSE_RUN,
  DLQ_CYCLE_AGGREGATE,
  DLQ_PUBLISH_UNIT,
  DLQ_PUBLISH_VERIFY,
  DLQ_REPORT_DELIVER,
  DLQ_BILLING_CLOSE,
  BillingClosePayloadSchema,
  type CyclePlanPayload,
  type ResponseRunPayload,
  type CycleAggregatePayload,
  type PublishDispatchPayload,
  type PublishUnitPayload,
  type PublishVerifyPayload,
  type ReportDeliverPayload,
  type BillingClosePayload,
} from './jobs.js';
import { type JobQueue, CYCLE_CRON_QUEUE } from './queue.js';
import { env } from '../config/env.js';
import { findReportSnapshotByRunId } from '../db/repo.js';
import { runMonthlyClose, DEFAULT_FX_RATE_KRW_PER_USD } from '../billing/close.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = pino({ name: 'scheduler.worker' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Weekly cadence in milliseconds (7 days).
 * Boot catch-up uses 7 days + 2 hours grace to avoid spurious triggers when
 * the process is restarted shortly after a successful cycle.
 */
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const CATCH_UP_GRACE_MS = 2 * 60 * 60 * 1000; // 2 hours
const CATCH_UP_WINDOW_MS = WEEKLY_MS + CATCH_UP_GRACE_MS;

/**
 * Weekly cron expression (Monday 00:00 UTC).
 * Customers that run on different days can be configured at the schedule level;
 * for Phase 0 all customers share the same day.
 */
const WEEKLY_CRON = '0 0 * * 1'; // Mon 00:00 UTC

/**
 * Daily cron expression for publish.dispatch (02:00 UTC daily).
 * Chosen to be off-peak and after the weekly cycle.plan (Mon 00:00).
 * Overridable via WorkerConfig.publishCronOverride.
 */
export const PUBLISH_DISPATCH_CRON = '0 2 * * *'; // 02:00 UTC daily

// CYCLE_CRON_QUEUE is imported from './queue.js' (defined there to avoid
// circular imports — queue.ts is imported by worker.ts, not the reverse).

// ---------------------------------------------------------------------------
// Per-provider Bottleneck limiters
// ---------------------------------------------------------------------------

/**
 * ProviderLimiter — a map from provider name → Bottleneck instance.
 *
 * Default limits (conservative for Gemini Flash-Lite Tier 1 free quota):
 *   - maxConcurrent: 5 simultaneous requests
 *   - minTime: 200 ms gap between requests (=> ~300 RPM max burst)
 *
 * Production tuning: increase maxConcurrent and reduce minTime when on a paid
 * quota. These are exposed here for easy override via constructor injection.
 */
export interface ProviderLimits {
  maxConcurrent: number;
  /** Minimum milliseconds between jobs (rate limit). */
  minTime: number;
}

export const DEFAULT_PROVIDER_LIMITS: Record<string, ProviderLimits> = {
  gemini: { maxConcurrent: 5, minTime: 200 },
  openai: { maxConcurrent: 5, minTime: 200 },
  anthropic: { maxConcurrent: 5, minTime: 200 },
  perplexity: { maxConcurrent: 3, minTime: 300 },
  grok: { maxConcurrent: 3, minTime: 300 },
  mistral: { maxConcurrent: 3, minTime: 300 },
  deepseek: { maxConcurrent: 3, minTime: 300 },
  'llama-groq': { maxConcurrent: 5, minTime: 200 },
};

// ---------------------------------------------------------------------------
// Per-surfaceId Bottleneck limiters (Phase 4 T16)
// ---------------------------------------------------------------------------

/**
 * Default rate limits for v1-b surface adapters, keyed by SurfaceId.
 *
 * SERP surfaces (googleAio, naverAi) go through an official Search API that
 * has low QPS quotas.  We set conservative limits until real quota tiers are
 * confirmed.
 *
 * Scrape surfaces (copilot, metaAi, line, kakao) are disabled-by-default stubs
 * (no RPA runner today).  Their limits are set conservatively so that when an
 * RPA runner is eventually wired, the scheduler does not burst.
 *
 * All limits below are intentionally conservative (maxConcurrent=1 for SERP;
 * maxConcurrent=2 for scrape) to protect rate quotas until real load testing.
 *
 * SPEC §11: SERP calls are metered via the llm_call ledger; limiters enforce
 * per-surface RPM/concurrency on the scheduler side.
 */
export const DEFAULT_SURFACE_LIMITS: Record<string, ProviderLimits> = {
  // SERP surfaces — official API, low QPS (§12 compliant)
  googleAio:    { maxConcurrent: 1, minTime: 1000 },  // ~60 RPM max (Google CSE free: 100 QPD)
  googleAiMode: { maxConcurrent: 1, minTime: 1000 },  // AI Mode — same conservative SERP limit (NOT_CONFIGURED until armed, W2)
  naverAi:      { maxConcurrent: 1, minTime: 1000 },  // ~60 RPM max (Naver Search API free tier)

  // Scrape surfaces — RPA runner (disabled by default; conservative burst guard)
  copilot:   { maxConcurrent: 2, minTime: 500 },   // ~120 RPM when armed
  metaAi:    { maxConcurrent: 2, minTime: 500 },   // ~120 RPM when armed
  line:      { maxConcurrent: 2, minTime: 500 },   // ~120 RPM when armed (JP/TW/TH markets)
  kakao:     { maxConcurrent: 2, minTime: 500 },   // ~120 RPM when armed (KR market)
};

/**
 * Build one Bottleneck per provider.
 * The limiter is keyed by provider name (lower-cased).
 */
export function buildProviderLimiters(
  overrides: Record<string, ProviderLimits> = {},
): Map<string, Bottleneck> {
  const merged = { ...DEFAULT_PROVIDER_LIMITS, ...overrides };
  const map = new Map<string, Bottleneck>();

  for (const [provider, limits] of Object.entries(merged)) {
    map.set(
      provider,
      new Bottleneck({
        maxConcurrent: limits.maxConcurrent,
        minTime: limits.minTime,
      }),
    );
  }

  return map;
}

/**
 * Build one Bottleneck per v1-b surfaceId.
 *
 * Keyed by the canonical SurfaceId string (e.g. "googleAio", "copilot").
 * These limiters are separate from the provider limiters so each surface can
 * be rate-limited independently of the chat API providers.
 *
 * @param overrides  Per-surfaceId limit overrides (merged on top of defaults).
 * @returns          Map from surfaceId → Bottleneck.
 */
export function buildSurfaceLimiters(
  overrides: Record<string, ProviderLimits> = {},
): Map<string, Bottleneck> {
  const merged = { ...DEFAULT_SURFACE_LIMITS, ...overrides };
  const map = new Map<string, Bottleneck>();

  for (const [surfaceId, limits] of Object.entries(merged)) {
    map.set(
      surfaceId,
      new Bottleneck({
        maxConcurrent: limits.maxConcurrent,
        minTime: limits.minTime,
      }),
    );
  }

  return map;
}

/**
 * Build a unified limiter map containing both per-provider and per-surfaceId
 * Bottleneck instances.
 *
 * The merged map is keyed by:
 *   - provider name for chat/API adapters  (e.g. "gemini", "openai")
 *   - surfaceId for SERP/scrape adapters   (e.g. "googleAio", "copilot")
 *
 * There is NO key collision between providers and surfaceIds because surface
 * IDs use camelCase (e.g. "googleAio") while provider keys are lowercase
 * (e.g. "gemini").  If a future surface ID were to collide with a provider
 * name, the surface entry wins (surfaceLimiters are merged last).
 *
 * @param providerOverrides  Per-provider limit overrides.
 * @param surfaceOverrides   Per-surfaceId limit overrides.
 * @returns                  Unified Map<string, Bottleneck>.
 */
export function buildAllLimiters(
  providerOverrides: Record<string, ProviderLimits> = {},
  surfaceOverrides: Record<string, ProviderLimits> = {},
): Map<string, Bottleneck> {
  const providerLimiters = buildProviderLimiters(providerOverrides);
  const surfaceLimiters = buildSurfaceLimiters(surfaceOverrides);

  // Merge: surface limiters last so they win on key collision.
  const combined = new Map<string, Bottleneck>([
    ...providerLimiters,
    ...surfaceLimiters,
  ]);

  return combined;
}

/**
 * Returns the Bottleneck limiter for a provider, or a permissive fallback.
 */
export function getLimiter(
  limiters: Map<string, Bottleneck>,
  provider: string,
): Bottleneck {
  // Try as-is first (surface IDs are camelCase, e.g. "googleAio", "copilot").
  // Fall back to lower-cased lookup for provider names (e.g. "GEMINI" → "gemini").
  return (
    limiters.get(provider) ??
    limiters.get(provider.toLowerCase()) ??
    new Bottleneck({ maxConcurrent: 3, minTime: 300 })
  );
}

// ---------------------------------------------------------------------------
// Handler type signatures (injected — NOT imported from pipeline/)
// ---------------------------------------------------------------------------

/**
 * Handler for cycle.plan:
 *   Creates a run, builds the plan, snapshots n_total, inserts work-units,
 *   and enqueues one response.run job per work-unit.
 *
 * The implementation lives in src/pipeline/runCycle.ts (T13).
 */
export type CyclePlanHandler = (
  payload: CyclePlanPayload,
  queue: JobQueue,
  limiters: Map<string, Bottleneck>,
) => Promise<void>;

/**
 * Handler for response.run:
 *   Executes one work-unit (budget gate → cache → generate → judge → persist).
 *
 * The implementation lives in src/pipeline/runResponse.ts (T13).
 */
export type ResponseRunHandler = (
  payload: ResponseRunPayload,
  limiters: Map<string, Bottleneck>,
) => Promise<void>;

/**
 * Handler for cycle.aggregate:
 *   Computes metrics and assembles the run report (T11).
 */
export type CycleAggregateHandler = (
  payload: CycleAggregatePayload,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Phase 3 handler type signatures (injected — NOT imported from deploy/)
// ---------------------------------------------------------------------------

/**
 * Handler for publish.dispatch:
 *   Reaps stale leases, computes throttle budget, claims deploy-queue rows for
 *   ready channels, and fans out one publish.unit job per claimed row.
 *
 * The implementation lives in src/deploy/dispatch.ts (T13).
 */
export type PublishDispatchHandler = (
  payload: PublishDispatchPayload,
  queue: JobQueue,
) => Promise<void>;

/**
 * Handler for publish.unit:
 *   Single unit of publish work — eligibility re-check, disclosure gate,
 *   claim-before-publish idempotency, connector.publish(), url_registry write.
 *
 * The implementation lives in src/deploy/publishUnit.ts (T12).
 */
export type PublishUnitHandler = (
  payload: PublishUnitPayload,
  queue: JobQueue,
) => Promise<void>;

/**
 * Handler for publish.verify:
 *   Indexing confirmation — calls connector.confirmIndexing? and stamps
 *   indexing_status on the url_registry row. Backoffs to cap then 'unknown'.
 *
 * The implementation lives in src/deploy/verifyIndexing.ts (T14).
 */
export type PublishVerifyHandler = (
  payload: PublishVerifyPayload,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Phase 5 handler type signatures (injected)
// ---------------------------------------------------------------------------

/**
 * Handler for report.deliver:
 *   Assembles a RunReport, persists an immutable report_snapshot, renders
 *   an HTML email, and sends via the DeliverySink. Exactly-once via
 *   report_delivery UNIQUE(snapshot_id, recipient).
 *
 * The implementation lives in src/report/deliver.ts (P5-T15).
 */
export type ReportDeliverHandler = (
  payload: ReportDeliverPayload,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Worker configuration
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  queue: JobQueue;
  /** Handler implementations injected from pipeline (or test doubles). */
  handlers: {
    cyclePlan: CyclePlanHandler;
    responseRun: ResponseRunHandler;
    cycleAggregate: CycleAggregateHandler;
    // Phase 3 — deploy connector layer handlers (T15)
    publishDispatch: PublishDispatchHandler;
    publishUnit: PublishUnitHandler;
    publishVerify: PublishVerifyHandler;
    // Phase 5 — weekly report delivery (P5-T15)
    reportDeliver?: ReportDeliverHandler;
  };
  /**
   * Per-provider rate limiters. If omitted, defaults are used.
   * Exposed as a parameter so tests and index.ts can share one set of limiters.
   */
  limiters?: Map<string, Bottleneck>;
  /**
   * Override the weekly cron expression (default: Monday 00:00 UTC).
   * Useful for integration testing with short intervals.
   */
  cronOverride?: string;
  /**
   * Override the daily publish.dispatch cron expression (default: 02:00 UTC daily).
   * Useful for integration testing with short intervals.
   */
  publishCronOverride?: string;
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/**
 * Register all job handlers and weekly cron schedules, then run boot catch-up.
 *
 * Call this once from index.ts after `queue.start()`.
 *
 * @returns A function to stop the worker (drains in-flight jobs).
 */
export async function startWorker(config: WorkerConfig): Promise<() => Promise<void>> {
  const { queue, handlers, cronOverride, publishCronOverride } = config;
  // Phase 4 T16: use buildAllLimiters so each v1-b surface gets its own
  // per-surfaceId Bottleneck in addition to the per-provider chat limiters.
  const limiters = config.limiters ?? buildAllLimiters();
  const cron = cronOverride ?? WEEKLY_CRON;
  const publishCron = publishCronOverride ?? PUBLISH_DISPATCH_CRON;

  // 1. Register job handlers ---------------------------------------------------

  // cycle.plan handler
  await queue.work<CyclePlanPayload>(
    JOB_NAMES.CYCLE_PLAN,
    async (jobs) => {
      for (const job of jobs) {
        const parseResult = CyclePlanPayloadSchema.safeParse(job.data);
        if (!parseResult.success) {
          log.error(
            { jobId: job.id, errors: parseResult.error.issues },
            'cycle.plan: invalid payload — dead-lettering',
          );
          // Resolve (don't throw) so pg-boss does not retry this malformed job.
          return;
        }

        log.info(
          { jobId: job.id, customerId: parseResult.data.customerId, kind: parseResult.data.kind },
          'cycle.plan: starting',
        );

        await handlers.cyclePlan(parseResult.data, queue, limiters);

        log.info({ jobId: job.id }, 'cycle.plan: done');
      }
    },
    { batchSize: 1 },
  );

  // response.run handler
  await queue.work<ResponseRunPayload>(
    JOB_NAMES.RESPONSE_RUN,
    async (jobs) => {
      for (const job of jobs) {
        const parseResult = ResponseRunPayloadSchema.safeParse(job.data);
        if (!parseResult.success) {
          log.error(
            { jobId: job.id, errors: parseResult.error.issues },
            'response.run: invalid payload — skipping',
          );
          return;
        }

        const payload = parseResult.data;
        log.debug(
          { jobId: job.id, runId: payload.runId, questionId: payload.questionId },
          'response.run: starting',
        );

        try {
          await handlers.responseRun(payload, limiters);
          log.debug({ jobId: job.id }, 'response.run: done');
        } catch (err) {
          if (err instanceof RetryableJobError) {
            // Re-throw so pg-boss retries with exponential back-off.
            log.warn(
              { jobId: job.id, code: err.code, err },
              'response.run: retryable error — will retry',
            );
            throw err;
          }

          // Permanent failure (NOT_CONFIGURED, PROVIDER_ERROR, or unexpected).
          // Log it, do NOT re-throw — the work-unit is already marked 'error'
          // by the handler; pg-boss completes this job (no retry).
          log.error(
            { jobId: job.id, err },
            'response.run: permanent failure — dead-lettering cell',
          );
        }
      }
    },
    { batchSize: 1 },
  );

  // cycle.aggregate handler
  await queue.work<CycleAggregatePayload>(
    JOB_NAMES.CYCLE_AGGREGATE,
    async (jobs) => {
      for (const job of jobs) {
        const parseResult = CycleAggregatePayloadSchema.safeParse(job.data);
        if (!parseResult.success) {
          log.error(
            { jobId: job.id, errors: parseResult.error.issues },
            'cycle.aggregate: invalid payload — skipping',
          );
          return;
        }

        const payload = parseResult.data;
        log.info(
          { jobId: job.id, runId: payload.runId },
          'cycle.aggregate: starting',
        );

        try {
          await handlers.cycleAggregate(payload);
          log.info({ jobId: job.id }, 'cycle.aggregate: done');

          // Phase 5: after a successful operating-run aggregate, enqueue
          // report.deliver so the weekly snapshot + email can be produced.
          // We check the run kind from the DB to ensure baseline runs are excluded.
          // singletonKey prevents double-enqueue across aggregate retries.
          //
          // NOTE: cycle.aggregate is retryable — this enqueue runs AFTER a
          // COMMITTED aggregate. If the process crashes between aggregate commit
          // and this enqueue, boot catch-up recovers the missed delivery.
          if (handlers.reportDeliver !== undefined) {
            const db = getDb();
            const runRow = await db
              .selectFrom('run')
              .select('kind')
              .where('id', '=', payload.runId)
              .executeTakeFirst();

            if (runRow?.kind === 'operating') {
              const reportPayload: ReportDeliverPayload = {
                runId: payload.runId,
                customerId: payload.customerId,
              };
              await queue.enqueue(JOB_NAMES.REPORT_DELIVER, reportPayload, {
                retryLimit: 3,
                retryBackoff: true,
                retryDelay: 60,
                deadLetter: DLQ_REPORT_DELIVER,
                singletonKey: `report:${payload.runId}`,
              });
              log.info(
                { jobId: job.id, runId: payload.runId },
                'cycle.aggregate: enqueued report.deliver',
              );
            } else {
              log.debug(
                { jobId: job.id, runId: payload.runId, kind: runRow?.kind },
                'cycle.aggregate: baseline run — skipping report.deliver enqueue',
              );
            }
          }
        } catch (err) {
          // Aggregate failures are retried (transient DB errors, etc.).
          log.error({ jobId: job.id, err }, 'cycle.aggregate: error — will retry');
          throw err;
        }
      }
    },
    { batchSize: 1 },
  );

  // ── Phase 3: register publish.dispatch / publish.unit / publish.verify ─────
  //
  // All three follow the same injected-handler pattern as the cycle.* handlers
  // above. The dispatcher cron is registered after the handler (pg-boss v10
  // rule: createQueue → work → schedule).

  // publish.dispatch handler
  await queue.work<PublishDispatchPayload>(
    JOB_NAMES.PUBLISH_DISPATCH,
    async (jobs) => {
      for (const job of jobs) {
        const parseResult = PublishDispatchPayloadSchema.safeParse(job.data);
        if (!parseResult.success) {
          log.error(
            { jobId: job.id, errors: parseResult.error.issues },
            'publish.dispatch: invalid payload — skipping (will not retry)',
          );
          // Resolve (not throw) — malformed dispatch jobs should not retry.
          return;
        }

        const payload = parseResult.data;
        log.info(
          { jobId: job.id, channelClass: payload.channelClass ?? 'all', dryRun: payload.dryRun },
          'publish.dispatch: starting',
        );

        try {
          await handlers.publishDispatch(payload, queue);
          log.info({ jobId: job.id }, 'publish.dispatch: done');
        } catch (err) {
          // Dispatch failures are non-fatal at the cycle level (individual
          // channel errors are caught inside dispatch.ts). Log and resolve.
          log.error({ jobId: job.id, err }, 'publish.dispatch: unexpected error');
        }
      }
    },
    { batchSize: 1 },
  );

  // publish.unit handler
  await queue.work<PublishUnitPayload>(
    JOB_NAMES.PUBLISH_UNIT,
    async (jobs) => {
      for (const job of jobs) {
        const parseResult = PublishUnitPayloadSchema.safeParse(job.data);
        if (!parseResult.success) {
          log.error(
            { jobId: job.id, errors: parseResult.error.issues },
            'publish.unit: invalid payload — skipping (will not retry)',
          );
          // Resolve (not throw) — malformed jobs must not retry.
          return;
        }

        const payload = parseResult.data;
        log.debug(
          { jobId: job.id, queueId: payload.queueId, channelClass: payload.channelClass },
          'publish.unit: starting',
        );

        try {
          await handlers.publishUnit(payload, queue);
          log.debug({ jobId: job.id, queueId: payload.queueId }, 'publish.unit: done');
        } catch (err) {
          if (err instanceof RetryableJobError) {
            // Re-throw so pg-boss retries with exponential back-off.
            log.warn(
              { jobId: job.id, queueId: payload.queueId, code: err.code, err },
              'publish.unit: retryable error — will retry',
            );
            throw err;
          }

          // Unique-violation on url_registry (23505) — idempotent no-op.
          const pgErr = err as { code?: string };
          if (pgErr.code === '23505') {
            log.info(
              { jobId: job.id, queueId: payload.queueId },
              'publish.unit: unique violation on url_registry — no-op (idempotent)',
            );
            continue;
          }

          // Unexpected permanent failure — log and resolve (DLQ via deadLetter option).
          log.error(
            { jobId: job.id, queueId: payload.queueId, err },
            'publish.unit: unexpected error — resolving to avoid infinite retry',
          );
        }
      }
    },
    { batchSize: 1 },
  );

  // publish.verify handler
  await queue.work<PublishVerifyPayload>(
    JOB_NAMES.PUBLISH_VERIFY,
    async (jobs) => {
      for (const job of jobs) {
        const parseResult = PublishVerifyPayloadSchema.safeParse(job.data);
        if (!parseResult.success) {
          log.error(
            { jobId: job.id, errors: parseResult.error.issues },
            'publish.verify: invalid payload — skipping (permanent, not dead-lettered)',
          );
          // Resolve to avoid infinite retry of a malformed payload.
          return;
        }

        const payload = parseResult.data;
        log.debug(
          { jobId: job.id, urlRegistryId: payload.urlRegistryId },
          'publish.verify: starting',
        );

        try {
          await handlers.publishVerify(payload);
          log.info({ jobId: job.id, urlRegistryId: payload.urlRegistryId }, 'publish.verify: done');
        } catch (err) {
          if (err instanceof RetryableJobError) {
            log.warn(
              { jobId: job.id, urlRegistryId: payload.urlRegistryId, code: err.code, err },
              'publish.verify: retryable error — will retry',
            );
            throw err; // pg-boss retries with exponential back-off
          }

          // PermanentJobError or unexpected — re-throw so pg-boss routes to
          // DLQ_PUBLISH_VERIFY (set via deadLetter option on the enqueue call).
          log.error(
            { jobId: job.id, urlRegistryId: payload.urlRegistryId, err },
            'publish.verify: permanent failure — dead-lettering',
          );
          throw err;
        }
      }
    },
    { batchSize: 1 },
  );

  // ── Phase 5: register report.deliver ─────────────────────────────────────────
  //
  // Conditionally registered (requires handlers.reportDeliver to be injected).
  // This keeps the legacy engine test suite unaffected when the handler is absent.

  if (handlers.reportDeliver !== undefined) {
    const reportDeliverHandler = handlers.reportDeliver;

    await queue.work<ReportDeliverPayload>(
      JOB_NAMES.REPORT_DELIVER,
      async (jobs) => {
        for (const job of jobs) {
          const parseResult = ReportDeliverPayloadSchema.safeParse(job.data);
          if (!parseResult.success) {
            log.error(
              { jobId: job.id, errors: parseResult.error.issues },
              'report.deliver: invalid payload — skipping (will not retry)',
            );
            // Resolve (not throw) — malformed jobs must not retry.
            return;
          }

          const payload = parseResult.data;
          log.info(
            { jobId: job.id, runId: payload.runId, customerId: payload.customerId },
            'report.deliver: starting',
          );

          try {
            await reportDeliverHandler(payload);
            log.info({ jobId: job.id, runId: payload.runId }, 'report.deliver: done');
          } catch (err) {
            // Re-throw so pg-boss retries (up to retryLimit) and ultimately
            // dead-letters to DLQ_REPORT_DELIVER.
            log.error(
              { jobId: job.id, runId: payload.runId, err },
              'report.deliver: error — will retry or dead-letter',
            );
            throw err;
          }
        }
      },
      { batchSize: 1 },
    );

    log.info('report.deliver handler registered');
  }

  // Phase 3 publish.dispatch cron — durable daily schedule (idempotent on re-boot).
  //
  // The dispatcher is a single schedule row that fans out to all ready channels.
  // The dryRun flag is read from the validated environment (env.DEPLOY_DRY_RUN),
  // which defaults to true (fail-closed). Set DEPLOY_DRY_RUN=false in production
  // to allow the scheduled cron to perform real publishes; staging/CI never need
  // to change anything — the default keeps all side effects suppressed.
  const publishDispatchPayload: PublishDispatchPayload = {
    dryRun: env.DEPLOY_DRY_RUN,
  };

  await queue.schedule(
    JOB_NAMES.PUBLISH_DISPATCH,
    publishCron,
    publishDispatchPayload,
    {
      tz: 'UTC',
      retryLimit: 3,
      retryBackoff: true,
      retryDelay: 60,
      deadLetter: DLQ_PUBLISH_UNIT,
    },
  );

  log.info({ publishCron }, 'daily publish.dispatch cron registered');

  // ── Phase 5: register billing.close handler + monthly cron ─────────────────
  //
  // The billing.close job runs on the 1st of each month at 03:00 UTC.
  // It closes the prior full calendar month for ALL active customers.
  // The handler reads the FX rate from the module constant (not the payload) so
  // a rate correction is applied without requeuing the job.

  await queue.work<BillingClosePayload>(
    JOB_NAMES.BILLING_CLOSE,
    async (jobs) => {
      for (const job of jobs) {
        const parseResult = BillingClosePayloadSchema.safeParse(job.data ?? {});
        if (!parseResult.success) {
          log.error(
            { jobId: job.id, errors: parseResult.error.issues },
            'billing.close: invalid payload — skipping (will not retry)',
          );
          return;
        }

        const payload = parseResult.data;
        log.info(
          { jobId: job.id, monthOverride: payload.monthOverride ?? 'prior month' },
          'billing.close: starting',
        );

        try {
          await runMonthlyClose(DEFAULT_FX_RATE_KRW_PER_USD);
          log.info({ jobId: job.id }, 'billing.close: done');
        } catch (err) {
          // Billing close failures are retried (transient DB errors, etc.).
          log.error({ jobId: job.id, err }, 'billing.close: error — will retry');
          throw err;
        }
      }
    },
    { batchSize: 1 },
  );

  // Monthly billing.close cron — 1st of each month at 03:00 UTC.
  await queue.schedule(
    JOB_NAMES.BILLING_CLOSE,
    '0 3 1 * *', // 03:00 UTC on the 1st of every month
    {},          // empty payload — handler determines the prior month window
    {
      tz: 'UTC',
      retryLimit: 3,
      retryBackoff: true,
      retryDelay: 120,
      deadLetter: DLQ_BILLING_CLOSE,
    },
  );

  log.info('monthly billing.close cron registered (1st of month, 03:00 UTC)');

  // 2. Register ONE dispatcher cron + handler for the weekly trigger -----------
  //
  // pg-boss's schedule table has PRIMARY KEY(name). If we called queue.schedule()
  // once per customer with name=JOB_NAMES.CYCLE_PLAN, each iteration would
  // overwrite the previous row (ON CONFLICT DO UPDATE) — only the last customer
  // ever fires. singletonKey dedups enqueued jobs, NOT schedule rows.
  //
  // Fix: register a single cron schedule on the CYCLE_CRON_QUEUE dispatcher.
  // Its handler queries all active customers and enqueues a cycle.plan job for
  // each, so N customers => N independent cycle.plan jobs per cron tick, with
  // no schedule-row collision.

  // 2a. Register the dispatcher worker BEFORE scheduling (pg-boss v10 requires
  //     the queue to be created and worked before schedule() is called).
  await queue.work<Record<string, never>>(
    CYCLE_CRON_QUEUE,
    async (_jobs) => {
      // The dispatcher payload is empty (the cron carries no per-customer data).
      const activeCustomers = await findActiveCustomers();
      log.info(
        { count: activeCustomers.length },
        'cycle.cron: dispatching weekly cycle.plan per active customer',
      );

      for (const customer of activeCustomers) {
        const planPayload: CyclePlanPayload = {
          customerId: customer.id,
          kind: 'operating',
        };

        await queue.enqueue(JOB_NAMES.CYCLE_PLAN, planPayload, {
          retryLimit: 3,
          retryBackoff: true,
          retryDelay: 60,
          // singletonKey prevents double-enqueue if a prior cron tick's cycle.plan
          // job is still pending (e.g. very long runs or a lagging worker).
          singletonKey: `operating:${customer.id}`,
        });

        log.info(
          { customerId: customer.id, slug: customer.slug },
          'cycle.cron: enqueued cycle.plan job',
        );
      }
    },
    { batchSize: 1 },
  );

  // 2b. Register the single dispatcher cron schedule (one row for ALL customers).
  await queue.schedule(CYCLE_CRON_QUEUE, cron, {}, {
    tz: 'UTC',
    retryLimit: 3,
    retryBackoff: true,
    retryDelay: 60,
  });

  log.info({ cron }, 'weekly dispatcher cron registered (cycle.cron)');

  // 3. Boot catch-up -----------------------------------------------------------
  // Query active customers here for the catch-up check (the dispatcher handler
  // also calls findActiveCustomers() at cron-fire time, keeping both fresh).

  const customers = await findActiveCustomers();
  log.info({ count: customers.length }, 'running boot catch-up for active customers');

  await runBootCatchUp(customers, queue);

  log.info('scheduler worker started');

  // Return a stop function
  return async () => {
    log.info('scheduler worker stopping');
    await queue.stop();
    log.info('scheduler worker stopped');
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical schedule name for a customer's weekly operating cycle. */
export function buildOperatingScheduleName(customerId: string): string {
  return `${JOB_NAMES.CYCLE_PLAN}.operating.${customerId}`;
}

/**
 * Query all customers from the DB.
 * We need the customer list at bootstrap time before the pipeline is wired;
 * a direct Kysely query is the simplest approach here.
 */
async function findActiveCustomers(): Promise<Array<{ id: string; slug: string }>> {
  const db = getDb();
  return db.selectFrom('customer').select(['id', 'slug']).execute();
}

/**
 * Boot catch-up: for each active customer, check whether the most recent
 * operating run is older than CATCH_UP_WINDOW_MS. If so, enqueue a
 * cycle.plan job immediately so the missed window is recovered.
 *
 * This is the key pg-boss advantage over node-cron: node-cron silently
 * skips a weekly window if the process is down at trigger time, violating
 * the §5.6 weekly data continuity requirement.
 */
async function runBootCatchUp(
  customers: Array<{ id: string; slug: string }>,
  queue: JobQueue,
): Promise<void> {
  if (customers.length === 0) return;

  const db = getDb();
  const now = Date.now();

  for (const customer of customers) {
    try {
      // Find the most recent operating run for this customer.
      const latestRun = await db
        .selectFrom('run')
        .select(['id', 'planned_at', 'status'])
        .where('customer_id', '=', customer.id)
        .where('kind', '=', 'operating')
        .orderBy('planned_at', 'desc')
        .limit(1)
        .executeTakeFirst();

      const needsCatchUp =
        latestRun === undefined ||
        latestRun === null ||
        now - latestRun.planned_at.getTime() > CATCH_UP_WINDOW_MS;

      if (needsCatchUp) {
        const reason =
          latestRun == null
            ? 'no prior operating run found'
            : `last run was ${Math.round((now - latestRun.planned_at.getTime()) / 3600_000)}h ago`;

        log.warn(
          { customerId: customer.id, slug: customer.slug, reason },
          'boot catch-up: enqueueing missed operating cycle',
        );

        const payload: CyclePlanPayload = {
          customerId: customer.id,
          kind: 'operating',
        };

        // Use singletonKey to prevent double-enqueue if multiple workers boot
        // simultaneously (pg-boss deduplicates by singletonKey).
        await queue.enqueue(JOB_NAMES.CYCLE_PLAN, payload, {
          retryLimit: 3,
          retryBackoff: true,
          retryDelay: 60,
          singletonKey: `catch-up:${customer.id}`,
        });

        log.info(
          { customerId: customer.id, slug: customer.slug },
          'boot catch-up: cycle.plan enqueued',
        );
      } else {
        log.debug(
          {
            customerId: customer.id,
            slug: customer.slug,
            lastRunAt: latestRun?.planned_at,
          },
          'boot catch-up: recent run found — no catch-up needed',
        );
      }

      // ── Phase 5 (P5-T15): enqueue report.deliver for any COMPLETED operating
      // run within the last 2 weeks that lacks a report_snapshot. This recovers
      // the case where the aggregate→deliver enqueue was skipped due to a crash
      // or process restart between aggregate commit and enqueue.
      const catchUpSince = new Date(now - WEEKLY_MS * 2);
      const completedRunsRows = await db
        .selectFrom('run')
        .select(['id', 'customer_id'])
        .where('customer_id', '=', customer.id)
        .where('kind', '=', 'operating')
        .where('status', '=', 'completed')
        .where('planned_at', '>=', catchUpSince)
        .execute();

      for (const run of completedRunsRows) {
        try {
          const existingSnapshot = await findReportSnapshotByRunId(run.id);
          if (existingSnapshot !== null) {
            // Already snapshotted — no action needed.
            continue;
          }

          const reportPayload: ReportDeliverPayload = {
            runId: run.id,
            customerId: run.customer_id,
          };

          await queue.enqueue(JOB_NAMES.REPORT_DELIVER, reportPayload, {
            retryLimit: 3,
            retryBackoff: true,
            retryDelay: 60,
            deadLetter: DLQ_REPORT_DELIVER,
            singletonKey: `report:${run.id}`,
          });

          log.info(
            { runId: run.id, customerId: run.customer_id, slug: customer.slug },
            'boot catch-up: enqueued report.deliver for completed run without snapshot',
          );
        } catch (innerErr) {
          // Non-fatal per run — log and continue to next run.
          log.error(
            { runId: run.id, customerId: run.customer_id, innerErr },
            'boot catch-up: error enqueuing report.deliver — skipping run',
          );
        }
      }
    } catch (err) {
      // Do not fail the entire boot if one customer's catch-up fails.
      // The weekly cron will cover it next trigger.
      log.error(
        { customerId: customer.id, slug: customer.slug, err },
        'boot catch-up: error checking customer — skipping',
      );
    }
  }
}
