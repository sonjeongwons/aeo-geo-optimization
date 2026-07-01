/**
 * src/scheduler/jobs.ts
 *
 * Canonical job names and typed payload shapes for the AEO/GEO scheduler.
 *
 * Design (DESIGN.md §5.6 / §9 / T12):
 * - Three job types drive the pipeline:
 *     1. cycle.plan   — triggered by the weekly cron; creates a run + work-units
 *     2. response.run — one job per work-unit; fan-out from cycle.plan
 *     3. cycle.aggregate — triggered after all work-units for a run are done
 * - Payloads are plain objects (serialised to JSON by pg-boss).
 * - Zod is used for runtime validation when handlers receive job data.
 * - Error classification governs retry vs dead-letter behaviour:
 *     RATE_LIMITED / TIMEOUT → retryable (exponential back-off)
 *     NOT_CONFIGURED          → dead-letter cell (do NOT retry)
 *     PROVIDER_ERROR          → dead-letter cell (non-retryable provider fault)
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Job names (canonical strings — referenced by both scheduler and workers)
// ---------------------------------------------------------------------------

export const JOB_NAMES = {
  CYCLE_PLAN: 'cycle.plan',
  RESPONSE_RUN: 'response.run',
  CYCLE_AGGREGATE: 'cycle.aggregate',
  // Phase 3 — deploy connector layer
  PUBLISH_DISPATCH: 'publish.dispatch',
  PUBLISH_UNIT: 'publish.unit',
  PUBLISH_VERIFY: 'publish.verify',
  // Phase 5 — weekly report delivery
  REPORT_DELIVER: 'report.deliver',
  // Phase 5 — monthly billing close (1st of month cron)
  BILLING_CLOSE: 'billing.close',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

// ---------------------------------------------------------------------------
// Payload schemas (Zod)
// ---------------------------------------------------------------------------

/**
 * cycle.plan — triggers the plan phase for one customer run.
 *
 * Emitted by:
 *  - The weekly pg-boss cron (operating cycle)
 *  - Boot catch-up logic (missed weekly window)
 *  - POST /diagnose (baseline, kind='baseline')
 */
export const CyclePlanPayloadSchema = z.object({
  /** Customer ID (UUID). */
  customerId: z.string().uuid(),
  /** 'baseline' for on-demand diagnosis; 'operating' for weekly scheduled run. */
  kind: z.enum(['baseline', 'operating']),
});

export type CyclePlanPayload = z.infer<typeof CyclePlanPayloadSchema>;

/**
 * response.run — one work-unit execution.
 *
 * Emitted by: cycle.plan handler (fan-out, one job per work-unit).
 * Consumed by: the response.run worker which calls runResponse().
 */
export const ResponseRunPayloadSchema = z.object({
  /** Run ID (UUID). */
  runId: z.string().uuid(),
  /** Customer ID (UUID). */
  customerId: z.string().uuid(),
  /** Question ID (UUID). */
  questionId: z.string().uuid(),
  /** Model ID string, e.g. "gemini-2.5-flash-lite". */
  modelId: z.string().min(1),
  /** ISO 639 language code, e.g. "en", "ja", "ko". */
  language: z.string().min(2),
  /** 0-based sample index within this run. */
  sampleIdx: z.number().int().min(0),
  /** SHA-256 hex hash of the canonical prompt (excludes sample_idx — see §5.3). */
  requestHash: z.string().min(1),
  /** Prompt text sent to the provider. */
  prompt: z.string().min(1),
  /** Semver-style prompt version tag, e.g. "v1". */
  promptVersion: z.string().min(1),
  /** Sampling temperature (default 0.7 per §5.3). */
  temperature: z.number().min(0).max(2),
});

export type ResponseRunPayload = z.infer<typeof ResponseRunPayloadSchema>;

/**
 * cycle.aggregate — triggers metrics aggregation after all work-units finish.
 *
 * Emitted by: the last response.run job (or a poll-based completion detector).
 * Consumed by: the cycle.aggregate worker which calls aggregate() + assembleReport().
 */
