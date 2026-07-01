/**
 * src/scheduler/queue.ts
 *
 * JobQueue interface + pg-boss implementation.
 *
 * Design (DESIGN.md §5.6 / §9):
 * - JobQueue is a THIN INTERFACE. The pg-boss implementation is the only
 *   concrete class today; a Temporal swap is a seam here.
 * - pg-boss is chosen over node-cron (silently skips missed weekly windows)
 *   and over BullMQ+Redis (2nd SPOF). It gives durable cron, retries/backoff,
 *   dead-letter, and transactional enqueue+cost-debit on the SAME Postgres.
 * - Cron schedules are durable: pg-boss stores them in its internal tables so
 *   process restarts do NOT lose the schedule.
 * - `JobQueue.schedule()` is idempotent — calling it twice with the same name
 *   is safe (pg-boss upserts the schedule row).
 */

import PgBoss from 'pg-boss';
import type { SendOptions, ScheduleOptions, WorkOptions } from 'pg-boss';
import {
  JOB_NAMES,
  DLQ_RESPONSE_RUN,
  DLQ_CYCLE_AGGREGATE,
  DLQ_PUBLISH_UNIT,
  DLQ_PUBLISH_VERIFY,
  DLQ_REPORT_DELIVER,
} from './jobs.js';

// ---------------------------------------------------------------------------
// Dispatcher queue name
// ---------------------------------------------------------------------------

/**
 * Queue name for the single weekly cron dispatcher.
 *
 * pg-boss's schedule table is PRIMARY KEY(name), so we cannot schedule one row
 * per customer (each iteration overwrites the previous). Instead, one schedule
 * row fires on this dispatcher queue; its handler fans out to N cycle.plan jobs.
 *
 * Defined here (in queue.ts) to avoid a circular import: queue.ts is imported
 * by worker.ts, so the constant must live in queue.ts (or jobs.ts), not in
 * worker.ts itself.
 */
export const CYCLE_CRON_QUEUE = 'cycle.cron';

// ---------------------------------------------------------------------------
// JobQueue interface (swap seam)
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  /**
   * Retry limit. Default 3.
   * Set to 0 to dead-letter on first failure without retry.
   */
  retryLimit?: number;
  /** Exponential back-off between retries. Default true. */
  retryBackoff?: boolean;
  /** Initial retry delay in seconds. Default 30. */
  retryDelay?: number;
  /** Optional dead-letter queue name. */
  deadLetter?: string;
  /** Optional singleton key — only one job with this key can be queued at a time. */
  singletonKey?: string;
}

export interface ScheduleJobOptions extends EnqueueOptions {
  /** IANA timezone for the cron expression. Default 'UTC'. */
  tz?: string;
}

/**
 * Handler function type for job workers.
 * Receives the batch of jobs and must return a resolved promise on success or
 * throw/reject on failure (pg-boss will retry or dead-letter accordingly).
 */
export type JobHandler<T extends object = object> = (
  jobs: Array<{ id: string; name: string; data: T }>,
) => Promise<void>;

/**
 * JobQueue — thin interface over pg-boss (or Temporal in Phase 2+).
 *
 * All methods are async. The `start()` / `stop()` lifecycle must be managed
 * by the caller (worker.ts / index.ts).
 */
export interface JobQueue {
  /** Start the underlying queue (connects, migrates internal tables, etc.). */
  start(): Promise<void>;

  /** Gracefully stop the queue (drains in-flight workers). */
  stop(): Promise<void>;

  /**
   * Enqueue a one-shot job. Returns the job id or null if a singleton
   * constraint blocked the insert.
   */
  enqueue<T extends object>(
    name: string,
    data: T,
    opts?: EnqueueOptions,
  ): Promise<string | null>;

  /**
   * Register a durable cron schedule. Idempotent — calling twice with the
   * same name upserts the schedule.
   *
   * @param name   Unique schedule name (= queue name that gets work units)
   * @param cron   Standard 5-field cron expression (UTC by default)
   * @param data   Payload delivered to the handler on each trigger
   * @param opts   Schedule options (tz, retry, etc.)
   */
  schedule<T extends object>(
    name: string,
    cron: string,
    data: T,
    opts?: ScheduleJobOptions,
  ): Promise<void>;

  /**
   * Remove a durable cron schedule.
   */
  unschedule(name: string): Promise<void>;

  /**
   * Register a handler (worker) for a queue. Multiple handlers for the same
   * queue name run concurrently up to the provider's concurrency limit.
   *
   * @param name     Queue name to consume from
   * @param handler  Async function called with a batch of jobs
   * @param opts     Optional fetch / polling options
   */
  work<T extends object>(
    name: string,
    handler: JobHandler<T>,
    opts?: { batchSize?: number; pollingIntervalSeconds?: number },
  ): Promise<void>;

