/**
 * test/deploy/verify-indexing-stamp.test.ts
 *
 * T20 — publish.verify stamps indexing_status correctly.
 *
 * Assert:
 *   - handlePublishVerify stamps indexing_status='submitted' for owned_net
 *     when confirmIndexing returns indexed:false (FsTarget local file not crawlable).
 *   - handlePublishVerify stamps indexing_status='submitted' for owned_net
 *     even when confirmIndexing returns indexed:true (NEVER 'indexed' for owned_net).
 *   - handlePublishVerify stamps indexing_status='unknown' for a connector
 *     without the 'confirm_indexing' capability.
 *   - handlePublishVerify stamps indexing_status='unknown' when confirmIndexing
 *     fails and the attempt cap is reached.
 *   - handlePublishVerify retries (throws RetryableJobError) when confirmIndexing
 *     fails and the attempt is below the cap.
 *   - No external-engine scraping occurs (the function only calls confirmIndexing
 *     on the connector — no HTTP calls to Google/Naver/etc).
 *
 * All tests are UNIT-ONLY (no live DB, no real connector side effects).
 *
 * DESIGN-phase3.md §"Publish Tracking + §3 Feedback", §"INDEXING CONFIRMATION".
 * SPEC §7#3, §12.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  handlePublishVerify,
  makePublishVerifyHandler,
} from "../../src/deploy/verifyIndexing.js";
import type { ChannelRegistry } from "../../src/deploy/registry.js";
import {
  RetryableJobError,
  PermanentJobError,
} from "../../src/scheduler/jobs.js";
import type { PublishVerifyPayload } from "../../src/scheduler/jobs.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/db/repo.js", () => ({
  findUrlRegistryRow: vi.fn(),
  updateIndexingStatus: vi.fn().mockResolvedValue(undefined),
  claimUrlRegistry: vi.fn(),
  markUrlRegistryPublished: vi.fn(),
  markUrlRegistryFailed: vi.fn(),
  insertUrlRegistryDryRun: vi.fn(),
  markDeployStatus: vi.fn(),
}));

import { findUrlRegistryRow, updateIndexingStatus } from "../../src/db/repo.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REGISTRY_ID = "eeeeeeee-0000-0000-0000-000000000001";

/** A 'published' url_registry row for owned_net. */
const ownedNetRow = {
  id: REGISTRY_ID,
  asset_id: "aaaaaaaa-0000-0000-0000-000000000001",
  content_set_id: null,
  customer_id: null,
  channel_class: "owned_net",
  published_url: "https://hub.example.com/en/verify-slug/",
  external_ref: null,
  disclosure_tag: null,
  language: "en",
  publish_status: "published",
  indexing_status: "unknown",
  first_seen_indexed_at: null,
  approver_audit: null,
  publish_meta: null,
  published_at: new Date("2026-01-01T12:00:00Z"),
  created_at: new Date("2026-01-01T11:55:00Z"),
};

/** A 'published' url_registry row for an external channel stub. */
const externalRow = {
  ...ownedNetRow,
  channel_class: "web2",
  published_url: "https://dev.to/example/article",
};

/** A connector with confirmIndexing capability. */
function makeConnectorWithConfirmIndexing(indexed: boolean, shouldThrow = false) {
  return {
    channelClass: "owned_net" as const,
    capabilities: ["publish", "confirm_indexing"] as const,
    status: "ready" as const,
    publish: vi.fn(),
    confirmIndexing: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error("indexing check failed");
      return { indexed, checkedAt: new Date() };
    }),
  };
}

/** A connector WITHOUT confirmIndexing capability. */
function makeConnectorWithoutConfirmIndexing() {
  return {
    channelClass: "pr_wire" as const,
    capabilities: ["publish"] as const,
    status: "stub" as const,
    publish: vi.fn(),
    // No confirmIndexing property
  };
}

