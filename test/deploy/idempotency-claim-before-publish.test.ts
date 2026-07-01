/**
 * test/deploy/idempotency-claim-before-publish.test.ts
 *
 * T20 — Idempotency: claim-before-publish.
 *
 * Assert: the url_registry CLAIM happens BEFORE the connector side effect.
 * A redelivered job (same queueId + assetId + channelClass) must NOT call
 * connector.publish() a second time — because the claim slot is already held
 * by the first (successful) invocation.
 *
 * Approach:
 *   - Build a "spy connector" that counts publish() calls.
 *   - First call to publishUnit: claim succeeds (rows-affected=1) → publish() called once.
 *   - Second call (same payload, simulating a redelivered job):
 *       claimUrlRegistry returns { claimed: false } (slot already 'publishing'/'published').
 *       → publish() is NOT called a second time.
 *
 * These tests are UNIT-ONLY (no live DB). We mock the repo functions at module
 * level so the DB query chain is bypassed entirely. We separately mock the DB
 * JOIN query (loadAssetQueueRow) to return an eligible row.
 *
 * SPEC §9, §12; DESIGN-phase3.md §"Idempotency & Safety", §"CLAIM-before-side-effect".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock repo functions (imported by publishUnit.ts)
// ---------------------------------------------------------------------------

const mockClaimUrlRegistry = vi.fn();
const mockMarkUrlRegistryPublished = vi.fn().mockResolvedValue(undefined);
const mockMarkUrlRegistryFailed = vi.fn().mockResolvedValue(undefined);
const mockInsertUrlRegistryDryRun = vi.fn().mockResolvedValue(undefined);
const mockMarkDeployStatus = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/db/repo.js", () => ({
  claimUrlRegistry: (...args: unknown[]) => mockClaimUrlRegistry(...args),
  markUrlRegistryPublished: (...args: unknown[]) => mockMarkUrlRegistryPublished(...args),
  markUrlRegistryFailed: (...args: unknown[]) => mockMarkUrlRegistryFailed(...args),
  insertUrlRegistryDryRun: (...args: unknown[]) => mockInsertUrlRegistryDryRun(...args),
  markDeployStatus: (...args: unknown[]) => mockMarkDeployStatus(...args),
  findUrlRegistryRow: vi.fn().mockResolvedValue(null),
  updateIndexingStatus: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock the Kysely DB layer (used inside loadAssetQueueRow JOIN)
// ---------------------------------------------------------------------------

const mockExecuteTakeFirst = vi.fn();

vi.mock("../../src/db/kysely.js", () => ({
  getDb: () => ({
    selectFrom: () => ({
      innerJoin: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: () => mockExecuteTakeFirst(),
          }),
        }),
      }),
    }),
  }),
}));

// NOW import the module under test (AFTER mocks are set up)
import { publishUnit } from "../../src/deploy/publishUnit.js";
import type { ChannelRegistry } from "../../src/deploy/registry.js";
import type { PublishRequest, PublishResult } from "../../src/deploy/connector.js";
import type { JobQueue } from "../../src/scheduler/queue.js";
import type { PublishUnitPayload } from "../../src/scheduler/jobs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSET_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const QUEUE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const CHANNEL_CLASS = "owned_net" as const;
const REGISTRY_ID = "cccccccc-0000-0000-0000-000000000003";

/** A valid leased + approved queue+asset row returned by the DB JOIN mock. */
const eligibleRow = {
  queue_id: QUEUE_ID,
  queue_status: "leased",
  approved_by: "tester@example.com",
  approved_at: new Date("2026-01-01T00:00:00Z"),
  asset_id: ASSET_ID,
  content_set_id: "dddddddd-0000-0000-0000-000000000004",
  customer_id: null,
  channel_class: CHANNEL_CLASS,
  language: "en",
  industry: "tech",
  phrasing_group_id: "pg-1",
  gate_status: "passed",
  disclosure_tag: null,
  body: {
    content_type: "definition",
    text: "Test definition.",
    meaning_key: "test-key",
  },
};

/** Build a minimal JobQueue stub. */
function makeQueueStub(): JobQueue {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    enqueue: vi.fn().mockResolvedValue("job-123"),
    schedule: vi.fn(),
    unschedule: vi.fn(),
    work: vi.fn(),
    getSchedules: vi.fn().mockResolvedValue([]),
  } as unknown as JobQueue;
}

/** Build a spy connector that records publish() calls and returns PublishOk. */
function makeSpyConnector(publishCallCount: { n: number }) {
  return {
    channelClass: CHANNEL_CLASS,
    capabilities: ["publish", "unpublish", "update", "confirm_indexing"] as const,
    status: "ready" as const,
    publish: vi.fn(async (_req: PublishRequest): Promise<PublishResult> => {
      publishCallCount.n++;
      return {
        ok: true,
        publishedUrl: "https://hub.example.com/en/test-slug/",
        reversible: true,
        meta: { outPath: "/tmp/test" },
      };
    }),
    unpublish: vi.fn(),
    confirmIndexing: vi.fn().mockResolvedValue({ indexed: false, checkedAt: new Date() }),
  };
}

