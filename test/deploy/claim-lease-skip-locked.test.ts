/**
 * test/deploy/claim-lease-skip-locked.test.ts
 *
 * T20 — Concurrent claim yields single-consumer (SKIP LOCKED).
 *
 * Assert:
 *   - When two concurrent "workers" both call publishUnit for the same queue row,
 *     only ONE of them wins the url_registry claim; the other exits as a no-op.
 *   - The connector.publish() spy is called at most once across both workers.
 *   - This models the SKIP LOCKED + ON CONFLICT DO NOTHING two-layer guard.
 *
 * DESIGN-phase3.md §"Idempotency & Safety", §"CLAIM-before-side-effect".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock repo functions
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
// Mock the Kysely DB layer
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

import { publishUnit } from "../../src/deploy/publishUnit.js";
import type { ChannelRegistry } from "../../src/deploy/registry.js";
import type { PublishRequest, PublishResult } from "../../src/deploy/connector.js";
import type { JobQueue } from "../../src/scheduler/queue.js";
import type { PublishUnitPayload } from "../../src/scheduler/jobs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSET_ID = "aaaaaaaa-2222-0000-0000-000000000001";
const QUEUE_ID = "bbbbbbbb-2222-0000-0000-000000000002";
const REGISTRY_ID = "cccccccc-2222-0000-0000-000000000003";

const eligibleRow = {
  queue_id: QUEUE_ID,
  queue_status: "leased",
  approved_by: "admin@example.com",
  approved_at: new Date("2026-01-01T00:00:00Z"),
  asset_id: ASSET_ID,
  content_set_id: "dddddddd-2222-0000-0000-000000000004",
  customer_id: null,
  channel_class: "owned_net",
  language: "en",
  industry: "tech",
  phrasing_group_id: "pg-3",
  gate_status: "passed",
  disclosure_tag: null,
  body: {
    content_type: "definition",
    text: "Concurrent definition.",
    meaning_key: "concurrent-key",
  },
};

let totalPublishCalls = 0;

function makeSpyConnector() {
  return {
    channelClass: "owned_net" as const,
    capabilities: ["publish", "unpublish", "update", "confirm_indexing"] as const,
    status: "ready" as const,
    publish: vi.fn(async (_req: PublishRequest): Promise<PublishResult> => {
      totalPublishCalls++;
      return {
        ok: true,
        publishedUrl: "https://hub.example.com/en/concurrent-slug/",
        reversible: true,
        meta: {},
      };
    }),
    unpublish: vi.fn(),
    confirmIndexing: vi.fn().mockResolvedValue({ indexed: false, checkedAt: new Date() }),
  };
}

function makeRegistry(connector: ReturnType<typeof makeSpyConnector>): ChannelRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(connector),
    readiness: vi.fn().mockReturnValue([]),
  } as unknown as ChannelRegistry;
}

function makeQueue(): JobQueue {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    enqueue: vi.fn().mockResolvedValue("job-xyz"),
    schedule: vi.fn(),
    unschedule: vi.fn(),
    work: vi.fn(),
    getSchedules: vi.fn().mockResolvedValue([]),
  } as unknown as JobQueue;
}

const payload: PublishUnitPayload = {
  queueId: QUEUE_ID,
  assetId: ASSET_ID,
  channelClass: "owned_net",
  dryRun: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("claim-lease-skip-locked: concurrent workers yield single-consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    totalPublishCalls = 0;
    mockMarkUrlRegistryPublished.mockResolvedValue(undefined);
    mockMarkDeployStatus.mockResolvedValue(undefined);
    mockMarkUrlRegistryFailed.mockResolvedValue(undefined);
  });

  it("only one worker calls connector.publish() when two race for the same row", async () => {
    // Both workers read the same eligible row
    mockExecuteTakeFirst.mockResolvedValue(eligibleRow);

    // Worker 1 wins the claim; Worker 2 loses it
    mockClaimUrlRegistry
      .mockResolvedValueOnce({ claimed: true, registryId: REGISTRY_ID })
      .mockResolvedValueOnce({ claimed: false, registryId: null });

    const connector = makeSpyConnector();
    const registry = makeRegistry(connector);

    // Run both workers concurrently
    await Promise.all([
      publishUnit(payload, makeQueue(), registry),
      publishUnit(payload, makeQueue(), registry),
    ]);

    // Exactly one publish() call total
    expect(totalPublishCalls).toBe(1);
    expect(connector.publish).toHaveBeenCalledTimes(1);
  });

  it("three concurrent workers → only one publish() regardless of claim order", async () => {
    mockExecuteTakeFirst.mockResolvedValue(eligibleRow);

    // Only the first claimUrlRegistry call wins
    mockClaimUrlRegistry
      .mockResolvedValueOnce({ claimed: true, registryId: REGISTRY_ID })
      .mockResolvedValue({ claimed: false, registryId: null });

    const connector = makeSpyConnector();
    const registry = makeRegistry(connector);

    await Promise.all([
      publishUnit(payload, makeQueue(), registry),
      publishUnit(payload, makeQueue(), registry),
      publishUnit(payload, makeQueue(), registry),
    ]);

    expect(totalPublishCalls).toBe(1);
    expect(connector.publish).toHaveBeenCalledTimes(1);
  });

  it("claimUrlRegistry is called by each worker but only winner proceeds to publish()", async () => {
    mockExecuteTakeFirst.mockResolvedValue(eligibleRow);

    mockClaimUrlRegistry
      .mockResolvedValueOnce({ claimed: true, registryId: REGISTRY_ID })
      .mockResolvedValueOnce({ claimed: false, registryId: null });

    const connector = makeSpyConnector();
    const registry = makeRegistry(connector);

    await Promise.all([
      publishUnit(payload, makeQueue(), registry),
      publishUnit(payload, makeQueue(), registry),
    ]);

    // claimUrlRegistry was attempted twice (once per worker)
    expect(mockClaimUrlRegistry).toHaveBeenCalledTimes(2);
    // But only one publish occurred
    expect(connector.publish).toHaveBeenCalledTimes(1);
  });

  it("concurrent workers processing DIFFERENT assets can both proceed", async () => {
    const ASSET_A = "aaaaaaaa-3333-0000-0000-000000000001";
    const ASSET_B = "bbbbbbbb-3333-0000-0000-000000000002";

    const rowA = { ...eligibleRow, asset_id: ASSET_A, queue_id: "qqqq-aaaa" };
    const rowB = { ...eligibleRow, asset_id: ASSET_B, queue_id: "qqqq-bbbb" };

    mockExecuteTakeFirst
      .mockResolvedValueOnce(rowA)
      .mockResolvedValueOnce(rowB);

    // Both workers win their respective claims (different asset IDs → different keys)
    mockClaimUrlRegistry
      .mockResolvedValueOnce({ claimed: true, registryId: "reg-a" })
      .mockResolvedValueOnce({ claimed: true, registryId: "reg-b" });

    const connector = makeSpyConnector();
    const registry = makeRegistry(connector);

    const payloadA: PublishUnitPayload = { ...payload, assetId: ASSET_A, queueId: "qqqq-aaaa" };
    const payloadB: PublishUnitPayload = { ...payload, assetId: ASSET_B, queueId: "qqqq-bbbb" };

    await Promise.all([
      publishUnit(payloadA, makeQueue(), registry),
      publishUnit(payloadB, makeQueue(), registry),
    ]);

    // Both publishes went through (different assets → no collision)
    expect(totalPublishCalls).toBe(2);
    expect(connector.publish).toHaveBeenCalledTimes(2);
  });

  it("no claim is attempted when queue row is not found (pre-claim guard)", async () => {
    // One worker finds the row; one finds null (already deleted)
    mockExecuteTakeFirst
      .mockResolvedValueOnce(eligibleRow)
      .mockResolvedValueOnce(null);

    mockClaimUrlRegistry
      .mockResolvedValueOnce({ claimed: true, registryId: REGISTRY_ID });

    const connector = makeSpyConnector();
    const registry = makeRegistry(connector);

    await Promise.all([
      publishUnit(payload, makeQueue(), registry),
      publishUnit(payload, makeQueue(), registry),
    ]);

    // First worker found the row and published; second worker found null and exited
    expect(totalPublishCalls).toBe(1);
    // claimUrlRegistry called once only (second worker exits before reaching the claim)
    expect(mockClaimUrlRegistry).toHaveBeenCalledTimes(1);
  });
});