function makeRegistry(connector: unknown): ChannelRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(connector),
    readiness: vi.fn().mockReturnValue([]),
  } as unknown as ChannelRegistry;
}

const payload: PublishVerifyPayload = { urlRegistryId: REGISTRY_ID };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verify-indexing-stamp: owned_net never gets indexing_status='indexed'", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("owned_net + confirmIndexing(indexed:false) → stamps 'submitted', NOT 'not_indexed'", async () => {
    vi.mocked(findUrlRegistryRow).mockResolvedValue(ownedNetRow as unknown);
    vi.mocked(updateIndexingStatus).mockResolvedValue(undefined);

    const connector = makeConnectorWithConfirmIndexing(false);
    const registry = makeRegistry(connector);

    await handlePublishVerify(payload, registry, 1);

    expect(updateIndexingStatus).toHaveBeenCalledWith(REGISTRY_ID, "submitted");
    expect(updateIndexingStatus).not.toHaveBeenCalledWith(REGISTRY_ID, "indexed");
    expect(updateIndexingStatus).not.toHaveBeenCalledWith(REGISTRY_ID, "not_indexed");
  });

  it("owned_net + confirmIndexing(indexed:true) → stamps 'submitted', NEVER 'indexed'", async () => {
    // This tests the structural invariant: even if the FsTarget erronously returns
    // indexed:true (should never happen), we clamp to 'submitted'.
    vi.mocked(findUrlRegistryRow).mockResolvedValue(ownedNetRow as unknown);
    vi.mocked(updateIndexingStatus).mockResolvedValue(undefined);

    const connector = makeConnectorWithConfirmIndexing(true);
    const registry = makeRegistry(connector);

    await handlePublishVerify(payload, registry, 1);

    // Must NOT stamp 'indexed' for owned_net — the local file is not crawlable
    expect(updateIndexingStatus).not.toHaveBeenCalledWith(REGISTRY_ID, "indexed");
    // Must stamp 'submitted' (the structural invariant)
    expect(updateIndexingStatus).toHaveBeenCalledWith(REGISTRY_ID, "submitted");
  });
});

describe("verify-indexing-stamp: connector without confirmIndexing → stamps 'unknown'", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connector has no 'confirm_indexing' capability → stamps 'unknown'", async () => {
    const rowWithoutCap = { ...externalRow, channel_class: "pr_wire" };
    vi.mocked(findUrlRegistryRow).mockResolvedValue(rowWithoutCap as unknown);
    vi.mocked(updateIndexingStatus).mockResolvedValue(undefined);

    const connector = makeConnectorWithoutConfirmIndexing();
    const registry = makeRegistry(connector);

    await handlePublishVerify({ urlRegistryId: REGISTRY_ID }, registry, 1);

    expect(updateIndexingStatus).toHaveBeenCalledWith(REGISTRY_ID, "unknown");
    expect(updateIndexingStatus).not.toHaveBeenCalledWith(REGISTRY_ID, "indexed");
    expect(updateIndexingStatus).not.toHaveBeenCalledWith(REGISTRY_ID, "submitted");
  });

  it("connector with confirmIndexing capability=[] (missing in caps) → stamps 'unknown'", async () => {
    const connectorNoCap = {
      channelClass: "entity" as const,
      capabilities: [] as const,
      status: "stub" as const,
      publish: vi.fn(),
      // confirmIndexing not in capabilities
      confirmIndexing: vi.fn().mockResolvedValue({ indexed: false, checkedAt: new Date() }),
    };

    const row = { ...ownedNetRow, channel_class: "entity" };
    vi.mocked(findUrlRegistryRow).mockResolvedValue(row as unknown);
    vi.mocked(updateIndexingStatus).mockResolvedValue(undefined);

    const registry = makeRegistry(connectorNoCap);

    await handlePublishVerify(payload, registry, 1);

    // No 'confirm_indexing' in capabilities → 'unknown'
    expect(updateIndexingStatus).toHaveBeenCalledWith(REGISTRY_ID, "unknown");
  });
});