export const CycleAggregatePayloadSchema = z.object({
  /** Run ID (UUID). */
  runId: z.string().uuid(),
  /** Customer ID (UUID). */
  customerId: z.string().uuid(),
});

export type CycleAggregatePayload = z.infer<typeof CycleAggregatePayloadSchema>;

/**
 * report.deliver — persist an immutable report_snapshot and send a weekly email.
 *
 * Emitted by: cycle.aggregate handler (after a successful operating-run aggregate).
 *             Also enqueued by boot catch-up for completed operating runs that
 *             lack a report_snapshot.
 *
 * Baseline runs do NOT emit this job (kind='baseline').
 *
 * singletonKey = `report:${runId}` (deduplicates across aggregate retries).
 */
export const ReportDeliverPayloadSchema = z.object({
  /** Run ID (UUID). */
  runId: z.string().uuid(),
  /** Customer ID (UUID). */
  customerId: z.string().uuid(),
});

export type ReportDeliverPayload = z.infer<typeof ReportDeliverPayloadSchema>;

// ---------------------------------------------------------------------------
// Error classification (governs retry / dead-letter)
// ---------------------------------------------------------------------------

/**
 * Error codes that map to retryable failures (back-off + retry).
 * The worker throws a RetryableJobError with one of these codes.
 */
export const RETRYABLE_ERROR_CODES = ['RATE_LIMITED', 'TIMEOUT', 'TRANSIENT'] as const;
export type RetryableErrorCode = (typeof RETRYABLE_ERROR_CODES)[number];

/**
 * Error codes that map to permanent failures (dead-letter the work-unit).
 * The worker catches these and marks the work-unit 'error' without retrying.
 */
export const DEAD_LETTER_ERROR_CODES = ['NOT_CONFIGURED', 'PROVIDER_ERROR'] as const;
export type DeadLetterErrorCode = (typeof DEAD_LETTER_ERROR_CODES)[number];

/**
 * Thrown inside a job handler to signal a retryable failure.
 * pg-boss sees a rejected promise and retries with exponential back-off.
 */
export class RetryableJobError extends Error {
  constructor(
    public readonly code: RetryableErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RetryableJobError';
  }
}

/**
 * Thrown (or returned as a handled path) to signal a permanent failure.
 * The handler catches these, marks the work-unit 'error', and resolves
 * (not rejects) so pg-boss does NOT retry.
 */
