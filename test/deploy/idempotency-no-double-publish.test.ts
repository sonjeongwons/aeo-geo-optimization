/**
 * test/deploy/idempotency-no-double-publish.test.ts
 *
 * T20 — Idempotency: the partial unique index prevents a second live row.
 *
 * Assert:
 *   - claimUrlRegistry (ON CONFLICT DO NOTHING) returns claimed=false when a
 *     'publishing' or 'published' row already exists for (asset_id, channel_class).
 *   - A second call with the same (asset_id, channel_class) while the first row
 *     is 'publishing' or 'published' does NOT call connector.publish() a second time.
 *   - A call for a different channel class on the same asset CAN proceed independently.
 *   - dry_run path does NOT claim the idempotency slot (so a real publish can follow).
 *
 * These tests exercise the publishUnit handler logic with mocked repo functions
 * to verify the idempotency contract without requiring a live DB.
 *
 * SPEC §9; DESIGN-phase3.md §"CLAIM-before-side-effect", §"ONE idempotency arbiter".
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

import { publishUnit } from "../../src/deploy/publishUnit.js";
import type { ChannelRegistry } from "../../src/deploy/registry.js";
import type { PublishRequest, PublishResult } from "../../src/deploy/connector.js";
import type { JobQueue } from "../../src/scheduler/queue.js";
import type { PublishUnitPayload } from "../../src/scheduler/jobs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSET_ID = "aaaaaaaa-1111-0000-0000-000000000001";
const QUEUE_ID = "bbbbbbbb-1111-0000-0000-000000000002";
const REGISTRY_ID_1 = "cccccccc-1111-0000-0000-000000000003";

function makeEligibleRow(overrides: Record<string, unknown> = {}) {
  return {
    queue_id: QUEUE_ID,
    queue_status: "leased",
    approved_by: "approver@example.com",
    approved_at: new Date("2026-01-01T00:00:00Z"),
    asset_id: ASSET_ID,
    content_set_id: "dddddddd-1111-0000-0000-000000000004",
    customer_id: null,
    channel_class: "owned_net",
    language: "en",
    industry: "tech",
    phrasing_group_id: "pg-2",
    gate_status: "passed",
    disclosure_tag: null,
    body: {
      content_type: "definition",
      text: "Idempotency definition.",
      meaning_key: "idem-key",
    },
    ...overrides,
  };
}

let publishCallCount: { n: number };

function makeSpyConnector(channelClass: "owned_net" | "pr_wire" = "owned_net") {
  return {
    channelClass,
    capabilities: ["publish", "unpublish", "update", "confirm_indexing"] as const,
    status: "ready" as const,
    publish: vi.fn(async (_req: PublishRequest): Promise<PublishResult> => {
      publishCallCount.n++;
      return {
        ok: true,
        publishedUrl: "https://hub.example.com/en/idem-slug/",
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
    enqueue: vi.fn().mockResolvedValue("job-abc"),
    schedule: vi.fn(),
    unschedule: vi.fn(),
    work: vi.fn(),
    getSchedules: vi.fn().mockResolvedValue([]),
  } as unknown as JobQueue;
}

const basePayload: PublishUnitPayload = {
  queueId: QUEUE_ID,
  assetId: ASSET_ID,
  channelClass: "owned_net",
  dryRun: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("idempotency-no-double-publish: partial unique index prevents second live row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishCallCount = { n: 0 };
    mockMarkUrlRegistryPublished.mockResolvedValue(undefined);
    mockMarkDeployStatus.mockResolvedValue(undefined);
    mockMarkUrlRegistryFailed.mockResolvedValue(undefined);
  });

  it("when claim returns { claimed: false } the connector.publish() is not called", async () => {
    mockExecuteTakeFirst.mockResolvedValue(makeEligibleRow());
    // Simulate: a 'publishing' row already exists → ON CONFLICT DO NOTHING → no row returned
    mockClaimUrlRegistry.mockResolvedValue({ claimed: false, registryId: null });

    const connector = makeSpyConnector();
    const registry = makeRegistry(connector);

    await publishUnit(basePayload, makeQueue(), registry);

    // No publish side effect
    expect(publishCallCount.n).toBe(0);
    expect(connector.publish).not.toHaveBeenCalled();
  });

  it("claim returns { claimed: true } on first call → connector.publish() called once", async () => {
    mockExecuteTakeFirst.mockResolvedValue(makeEligibleRow());
    mockClaimUrlRegistry.mockResolvedValue({
      claimed: true,
      registryId: REGISTRY_ID_1,
    });

    const connector = makeSpyConnector();
    const registry = makeRegistry(connector);

    await publishUnit(basePayload, makeQueue(), registry);

    expect(publishCallCount.n).toBe(1);
    expect(connector.publish).toHaveBeenCalledTimes(1);
  });

  it("second identical call after first published → claim=false → no double-publish", async () => {
    // Both calls see an eligible row
    mockExecuteTakeFirst
      .mockResolvedValueOnce(makeEligibleRow())
      .mockResolvedValueOnce(makeEligibleRow());

    // First call wins the claim; second call loses
    mockClaimUrlRegistry
      .mockResolvedValueOnce({ claimed: true, registryId: REGISTRY_ID_1 })
      .mockResolvedValueOnce({ claimed: false, registryId: null });

    const connector = makeSpyConnector();
    const registry = makeRegistry(connector);

    // First publish attempt
    await publishUnit(basePayload, makeQueue(), registry);
    expect(publishCallCount.n).toBe(1);

    // Second (redelivered) publish attempt
    await publishUnit(basePayload, makeQueue(), registry);
    expect(publishCallCount.n).toBe(1); // unchanged — no double-publish
  });

  it("different channel_class for same asset uses independent claim keys", async () => {
    // Use web2 for second channel — web2 requires disclosure, so provide a tag.
    // Both channels use the same asset_id but different channel_class, so
    // (asset_id, channel_class) forms two independent partial-unique keys.
    mockExecuteTakeFirst
      .mockResolvedValueOnce(makeEligibleRow({ channel_class: "owned_net" }))
      // web2 requires disclosure_tag (§7#6) — provide a non-null tag
      .mockResolvedValueOnce(makeEligibleRow({ channel_class: "web2", disclosure_tag: "Sponsored" }));

    // Both can claim independently (different (asset_id, channel_class) keys)
    mockClaimUrlRegistry
      .mockResolvedValueOnce({ claimed: true, registryId: "r-owned" })
      .mockResolvedValueOnce({ claimed: true, registryId: "r-web2" });

    const connectorOwned = makeSpyConnector("owned_net");
    const connectorWeb2 = makeSpyConnector("web2" as "owned_net"); // use type assertion for the spy

    const registry1 = makeRegistry(connectorOwned);
    const registry2 = makeRegistry(connectorWeb2);

    const payload1: PublishUnitPayload = { ...basePayload, channelClass: "owned_net" };
    const payload2: PublishUnitPayload = { ...basePayload, channelClass: "web2" };

    await publishUnit(payload1, makeQueue(), registry1);
    await publishUnit(payload2, makeQueue(), registry2);

    // Each connector was called exactly once — independent claim slots
    expect(connectorOwned.publish).toHaveBeenCalledTimes(1);
    expect(connectorWeb2.publish).toHaveBeenCalledTimes(1);
    expect(publishCallCount.n).toBe(2);
  });

  it("dry_run path does NOT claim the idempotency slot (so a real publish can follow)", async () => {
    mockExecuteTakeFirst.mockResolvedValue(makeEligibleRow());
    mockInsertUrlRegistryDryRun.mockResolvedValue(undefined);

    const connector = makeSpyConnector();
    // Override connector to return dry-run result
    vi.mocked(connector.publish).mockImplementation(async (_req) => {
      publishCallCount.n++;
      return {
        ok: true as const,
        dryRun: true as const,
        plannedUrl: "https://hub.example.com/en/dry-run-slug/",
      };
    });

    const registry = makeRegistry(connector);
    const dryPayload: PublishUnitPayload = { ...basePayload, dryRun: true };

    await publishUnit(dryPayload, makeQueue(), registry);

    // For dry-run, claimUrlRegistry should NOT be called
    expect(mockClaimUrlRegistry).not.toHaveBeenCalled();
  });

  it("publish() called zero times when the row is not eligible (gate not passed)", async () => {
    // Row is leased but gate_status is 'blocked' (not 'passed')
    mockExecuteTakeFirst.mockResolvedValue(makeEligibleRow({ gate_status: "blocked" }));

    const connector = makeSpyConnector();
    const registry = makeRegistry(connector);

    await publishUnit(basePayload, makeQueue(), registry);

    expect(publishCallCount.n).toBe(0);
    expect(connector.publish).not.toHaveBeenCalled();
    // No claim was attempted (eligibility failed before the claim step)
    expect(mockClaimUrlRegistry).not.toHaveBeenCalled();
  });
});