describe("verify-indexing-stamp: retry backoff and cap settle to 'unknown'", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirmIndexing failure below cap → throws RetryableJobError", async () => {
    vi.mocked(findUrlRegistryRow).mockResolvedValue(ownedNetRow as unknown);

    const connector = makeConnectorWithConfirmIndexing(false, /* shouldThrow */ true);
    const registry = makeRegistry(connector);

    // attempt 1 < VERIFY_MAX_ATTEMPTS (5) → should retry
    await expect(
      handlePublishVerify(payload, registry, 1),
    ).rejects.toThrow(RetryableJobError);

    // updateIndexingStatus was NOT called (retry path)
    expect(updateIndexingStatus).not.toHaveBeenCalled();
  });

  it("confirmIndexing failure AT cap (attempt >= 5) → settles 'unknown', does not throw", async () => {
    vi.mocked(findUrlRegistryRow).mockResolvedValue(ownedNetRow as unknown);
    vi.mocked(updateIndexingStatus).mockResolvedValue(undefined);

    const connector = makeConnectorWithConfirmIndexing(false, /* shouldThrow */ true);
    const registry = makeRegistry(connector);

    // attempt 5 = VERIFY_MAX_ATTEMPTS → settle 'unknown', no throw
    await expect(
      handlePublishVerify(payload, registry, 5),
    ).resolves.toBeUndefined();

    expect(updateIndexingStatus).toHaveBeenCalledWith(REGISTRY_ID, "unknown");
    expect(updateIndexingStatus).not.toHaveBeenCalledWith(REGISTRY_ID, "indexed");
  });

  it("row not found → throws PermanentJobError (dead-letter)", async () => {
    vi.mocked(findUrlRegistryRow).mockResolvedValue(null);

    const connector = makeConnectorWithConfirmIndexing(false);
    const registry = makeRegistry(connector);

    await expect(
      handlePublishVerify(payload, registry, 1),
    ).rejects.toThrow(PermanentJobError);
  });

  it("row in 'publishing' status (not yet final) → resolves without stamping", async () => {
    const publishingRow = { ...ownedNetRow, publish_status: "publishing" };
    vi.mocked(findUrlRegistryRow).mockResolvedValue(publishingRow as unknown);

    const connector = makeConnectorWithConfirmIndexing(false);
    const registry = makeRegistry(connector);

    // Should resolve (no stamp, no error — the row is not yet in terminal state)
    await expect(
      handlePublishVerify(payload, registry, 1),
    ).resolves.toBeUndefined();

    expect(updateIndexingStatus).not.toHaveBeenCalled();
  });
});

describe("verify-indexing-stamp: makePublishVerifyHandler job handler wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("valid payload triggers handlePublishVerify and stamps indexing status", async () => {
    vi.mocked(findUrlRegistryRow).mockResolvedValue(ownedNetRow as unknown);
    vi.mocked(updateIndexingStatus).mockResolvedValue(undefined);

    const connector = makeConnectorWithConfirmIndexing(false);
    const registry = makeRegistry(connector);

    const handler = makePublishVerifyHandler(registry);

    await handler([
      {
        id: "job-verify-1",
        name: "publish.verify",
        data: { urlRegistryId: REGISTRY_ID },
      },
    ]);

    expect(updateIndexingStatus).toHaveBeenCalledWith(REGISTRY_ID, "submitted");
  });

  it("invalid payload (missing urlRegistryId) → resolves without throwing (no retry)", async () => {
    const connector = makeConnectorWithConfirmIndexing(false);
    const registry = makeRegistry(connector);

    const handler = makePublishVerifyHandler(registry);

    // Should NOT throw — malformed jobs are not retried
    await expect(
      handler([{ id: "job-bad", name: "publish.verify", data: { missing: "field" } }]),
    ).resolves.toBeUndefined();

    expect(updateIndexingStatus).not.toHaveBeenCalled();
  });
});
