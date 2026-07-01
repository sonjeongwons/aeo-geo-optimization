/**
 * test/deploy/dispatch-skip-stub-channels.test.ts
 *
 * T20 — Dispatch skips stub channels; their rows remain 'queued'.
 *
 * Assert:
 *   - handlePublishDispatch skips channels with status !== 'ready'.
 *   - No publish.unit job is enqueued for stub/not_configured channels.
 *   - Rows for stub channels stay in 'queued' status (never enqueued or DLQ'd).
 *   - Only 'ready' channels are dispatched to (owned_net in this phase).
 *   - singletonKey prevents double-enqueue of the same asset+channel pair.
 *
 * These tests are UNIT-ONLY (no live DB, no real pg-boss).
 * The ChannelRegistry readiness() is mocked to control which channels appear
 * as 'ready' vs 'stub'; claimNextDeployBatch and throttle reads are mocked.
 *
 * DESIGN-phase3.md §"Queue Consumption", §"External Channels (stubs)".
 * SPEC §7#3, §8.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { handlePublishDispatch } from "../../src/deploy/dispatch.js";
import type { ChannelRegistry } from "../../src/deploy/registry.js";
import type { JobQueue } from "../../src/scheduler/queue.js";
import type { ChannelReadiness } from "../../src/deploy/connector.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/db/repo.js", () => ({
  reapStaleLeases: vi.fn().mockResolvedValue({ reclaimed: 0 }),
  // THR-02 fix: dispatch now calls claimNextDeployBatchForCustomer per customer.
  claimNextDeployBatchForCustomer: vi.fn().mockResolvedValue([]),
  // THR-02 fix: dispatch enumerates customers before claiming.
  readDistinctCustomersWithQueuedRows: vi.fn().mockResolvedValue([null]),
  readThrottlePolicy: vi.fn().mockResolvedValue({
    channel_class: "owned_net",
    max_per_day: 100,
    max_per_week: 500,
    min_interval_minutes: 0,
    enabled: true,
  }),
  readThrottleState: vi.fn().mockResolvedValue(null),
}));

// Mock env so DEPLOY_LEASE_TIMEOUT_MS is available
vi.mock("../../src/config/env.js", () => ({
  env: {
    DEPLOY_LEASE_TIMEOUT_MS: 300_000,
    DEPLOY_DRY_RUN: true,
    OWNED_NET_OUT_DIR: "./.owned-net-out",
    OWNED_NET_HUB_BASE_URL: "https://hub.example.com",
    DEPLOY_DEFAULT_MAX_PER_DAY: 0,
    CUSTOMER_DOMAIN_BLOCKLIST: [],
  },
}));

import { claimNextDeployBatchForCustomer, readDistinctCustomersWithQueuedRows, reapStaleLeases } from "../../src/db/repo.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueue(): JobQueue {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    enqueue: vi.fn().mockResolvedValue("job-dispatch-1"),
    schedule: vi.fn(),
    unschedule: vi.fn(),
    work: vi.fn(),
    getSchedules: vi.fn().mockResolvedValue([]),
  } as unknown as JobQueue;
}

function makeRegistry(readinessReport: ChannelReadiness[]): ChannelRegistry {
  return {
    register: vi.fn(),
    get: vi.fn(),
    readiness: vi.fn().mockReturnValue(readinessReport),
  } as unknown as ChannelRegistry;
}

const ALL_STUB_READINESS: ChannelReadiness[] = [
  { channelClass: "pr_wire",   status: "stub",          capabilities: ["publish"] },
  { channelClass: "directory", status: "stub",          capabilities: ["publish"] },
  { channelClass: "web2",      status: "stub",          capabilities: ["publish", "update"] },
  { channelClass: "social",    status: "stub",          capabilities: ["publish"] },
  { channelClass: "entity",    status: "not_configured", capabilities: [] },
];

const OWNED_NET_READY: ChannelReadiness = {
  channelClass: "owned_net",
  status: "ready",
  capabilities: ["publish", "update", "unpublish", "confirm_indexing"],
};

const MIXED_READINESS: ChannelReadiness[] = [
  OWNED_NET_READY,
  ...ALL_STUB_READINESS,
];

// Minimal payload for dispatch (dry-run by default)
const dryRunPayload = { dryRun: true };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatch-skip-stub-channels: stub channels never enqueued", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("when ALL channels are stub/not_configured, no publish.unit jobs are enqueued", async () => {
    const registry = makeRegistry(ALL_STUB_READINESS);
    const queue = makeQueue();

    await handlePublishDispatch(dryRunPayload, queue, registry);

    // No enqueue calls — all channels were skipped
    expect(queue.enqueue).not.toHaveBeenCalled();
    // claimNextDeployBatchForCustomer was not called (no ready channels)
    expect(claimNextDeployBatchForCustomer).not.toHaveBeenCalled();
  });

  it("stub channels are individually logged (via readiness filter) and not claimed", async () => {
    const registry = makeRegistry(ALL_STUB_READINESS);
    const queue = makeQueue();

    await handlePublishDispatch(dryRunPayload, queue, registry);

    // Still no claims
    expect(claimNextDeployBatchForCustomer).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("only owned_net (ready) channel is dispatched when mixed readiness", async () => {
    const registry = makeRegistry(MIXED_READINESS);
    const queue = makeQueue();

    // owned_net returns one claimed row (for the NULL customer)
    const claimedRow = {
      queue_id: "qqqq-0001",
      asset_id: "aaaa-0001",
      customer_id: null,
      channel_class: "owned_net",
    };
    vi.mocked(readDistinctCustomersWithQueuedRows).mockResolvedValueOnce([null]);
    vi.mocked(claimNextDeployBatchForCustomer).mockResolvedValueOnce([claimedRow]);

    await handlePublishDispatch(dryRunPayload, queue, registry);

    // claimNextDeployBatchForCustomer called once (only for owned_net, null customer)
    expect(claimNextDeployBatchForCustomer).toHaveBeenCalledTimes(1);
    expect(claimNextDeployBatchForCustomer).toHaveBeenCalledWith(
      "owned_net", null, expect.any(Number), expect.any(Date), true,
    );

    // One publish.unit job enqueued (for the owned_net row)
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(
      "publish.unit",
      expect.objectContaining({
        queueId: "qqqq-0001",
        assetId: "aaaa-0001",
        channelClass: "owned_net",
      }),
      expect.objectContaining({
        singletonKey: "publish:aaaa-0001:owned_net",
      }),
    );
  });

  it("stub channels are never enqueued even when rows exist", async () => {
    const registry = makeRegistry(MIXED_READINESS);
    const queue = makeQueue();

    // owned_net: no rows claimed; stubs: also never claimed (filtered before call)
    vi.mocked(claimNextDeployBatchForCustomer).mockResolvedValue([]);

    await handlePublishDispatch(dryRunPayload, queue, registry);

    // claimNextDeployBatchForCustomer only called for owned_net (the only 'ready' channel)
    const calls = vi.mocked(claimNextDeployBatchForCustomer).mock.calls;
    for (const [channelClass] of calls) {
      expect(channelClass).toBe("owned_net"); // never pr_wire/directory/web2/social/entity
    }

    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("stub channel rows stay 'queued' — no status transition caused by dispatch", async () => {
    const registry = makeRegistry(ALL_STUB_READINESS);
    const queue = makeQueue();

    await handlePublishDispatch(dryRunPayload, queue, registry);

    // No repo writes that would change queue row status
    // (claimNextDeployBatchForCustomer was never called, so no rows were leased)
    expect(claimNextDeployBatchForCustomer).not.toHaveBeenCalled();
    // No enqueue attempts
    expect(queue.enqueue).not.toHaveBeenCalled();
    // Stale lease reap still runs (that only resets leased→queued for timed-out rows)
    expect(reapStaleLeases).toHaveBeenCalledTimes(1);
  });

  it("singletonKey prevents double-enqueue for the same asset+channel", async () => {
    const registry = makeRegistry([OWNED_NET_READY]);
    const queue = makeQueue();

    const claimedRow = {
      queue_id: "qqqq-singleton",
      asset_id: "aaaa-singleton",
      customer_id: null,
      channel_class: "owned_net",
    };
    vi.mocked(readDistinctCustomersWithQueuedRows).mockResolvedValue([null]);
    vi.mocked(claimNextDeployBatchForCustomer).mockResolvedValue([claimedRow]);

    // First dispatch attempt: enqueue succeeds
    vi.mocked(queue.enqueue).mockResolvedValueOnce("job-1");

    await handlePublishDispatch(dryRunPayload, queue, registry);

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    const enqueuedOpts = vi.mocked(queue.enqueue).mock.calls[0]?.[2];
    expect(enqueuedOpts?.singletonKey).toBe("publish:aaaa-singleton:owned_net");

    // Reset and simulate a second dispatch (same claimed row)
    vi.clearAllMocks();
    vi.mocked(reapStaleLeases).mockResolvedValue({ reclaimed: 0 });
    vi.mocked(readDistinctCustomersWithQueuedRows).mockResolvedValue([null]);
    vi.mocked(claimNextDeployBatchForCustomer).mockResolvedValue([claimedRow]);

    // Second dispatch attempt: singletonKey blocks → enqueue returns null
    vi.mocked(queue.enqueue).mockResolvedValueOnce(null);

    await handlePublishDispatch(dryRunPayload, queue, registry);

    // The enqueue was attempted once (per row) but returned null (singleton blocked)
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    // Still only the one singleton key
    const secondOpts = vi.mocked(queue.enqueue).mock.calls[0]?.[2];
    expect(secondOpts?.singletonKey).toBe("publish:aaaa-singleton:owned_net");
  });

  it("payload with specific channelClass only dispatches that channel", async () => {
    const registry = makeRegistry(MIXED_READINESS);
    const queue = makeQueue();

    const claimedRow = {
      queue_id: "qqqq-specific",
      asset_id: "aaaa-specific",
      customer_id: null,
      channel_class: "owned_net",
    };
    vi.mocked(readDistinctCustomersWithQueuedRows).mockResolvedValue([null]);
    vi.mocked(claimNextDeployBatchForCustomer).mockResolvedValue([claimedRow]);

    // Restrict dispatch to owned_net only
    await handlePublishDispatch({ dryRun: true, channelClass: "owned_net" }, queue, registry);

    expect(claimNextDeployBatchForCustomer).toHaveBeenCalledTimes(1);
    expect(claimNextDeployBatchForCustomer).toHaveBeenCalledWith(
      "owned_net", null, expect.any(Number), expect.any(Date), true,
    );
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("dispatch with channelClass='pr_wire' (stub) enqueues nothing", async () => {
    const registry = makeRegistry(MIXED_READINESS);
    const queue = makeQueue();

    // Restrict to pr_wire — which is stub, not ready
    await handlePublishDispatch({ dryRun: true, channelClass: "pr_wire" }, queue, registry);

    expect(claimNextDeployBatchForCustomer).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