export class PermanentJobError extends Error {
  constructor(
    public readonly code: DeadLetterErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

// ---------------------------------------------------------------------------
// Dead-letter queue names
// ---------------------------------------------------------------------------

/** Dead-letter queue for permanently-failed work-unit jobs. */
export const DLQ_RESPONSE_RUN = 'response.run.dlq';

/** Dead-letter queue for permanently-failed aggregate jobs. */
export const DLQ_CYCLE_AGGREGATE = 'cycle.aggregate.dlq';

/** Dead-letter queue for permanently-failed report.deliver jobs. */
export const DLQ_REPORT_DELIVER = 'report.deliver.dlq';

// ---------------------------------------------------------------------------
// Phase 3 — Deploy connector layer
// ---------------------------------------------------------------------------

/**
 * Dead-letter queue for permanently-failed publish.unit jobs.
 * NOT_CONFIGURED stub channels are filtered at dispatch and never enqueued,
 * so DLQ entries here represent genuine connector failures or eligibility
 * violations that survived the eligibility/disclosure gates.
 */
export const DLQ_PUBLISH_UNIT = 'publish.unit.dlq';

/**
 * Dead-letter queue for permanently-failed publish.verify jobs.
 * Retries exhaust cap → settled as 'unknown'; only hard unrecoverable errors land here.
 */
export const DLQ_PUBLISH_VERIFY = 'publish.verify.dlq';

// ---------------------------------------------------------------------------
// Channel class literal — the 6-value content_asset channel_class enum.
// Mirrors the content_asset CHECK constraint (migration 0009/0010).
// community/review are structurally absent (§7#3).
// ---------------------------------------------------------------------------

/**
 * The six deploy channel classes supported by Phase 3.
 * Matches the content_asset channel_class CHECK IN (...) exactly.
 */
export const CHANNEL_CLASSES = [
  'owned_net',
  'pr_wire',
  'directory',
  'web2',
  'social',
  'entity',
] as const;

export type ChannelClass = (typeof CHANNEL_CLASSES)[number];

// ---------------------------------------------------------------------------
// Phase 3 payload schemas (Zod)
// ---------------------------------------------------------------------------

/**
 * publish.dispatch — manual or cron-triggered dispatcher.
 *
 * Emitted by:
 *  - The daily pg-boss cron (publish.dispatch schedule)
 *  - publishContent CLI (manual trigger, --execute flips dryRun)
 *
 * channelClass is optional: when absent, dispatch fans out to ALL ready channels.
 */
export const PublishDispatchPayloadSchema = z.object({
  /** Restrict dispatch to a single channel class. Omit to dispatch all ready channels. */
  channelClass: z.enum(CHANNEL_CLASSES).optional(),
  /**
   * When true (default), connectors run in dry-run mode — no real writes,
   * no throttle budget consumed. Must be explicitly false for real publishes.
   */
  dryRun: z.boolean().default(true),
});

export type PublishDispatchPayload = z.infer<typeof PublishDispatchPayloadSchema>;

/**
 * publish.unit — one publish attempt for a single queue row.
 *
 * Emitted by: publish.dispatch handler (fan-out, one job per claimed queue row).
 * Consumed by: the publish.unit worker (src/deploy/publishUnit.ts).
 *
 * singletonKey = `publish:${assetId}:${channelClass}` (set by dispatch, not in payload).
 */
export const PublishUnitPayloadSchema = z.object({
  /** content_deploy_queue row id (UUID). */
  queueId: z.string().uuid(),
  /** content_asset id (UUID). */
  assetId: z.string().uuid(),
  /** Target channel class. */
  channelClass: z.enum(CHANNEL_CLASSES),
  /**
   * Dry-run flag inherited from the dispatch payload.
   * true = no real writes, no throttle budget consumed.
   */
  dryRun: z.boolean().default(true),
});

export type PublishUnitPayload = z.infer<typeof PublishUnitPayloadSchema>;

/**
 * publish.verify — indexing confirmation for a published url_registry row.
 *
 * Emitted by: publish.unit handler (on PublishOk, delayed + backoff).
 * Consumed by: the publish.verify worker (src/deploy/verifyIndexing.ts).
 */
export const PublishVerifyPayloadSchema = z.object({
  /** url_registry row id (UUID). */
  urlRegistryId: z.string().uuid(),
});

export type PublishVerifyPayload = z.infer<typeof PublishVerifyPayloadSchema>;

// ---------------------------------------------------------------------------
// Phase 5 — Billing close (monthly cron, 1st of month)
// ---------------------------------------------------------------------------

/**
 * Dead-letter queue for permanently-failed billing.close jobs.
 * Failures are ops alerts — manual reconciliation is the fallback.
 */
export const DLQ_BILLING_CLOSE = 'billing.close.dlq';

/**
 * billing.close — monthly billing period close for all customers.
 *
 * Emitted by: the monthly pg-boss cron (1st of each month at 03:00 UTC).
 * Consumed by: the billing.close worker in worker.ts.
 *
 * The payload is empty — the handler determines the prior month window itself
 * (billing.close always processes the prior full calendar month, not a range
 * passed in the payload, to prevent accidental double-billing on re-runs).
 *
 * fxRateKrwPerUsd is supplied at runtime from the environment, not persisted in
 * the job payload (so a rate correction can be applied without requeuing).
 */
export const BillingClosePayloadSchema = z.object({
  /**
   * Optional: override the billing month as YYYY-MM (e.g. "2026-06").
   * When absent, the handler closes the prior calendar month.
   * Provided for manual re-runs / ops recovery — NOT set by the cron.
   */
  monthOverride: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export type BillingClosePayload = z.infer<typeof BillingClosePayloadSchema>;