/** Build a ChannelRegistry stub wrapping the given connector. */
function makeRegistryStub(connector: ReturnType<typeof makeSpyConnector>): ChannelRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(connector),
    readiness: vi.fn().mockReturnValue([
      { channelClass: CHANNEL_CLASS, status: "ready", capabilities: ["publish"] },
    ]),
  } as unknown as ChannelRegistry;
}

/** Minimal valid PublishUnitPayload. */
const payload: PublishUnitPayload = {
  queueId: QUEUE_ID,
  assetId: ASSET_ID,
  channelClass: CHANNEL_CLASS,
  dryRun: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("idempotency-claim-before-publish: claim wins → publish() called once", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTakeFirst.mockResolvedValue(eligibleRow);
    mockMarkUrlRegistryPublished.mockResolvedValue(undefined);
    mockMarkDeployStatus.mockResolvedValue(undefined);
  });

  it("publish() is called exactly once when the claim succeeds", async () => {
    // Arrange: claimUrlRegistry returns claimed=true
    mockClaimUrlRegistry.mockResolvedValue({
      claimed: true,
      registryId: REGISTRY_ID,
    });

    const publishCallCount = { n: 0 };
    const connector = makeSpyConnector(publishCallCount);
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    await publishUnit(payload, queue, registry);

    expect(publishCallCount.n).toBe(1);
    expect(connector.publish).toHaveBeenCalledTimes(1);
    expect(mockClaimUrlRegistry).toHaveBeenCalledTimes(1);
    expect(mockClaimUrlRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: ASSET_ID,
        channelClass: CHANNEL_CLASS,
      }),
    );
  });
});

describe("idempotency-claim-before-publish: redelivered job → publish() NOT called again", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTakeFirst.mockResolvedValue(eligibleRow);
    mockMarkDeployStatus.mockResolvedValue(undefined);
  });

  it("a redelivered job loses the claim and exits as a no-op without calling publish()", async () => {
    // Arrange: claimUrlRegistry returns claimed=false — another worker won the slot
    mockClaimUrlRegistry.mockResolvedValue({
      claimed: false,
      registryId: null,
    });

    const publishCallCount = { n: 0 };
    const connector = makeSpyConnector(publishCallCount);
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    await publishUnit(payload, queue, registry);

    expect(publishCallCount.n).toBe(0);
    expect(connector.publish).not.toHaveBeenCalled();
    expect(mockClaimUrlRegistry).toHaveBeenCalledTimes(1);
  });

  it("two sequential calls with claim=true then claim=false → publish() called exactly once total", async () => {
    const publishCallCount = { n: 0 };
    const connector = makeSpyConnector(publishCallCount);
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    // First call: claim wins
    mockClaimUrlRegistry.mockResolvedValueOnce({
      claimed: true,
      registryId: REGISTRY_ID,
    });
    mockMarkUrlRegistryPublished.mockResolvedValue(undefined);
    mockMarkDeployStatus.mockResolvedValue(undefined);

    await publishUnit(payload, queue, registry);
    expect(publishCallCount.n).toBe(1);

    // Second call: claim loses (slot already held)
    mockClaimUrlRegistry.mockResolvedValueOnce({
      claimed: false,
      registryId: null,
    });

    await publishUnit(payload, queue, registry);

    // Total publish() calls: still exactly 1
    expect(publishCallCount.n).toBe(1);
    expect(connector.publish).toHaveBeenCalledTimes(1);
  });
});

describe("idempotency-claim-before-publish: unique-violation on claim is a no-op", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTakeFirst.mockResolvedValue(eligibleRow);
    mockMarkDeployStatus.mockResolvedValue(undefined);
  });

  it("a 23505 unique-violation from claimUrlRegistry is treated as no-op without calling publish()", async () => {
    // Simulate a raw PG unique-violation error from claimUrlRegistry
    const pgErr = Object.assign(new Error("unique violation"), { code: "23505" });
    mockClaimUrlRegistry.mockRejectedValue(pgErr);

    const publishCallCount = { n: 0 };
    const connector = makeSpyConnector(publishCallCount);
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    // publishUnit propagates the 23505 to the outer handler;
    // the outer handler (createPublishUnitHandler) catches it as no-op.
    // Here we test that publish() was NOT called.
    try {
      await publishUnit(payload, queue, registry);
    } catch {
      // 23505 may propagate from publishUnit — that's OK; the outer handler catches it.
    }

    // Key assertion: connector.publish() was NEVER called
    expect(publishCallCount.n).toBe(0);
    expect(connector.publish).not.toHaveBeenCalled();
  });
});

describe("idempotency-claim-before-publish: queue row not found is a no-op", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publish() is NOT called when the queue row is not found", async () => {
    // DB JOIN returns null (row was deleted or cleaned up)
    mockExecuteTakeFirst.mockResolvedValue(null);

    const publishCallCount = { n: 0 };
    const connector = makeSpyConnector(publishCallCount);
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    await publishUnit(payload, queue, registry);

    expect(publishCallCount.n).toBe(0);
    expect(connector.publish).not.toHaveBeenCalled();
    // claimUrlRegistry should NOT have been called (row not found exits early)
    expect(mockClaimUrlRegistry).not.toHaveBeenCalled();
  });
});
