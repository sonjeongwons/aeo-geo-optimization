/**
 * test/deploy/publish-unit-blocklist-dispatch.test.ts
 *
 * OFF-01 fix — §0 dispatch-level CUSTOMER_DOMAIN_BLOCKLIST check in publishUnit.
 *
 * Verifies that when connector.publish() returns a PublishOk whose publishedUrl
 * host is on the CUSTOMER_DOMAIN_BLOCKLIST, publishUnit:
 *   - does NOT mark the registry row 'published'
 *   - DOES mark the registry row 'failed' (rollback)
 *   - DOES mark the queue row 'failed' (DLQ path)
 *   - resolves without retry (permanent violation)
 *
 * This is the SECOND layer of the §0 defense-in-depth:
 *   Layer 1 — inside OwnedNetConnector.publish() (assertNotBlocklisted)
 *   Layer 2 — inside publishUnit AFTER connector.publish() returns (this check)
 *
 * These tests are UNIT-ONLY (no live DB). We mock the repo functions and the
 * Kysely DB layer, and also mock the env module to inject a known blocklist.
 *
 * SPEC §0; DESIGN-phase3.md §"Idempotency & Safety" (§0 OFF-SITE bullet).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock env — inject a known CUSTOMER_DOMAIN_BLOCKLIST
// ---------------------------------------------------------------------------

vi.mock("../../src/config/env.js", () => ({
  env: {
    CUSTOMER_DOMAIN_BLOCKLIST: ["customer-blocked.com", "evil-customer.net"],
    OWNED_NET_OUT_DIR: "/tmp/test-owned-net",
    OWNED_NET_HUB_BASE_URL: "https://hub.example.com",
    DEPLOY_DRY_RUN: true,
    DEPLOY_LEASE_TIMEOUT_MS: 300_000,
    DEPLOY_DEFAULT_MAX_PER_DAY: 0,
  },
}));

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

const ASSET_ID = "aaaaaaaa-1111-0000-0000-000000000001";
const QUEUE_ID = "bbbbbbbb-2222-0000-0000-000000000002";
const CHANNEL_CLASS = "owned_net" as const;
const REGISTRY_ID = "cccccccc-3333-0000-0000-000000000003";

/** A valid leased + approved queue+asset row returned by the DB JOIN mock. */
const eligibleRow = {
  queue_id: QUEUE_ID,
  queue_status: "leased",
  approved_by: "tester@example.com",
  approved_at: new Date("2026-01-01T00:00:00Z"),
  asset_id: ASSET_ID,
  content_set_id: "dddddddd-4444-0000-0000-000000000004",
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

/**
 * Build a spy connector whose publish() returns PublishOk with the given
 * publishedUrl — simulating a connector that bypassed its own §0 guard.
 */
function makeConnectorReturning(publishedUrl: string) {
  return {
    channelClass: CHANNEL_CLASS,
    capabilities: ["publish", "unpublish", "update", "confirm_indexing"] as const,
    status: "ready" as const,
    publish: vi.fn(async (_req: PublishRequest): Promise<PublishResult> => ({
      ok: true,
      publishedUrl,
      reversible: true,
      meta: { outPath: "/tmp/test" },
    })),
    unpublish: vi.fn(),
    confirmIndexing: vi.fn().mockResolvedValue({ indexed: false, checkedAt: new Date() }),
  };
}

/** Build a ChannelRegistry stub wrapping the given connector. */
function makeRegistryStub(
  connector: ReturnType<typeof makeConnectorReturning>
): ChannelRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(connector),
    readiness: vi.fn().mockReturnValue([
      { channelClass: CHANNEL_CLASS, status: "ready", capabilities: ["publish"] },
    ]),
  } as unknown as ChannelRegistry;
}

