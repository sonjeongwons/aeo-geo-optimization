/**
 * test/deploy/cron-env-dryrun.test.ts
 *
 * IDEMP-03 / IT-03 regression test:
 *
 *   1. env.ts — DEPLOY_DRY_RUN parsing must NOT use z.coerce.boolean():
 *      the string 'false' must yield boolean false (z.coerce.boolean() treats
 *      every non-empty string as true, making it impossible to disable dry-run
 *      via environment variable).
 *
 *   2. worker.ts — the durable publish.dispatch cron payload must derive
 *      dryRun from env.DEPLOY_DRY_RUN rather than hardcoding true, so an
 *      operator who sets DEPLOY_DRY_RUN=false actually gets a real publish.
 *
 * Strategy:
 *   • For (1): parse the exported envSchema directly with controlled inputs —
 *     no process.env mutation required; the singleton is not touched.
 *   • For (2): mock the env module so env.DEPLOY_DRY_RUN=false, call
 *     startWorker with a mock queue, and assert the publish.dispatch schedule
 *     call received dryRun:false in its data payload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Part 1 — schema unit tests (no process.env mutation)
// ---------------------------------------------------------------------------

import { envSchema } from '../../src/config/env.js';

describe('env.ts DEPLOY_DRY_RUN schema parsing', () => {
  const BASE_ENV = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb',
  };

  it("DEPLOY_DRY_RUN='false' parses to boolean false", () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      DEPLOY_DRY_RUN: 'false',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.DEPLOY_DRY_RUN).toBe(false);
      expect(typeof result.data.DEPLOY_DRY_RUN).toBe('boolean');
    }
  });

  it("DEPLOY_DRY_RUN='true' parses to boolean true", () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      DEPLOY_DRY_RUN: 'true',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.DEPLOY_DRY_RUN).toBe(true);
    }
  });

  it('DEPLOY_DRY_RUN absent defaults to boolean true (fail-closed)', () => {
    const result = envSchema.safeParse({ ...BASE_ENV });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.DEPLOY_DRY_RUN).toBe(true);
    }
  });

  it("DEPLOY_DRY_RUN='FALSE' (wrong case) is rejected — only 'true'/'false' accepted", () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      DEPLOY_DRY_RUN: 'FALSE',
    });
    // z.enum(['true','false']) is case-sensitive; 'FALSE' must fail validation.
    expect(result.success).toBe(false);
  });

  it("DEPLOY_DRY_RUN='1' (numeric string) is rejected — not a valid boolean string", () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      DEPLOY_DRY_RUN: '1',
    });
    expect(result.success).toBe(false);
  });

  it("DEPLOY_DRY_RUN='0' (numeric string) is rejected — not a valid boolean string", () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      DEPLOY_DRY_RUN: '0',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — worker.ts cron payload reflects env.DEPLOY_DRY_RUN
// ---------------------------------------------------------------------------

// Mock getDb to avoid pulling in Kysely / Postgres.
vi.mock('../../src/db/kysely.js', () => ({
  getDb: () => ({
    selectFrom: (_table: string) => ({
      select: (_cols: string[]) => ({
        execute: async () => [],
        where: (_col: string, _op: string, _val: unknown) => ({
          where: (_c2: string, _o2: string, _v2: unknown) => ({
            orderBy: (_c3: string, _d: string) => ({
              limit: (_n: number) => ({
                executeTakeFirst: async () => undefined,
              }),
            }),
          }),
          execute: async () => [],
        }),
      }),
    }),
  }),
}));

// Mock pg-boss to avoid CJS/ESM interop issues.
vi.mock('pg-boss', () => {
  class MockPgBoss {
    on(_event: string, _handler: (...args: unknown[]) => void) {}
    async start() {}
    async stop(_opts?: object) {}
    async send(_name: string, _data: object, _opts?: object) { return 'mock-id'; }
    async schedule(_name: string, _cron: string, _data: object, _opts?: object) {}
    async unschedule(_name: string) {}
    async work(_name: string, _opts: object, _handler: (...args: unknown[]) => unknown) {}
    async createQueue(_name: string) {}
    async getSchedules() { return []; }
  }
  return { default: MockPgBoss };
});

// Mock env so DEPLOY_DRY_RUN=false (the "operator enables real publish" scenario).
vi.mock('../../src/config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...original,
    env: {
      ...original.env,
      DEPLOY_DRY_RUN: false,
    },
  };
});

// Import worker AFTER all vi.mock declarations so mocks are hoisted correctly.
import { startWorker } from '../../src/scheduler/worker.js';
import { JOB_NAMES } from '../../src/scheduler/jobs.js';
import type { JobQueue, JobHandler } from '../../src/scheduler/queue.js';

type ScheduleCall = { name: string; cron: string; data: object; opts?: object };

function makeMockQueue() {
  const scheduleCalls: ScheduleCall[] = [];
  const registeredHandlers = new Map<string, JobHandler<object>>();

  const queue: Partial<JobQueue> = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    enqueue: vi.fn(async () => 'mock-job-id'),
    schedule: vi.fn(async (name: string, cron: string, data: object, opts?: object) => {
      scheduleCalls.push({ name, cron, data, opts });
    }),
    unschedule: vi.fn(async () => {}),
    work: vi.fn(async (name: string, handler: JobHandler<object>) => {
      registeredHandlers.set(name, handler);
    }),
    getSchedules: vi.fn(async () => []),
  };

  return { queue: queue as JobQueue, scheduleCalls, registeredHandlers };
}

function makeNoopHandlers() {
  return {
    cyclePlan: vi.fn(async () => {}),
    responseRun: vi.fn(async () => {}),
    cycleAggregate: vi.fn(async () => {}),
    publishDispatch: vi.fn(async () => {}),
    publishUnit: vi.fn(async () => {}),
    publishVerify: vi.fn(async () => {}),
  };
}

describe('worker.ts publish.dispatch cron payload — IDEMP-03 / IT-03', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cron payload dryRun reflects env.DEPLOY_DRY_RUN (false when env is false)', async () => {
    const { queue, scheduleCalls } = makeMockQueue();

    await startWorker({
      queue,
      handlers: makeNoopHandlers(),
      publishCronOverride: '*/5 * * * *',
    });

    const dispatchSchedule = scheduleCalls.find(
      (c) => c.name === JOB_NAMES.PUBLISH_DISPATCH,
    );
    expect(dispatchSchedule).toBeDefined();

    // The payload must NOT be hardcoded true — it must match env.DEPLOY_DRY_RUN
    // which the mock sets to false (simulating DEPLOY_DRY_RUN=false in production).
    const payload = dispatchSchedule!.data as { dryRun: boolean };
    expect(typeof payload.dryRun).toBe('boolean');
    expect(payload.dryRun).toBe(false);
  });

  it('cron payload dryRun is a boolean (not a string or undefined)', async () => {
    const { queue, scheduleCalls } = makeMockQueue();

    await startWorker({
      queue,
      handlers: makeNoopHandlers(),
      publishCronOverride: '*/5 * * * *',
    });

    const dispatchSchedule = scheduleCalls.find(
      (c) => c.name === JOB_NAMES.PUBLISH_DISPATCH,
    );
    expect(dispatchSchedule).toBeDefined();

    const payload = dispatchSchedule!.data as { dryRun: unknown };
    expect(typeof payload.dryRun).toBe('boolean');
    expect(payload.dryRun).not.toBeUndefined();
  });
});
