/**
 * test/scheduler-multicustomer.test.ts
 *
 * Regression test for [HIGH multi-customer-cron-collapse]:
 *   When N active customers exist, the weekly cron must produce N independent
 *   cycle.plan enqueues — one per customer — rather than collapsing all
 *   customers into a single pg-boss schedule row.
 *
 * Root cause (pre-fix): calling queue.schedule(JOB_NAMES.CYCLE_PLAN, ...) N
 * times uses the same schedule name (queue name = 'cycle.plan') for every
 * customer. pg-boss's schedule table has PRIMARY KEY(name) with ON CONFLICT
 * DO UPDATE, so each iteration OVERWRITES the previous — only the last
 * customer's row survives.
 *
 * Fix (verified here): startWorker registers ONE cron schedule on
 * CYCLE_CRON_QUEUE ('cycle.cron'). Its handler queries all active customers
 * and calls queue.enqueue(JOB_NAMES.CYCLE_PLAN, ...) once per customer,
 * producing N independent enqueues with distinct singletonKeys.
 *
 * Strategy:
 *   1. Mock getDb to return a controlled customer list.
 *   2. Build a mock JobQueue that captures calls to work/schedule/enqueue.
 *   3. Call startWorker with injected handlers + mock queue.
 *   4. Extract the handler registered for CYCLE_CRON_QUEUE and invoke it.
 *   5. Assert that queue.enqueue was called once per customer with
 *      name=JOB_NAMES.CYCLE_PLAN and a distinct singletonKey per customer.
 *   6. Assert queue.schedule was called ONCE total for CYCLE_CRON_QUEUE
 *      (no per-customer schedule rows).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JOB_NAMES } from "../src/scheduler/jobs.js";
import { CYCLE_CRON_QUEUE } from "../src/scheduler/queue.js";
import type { JobHandler } from "../src/scheduler/queue.js";

// ---------------------------------------------------------------------------
// Mock getDb / Kysely — must be hoisted above the import of worker.ts
// ---------------------------------------------------------------------------

const mockCustomers: Array<{ id: string; slug: string }> = [];

vi.mock("../src/db/kysely.js", () => ({
  getDb: () => ({
    selectFrom: (_table: string) => ({
      select: (_cols: string[]) => ({
        execute: async () => mockCustomers,
        where: (_col: string, _op: string, _val: string) => ({
          where: (_col2: string, _op2: string, _val2: string) => ({
            orderBy: (_col3: string, _dir: string) => ({
              limit: (_n: number) => ({
                executeTakeFirst: async () => undefined,
              }),
            }),
          }),
          execute: async () => mockCustomers,
        }),
      }),
    }),
  }),
}));

// Mock pg-boss to avoid pulling in the real pg/pg-boss (CJS/ESM interop issue).
vi.mock("pg-boss", () => {
  class MockPgBoss {
    on(_event: string, _handler: (...args: unknown[]) => void) {}
    async start() {}
    async stop(_opts?: object) {}
    async send(_name: string, _data: object, _opts?: object) { return "mock-id"; }
    async schedule(_name: string, _cron: string, _data: object, _opts?: object) {}
    async unschedule(_name: string) {}
    async work(_name: string, _opts: object, _handler: (...args: unknown[]) => unknown) {}
    async createQueue(_name: string) {}
    async getSchedules() { return []; }
  }
  return { default: MockPgBoss };
});

// Import worker AFTER vi.mock so the mock is in place.
import { startWorker } from "../src/scheduler/worker.js";

// ---------------------------------------------------------------------------
// Mock JobQueue factory
// ---------------------------------------------------------------------------

type MockScheduleCall = {
  name: string;
  cron: string;
  data: object;
  opts?: object;
};

type MockEnqueueCall = {
  name: string;
  data: object;
  opts?: object;
};

function makeMockQueue() {
  // Map from queue name -> registered handler
  const registeredHandlers = new Map<string, JobHandler<object>>();
  const scheduleCalls: MockScheduleCall[] = [];
  const enqueueCalls: MockEnqueueCall[] = [];

  const queue = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    enqueue: vi.fn(async (name: string, data: object, opts?: object) => {
      enqueueCalls.push({ name, data, opts });
      return "mock-job-id";
    }),
    schedule: vi.fn(async (name: string, cron: string, data: object, opts?: object) => {
      scheduleCalls.push({ name, cron, data, opts });
    }),
    unschedule: vi.fn(async (_name: string) => {}),
    work: vi.fn(async (name: string, handler: JobHandler<object>, _opts?: object) => {
      registeredHandlers.set(name, handler);
    }),
    getSchedules: vi.fn(async () => []),
  };

  return { queue, registeredHandlers, scheduleCalls, enqueueCalls };
}

function makeNoopHandlers() {
  return {
    cyclePlan: vi.fn(async () => {}),
    responseRun: vi.fn(async () => {}),
    cycleAggregate: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("R-scheduler: multi-customer cron dispatcher", () => {
  beforeEach(() => {
    // Reset the shared customer array
    mockCustomers.length = 0;
    vi.clearAllMocks();
  });

  it("registers exactly ONE schedule row on cycle.cron (not one per customer)", async () => {
    mockCustomers.push(
      { id: "00000000-0000-0000-0000-000000000001", slug: "emora" },
      { id: "00000000-0000-0000-0000-000000000002", slug: "kbeauty" },
    );

    const { queue, scheduleCalls } = makeMockQueue();
    await startWorker({
      queue: queue as unknown as import("../src/scheduler/queue.js").JobQueue,
      handlers: makeNoopHandlers(),
      cronOverride: "*/5 * * * *", // short interval for test
    });

    const cronSchedules = scheduleCalls.filter((c) => c.name === CYCLE_CRON_QUEUE);
    expect(cronSchedules).toHaveLength(1);

    // The cycle.plan queue must NOT appear in scheduleCalls (no per-customer schedule row).
    const cyclePlanSchedules = scheduleCalls.filter((c) => c.name === JOB_NAMES.CYCLE_PLAN);
    expect(cyclePlanSchedules).toHaveLength(0);
  });

  it("cycle.cron handler enqueues 2 independent cycle.plan jobs for 2 customers", async () => {
    const customerA = { id: "00000000-0000-0000-0000-000000000001", slug: "emora" };
    const customerB = { id: "00000000-0000-0000-0000-000000000002", slug: "kbeauty" };
    mockCustomers.push(customerA, customerB);

    const { queue, registeredHandlers, enqueueCalls } = makeMockQueue();
    await startWorker({
      queue: queue as unknown as import("../src/scheduler/queue.js").JobQueue,
      handlers: makeNoopHandlers(),
      cronOverride: "*/5 * * * *",
    });

    // Retrieve and invoke the dispatcher handler
    const dispatcherHandler = registeredHandlers.get(CYCLE_CRON_QUEUE);
    expect(dispatcherHandler).toBeDefined();

    // Clear any enqueues from startWorker (boot catch-up) so we only count
    // what the dispatcher handler produces on a cron tick.
    enqueueCalls.length = 0;

    // Simulate a cron tick by calling the handler with a mock empty job batch
    const mockJob = { id: "cron-job-id", name: CYCLE_CRON_QUEUE, data: {} };
    await dispatcherHandler!([mockJob]);

    // Should have enqueued exactly 2 cycle.plan jobs
    const cyclePlanEnqueues = enqueueCalls.filter((c) => c.name === JOB_NAMES.CYCLE_PLAN);
    expect(cyclePlanEnqueues).toHaveLength(2);

    // Each enqueue must target distinct customers
    const enqueuedCustomerIds = cyclePlanEnqueues.map((c) => (c.data as { customerId: string }).customerId);
    expect(enqueuedCustomerIds).toContain(customerA.id);
    expect(enqueuedCustomerIds).toContain(customerB.id);
    expect(new Set(enqueuedCustomerIds).size).toBe(2);

    // singletonKey must be distinct per customer
    const singletonKeys = cyclePlanEnqueues.map((c) => (c.opts as { singletonKey?: string } | undefined)?.singletonKey);
    expect(new Set(singletonKeys).size).toBe(2);
  });

  it("cycle.cron handler enqueues 0 cycle.plan jobs when no active customers exist", async () => {
    // mockCustomers is empty

    const { queue, registeredHandlers, enqueueCalls } = makeMockQueue();
    await startWorker({
      queue: queue as unknown as import("../src/scheduler/queue.js").JobQueue,
      handlers: makeNoopHandlers(),
      cronOverride: "*/5 * * * *",
    });

    const dispatcherHandler = registeredHandlers.get(CYCLE_CRON_QUEUE);
    expect(dispatcherHandler).toBeDefined();

    const mockJob = { id: "cron-job-id", name: CYCLE_CRON_QUEUE, data: {} };
    await dispatcherHandler!([mockJob]);

    const cyclePlanEnqueues = enqueueCalls.filter((c) => c.name === JOB_NAMES.CYCLE_PLAN);
    expect(cyclePlanEnqueues).toHaveLength(0);
  });

  it("each cycle.plan enqueue payload has kind='operating'", async () => {
    mockCustomers.push(
      { id: "00000000-0000-0000-0000-000000000001", slug: "emora" },
      { id: "00000000-0000-0000-0000-000000000002", slug: "kbeauty" },
    );

    const { queue, registeredHandlers, enqueueCalls } = makeMockQueue();
    await startWorker({
      queue: queue as unknown as import("../src/scheduler/queue.js").JobQueue,
      handlers: makeNoopHandlers(),
      cronOverride: "*/5 * * * *",
    });

    const dispatcherHandler = registeredHandlers.get(CYCLE_CRON_QUEUE);
    const mockJob = { id: "cron-job-id", name: CYCLE_CRON_QUEUE, data: {} };
    // Clear boot catch-up enqueues first.
    enqueueCalls.length = 0;
    await dispatcherHandler!([mockJob]);

    const cyclePlanEnqueues = enqueueCalls.filter((c) => c.name === JOB_NAMES.CYCLE_PLAN);
    expect(cyclePlanEnqueues.length).toBeGreaterThan(0);
    for (const enqueue of cyclePlanEnqueues) {
      expect((enqueue.data as { kind: string }).kind).toBe("operating");
    }
  });
});