/** Minimal valid PublishUnitPayload (real publish — dryRun:false). */
const payload: PublishUnitPayload = {
  queueId: QUEUE_ID,
  assetId: ASSET_ID,
  channelClass: CHANNEL_CLASS,
  dryRun: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("publishUnit §0 dispatch-level blocklist: publishedUrl on blocklist → NOT published", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTakeFirst.mockResolvedValue(eligibleRow);
    mockMarkUrlRegistryPublished.mockResolvedValue(undefined);
    mockMarkUrlRegistryFailed.mockResolvedValue(undefined);
    mockMarkDeployStatus.mockResolvedValue(undefined);
    // Claim succeeds (this worker won the slot)
    mockClaimUrlRegistry.mockResolvedValue({
      claimed: true,
      registryId: REGISTRY_ID,
    });
  });

  it("does NOT call markUrlRegistryPublished when publishedUrl is on the blocklist", async () => {
    // Connector returns a publishedUrl whose host is on CUSTOMER_DOMAIN_BLOCKLIST
    const connector = makeConnectorReturning("https://customer-blocked.com/en/my-page/");
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    await publishUnit(payload, queue, registry);

    // The published URL should NOT be persisted as 'published'
    expect(mockMarkUrlRegistryPublished).not.toHaveBeenCalled();
  });

  it("marks url_registry 'failed' (rollback) when publishedUrl is on the blocklist", async () => {
    const connector = makeConnectorReturning("https://customer-blocked.com/en/my-page/");
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    await publishUnit(payload, queue, registry);

    // The claimed 'publishing' registry row must be rolled back to 'failed'
    expect(mockMarkUrlRegistryFailed).toHaveBeenCalledWith(REGISTRY_ID);
  });

  it("marks queue row 'failed' (DLQ path) when publishedUrl is on the blocklist", async () => {
    const connector = makeConnectorReturning("https://customer-blocked.com/en/my-page/");
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    await publishUnit(payload, queue, registry);

    // Queue row must be marked 'failed' — permanent violation; DLQ via deadLetter
    expect(mockMarkDeployStatus).toHaveBeenCalledWith(QUEUE_ID, "failed");
  });

  it("does NOT enqueue publish.verify when publishedUrl is on the blocklist", async () => {
    const connector = makeConnectorReturning("https://customer-blocked.com/en/my-page/");
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    await publishUnit(payload, queue, registry);

    // No verify job should be queued for a blocked publish
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("blocks a subdomain of a blocklisted host (sub.customer-blocked.com)", async () => {
    // "sub.customer-blocked.com" should be blocked because "customer-blocked.com" is on the list
    const connector = makeConnectorReturning("https://sub.customer-blocked.com/en/my-page/");
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    await publishUnit(payload, queue, registry);

    expect(mockMarkUrlRegistryPublished).not.toHaveBeenCalled();
    expect(mockMarkUrlRegistryFailed).toHaveBeenCalledWith(REGISTRY_ID);
    expect(mockMarkDeployStatus).toHaveBeenCalledWith(QUEUE_ID, "failed");
  });

  it("blocks the second entry in the blocklist (evil-customer.net)", async () => {
    const connector = makeConnectorReturning("https://evil-customer.net/page/");
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    await publishUnit(payload, queue, registry);

    expect(mockMarkUrlRegistryPublished).not.toHaveBeenCalled();
    expect(mockMarkUrlRegistryFailed).toHaveBeenCalledWith(REGISTRY_ID);
    expect(mockMarkDeployStatus).toHaveBeenCalledWith(QUEUE_ID, "failed");
  });

  it("allows publish and marks published when publishedUrl is NOT on the blocklist", async () => {
    // This URL's host is not on the blocklist → normal success path
    const connector = makeConnectorReturning("https://hub.example.com/en/my-page/");
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    await publishUnit(payload, queue, registry);

    // Should proceed to markUrlRegistryPublished and markDeployStatus('published')
    expect(mockMarkUrlRegistryPublished).toHaveBeenCalledWith(
      expect.objectContaining({ registryId: REGISTRY_ID })
    );
    expect(mockMarkDeployStatus).toHaveBeenCalledWith(QUEUE_ID, "published");
    expect(mockMarkUrlRegistryFailed).not.toHaveBeenCalled();
  });

  it("resolves without throwing (DLQ is handled by pg-boss deadLetter, not by throw)", async () => {
    // The blocklist violation is a permanent error — publishUnit must resolve, not throw
    const connector = makeConnectorReturning("https://customer-blocked.com/en/my-page/");
    const registry = makeRegistryStub(connector);
    const queue = makeQueueStub();

    // Should NOT throw
    await expect(publishUnit(payload, queue, registry)).resolves.toBeUndefined();
  });
});