  /**
   * Returns the list of all registered schedules (useful for bootstrap
   * catch-up inspection).
   */
  getSchedules(): Promise<Array<{ name: string; cron: string; data: object }>>;
}

// ---------------------------------------------------------------------------
// PgBossJobQueue — concrete implementation
// ---------------------------------------------------------------------------

/**
 * pg-boss–backed durable job queue.
 *
 * Construction: pass the Postgres DATABASE_URL.
 * The pg-boss library manages its own connection pool internally.
 */
export class PgBossJobQueue implements JobQueue {
  private boss: PgBoss;

  constructor(connectionString: string) {
    this.boss = new PgBoss({
      connectionString,
      // pg-boss runs its own maintenance worker; no extra config needed.
      // Retain completed/failed jobs for 7 days for observability.
      retentionDays: 7,
      // Supervise (monitor state) every 60 seconds.
      monitorStateIntervalSeconds: 60,
    });

    // Surface pg-boss errors via process stderr so they appear in logs.
    this.boss.on('error', (err) => {
      console.error('[pg-boss] internal error', err);
    });
  }

  async start(): Promise<void> {
    await this.boss.start();

    // pg-boss v10 requires every queue to be created before send/work/schedule.
    // createQueue is idempotent — safe to call on every boot.
    const queuesToCreate = [
      CYCLE_CRON_QUEUE,          // dispatcher — must be created before schedule()
      JOB_NAMES.CYCLE_PLAN,
      JOB_NAMES.RESPONSE_RUN,
      JOB_NAMES.CYCLE_AGGREGATE,
      DLQ_RESPONSE_RUN,
      DLQ_CYCLE_AGGREGATE,
      // Phase 3 — deploy connector layer queues (created before work/schedule — v10 rule)
      JOB_NAMES.PUBLISH_DISPATCH,
      JOB_NAMES.PUBLISH_UNIT,
      JOB_NAMES.PUBLISH_VERIFY,
      DLQ_PUBLISH_UNIT,
      DLQ_PUBLISH_VERIFY,
      // Phase 5 — weekly report delivery queue (P5-T15)
      JOB_NAMES.REPORT_DELIVER,
      DLQ_REPORT_DELIVER,
    ];
    for (const name of queuesToCreate) {
      await this.boss.createQueue(name);
    }
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 30_000 });
  }

  async enqueue<T extends object>(
    name: string,
    data: T,
    opts: EnqueueOptions = {},
  ): Promise<string | null> {
    const sendOpts: SendOptions = {
      retryLimit: opts.retryLimit ?? 3,
      retryBackoff: opts.retryBackoff ?? true,
      retryDelay: opts.retryDelay ?? 30,
      ...(opts.deadLetter !== undefined ? { deadLetter: opts.deadLetter } : {}),
      ...(opts.singletonKey !== undefined ? { singletonKey: opts.singletonKey } : {}),
    };

    const id = await this.boss.send(name, data as object, sendOpts);
    return id;
  }

  async schedule<T extends object>(
    name: string,
    cron: string,
    data: T,
    opts: ScheduleJobOptions = {},
  ): Promise<void> {
    const schedOpts: ScheduleOptions = {
      tz: opts.tz ?? 'UTC',
      retryLimit: opts.retryLimit ?? 3,
      retryBackoff: opts.retryBackoff ?? true,
      retryDelay: opts.retryDelay ?? 30,
      ...(opts.deadLetter !== undefined ? { deadLetter: opts.deadLetter } : {}),
      ...(opts.singletonKey !== undefined ? { singletonKey: opts.singletonKey } : {}),
    };

    await this.boss.schedule(name, cron, data as object, schedOpts);
  }

  async unschedule(name: string): Promise<void> {
    await this.boss.unschedule(name);
  }

  async work<T extends object>(
    name: string,
    handler: JobHandler<T>,
    opts: { batchSize?: number; pollingIntervalSeconds?: number } = {},
  ): Promise<void> {
    const workOpts: WorkOptions = {
      batchSize: opts.batchSize ?? 1,
      ...(opts.pollingIntervalSeconds !== undefined
        ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
        : {}),
    };

    await this.boss.work<T>(
      name,
      workOpts,
      (jobs) => handler(jobs as Array<{ id: string; name: string; data: T }>),
    );
  }

  async getSchedules(): Promise<Array<{ name: string; cron: string; data: object }>> {
    const schedules = await this.boss.getSchedules();
    return schedules.map((s) => ({
      name: s.name,
      cron: s.cron,
      data: (s.data ?? {}) as object,
    }));
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Build a JobQueue backed by pg-boss from the DATABASE_URL env var.
 * Exported so index.ts and tests can construct it without importing PgBoss directly.
 */
export function createJobQueue(connectionString: string): JobQueue {
  return new PgBossJobQueue(connectionString);
}
