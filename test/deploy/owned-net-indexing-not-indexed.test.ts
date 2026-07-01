/**
 * test/deploy/owned-net-indexing-not-indexed.test.ts
 *
 * T18 — owned_net never reports indexing_status='indexed' for FsTarget.
 *
 * Acceptance criteria:
 *   - confirmIndexing() always returns indexed:false for the OwnedNetConnector
 *     with an FsTarget (local file is NOT publicly crawlable).
 *   - indexing_status for owned_net is 'submitted'/'unknown' only —
 *     NEVER 'indexed' (no false signal into the Phase 0 monitor).
 *   - confirmIndexing returns a checkedAt Date that is recent.
 *   - The 'confirm_indexing' capability is declared in OwnedNetConnector.capabilities.
 *   - No external-engine scraping occurs (the call is a local noop, no HTTP request).
 *
 * DESIGN-phase3.md §"Publish Tracking + §3 Feedback" + §"Owned-Net (real today)"
 * + key decision: "owned_net file-presence maps indexing_status to
 * 'submitted'/'unknown' only — NEVER 'indexed'".
 * SPEC §7#3 (no false signals into monitor), §12 (no raw scraping).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OwnedNetConnector,
  FsTarget,
} from "../../src/deploy/connectors/ownedNet.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConnector(tmpDir: string): OwnedNetConnector {
  const target = new FsTarget(tmpDir, "https://hub.example.com");
  return new OwnedNetConnector(target, "https://hub.example.com", []);
}

// ---------------------------------------------------------------------------
// confirmIndexing() tests
// ---------------------------------------------------------------------------

describe("OwnedNetConnector.confirmIndexing — never reports 'indexed' for FsTarget", () => {
  let tmpDir: string;
  let connector: OwnedNetConnector;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-net-indexing-"));
    connector = makeConnector(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      // ignore cleanup errors
    });
  });

  it("confirmIndexing returns indexed:false for the FsTarget", async () => {
    const result = await connector.confirmIndexing!(
      "https://hub.example.com/en/test-slug/"
    );
    expect(result.indexed).toBe(false);
  });

  it("confirmIndexing returns indexed:false even when the file exists locally", async () => {
    // Write a real page file first (simulating a prior publish)
    const pageDir = path.join(tmpDir, "en", "test-slug");
    await fs.mkdir(pageDir, { recursive: true });
    await fs.writeFile(path.join(pageDir, "index.html"), "<html></html>", "utf-8");

    // File existence on local disk does NOT mean it is publicly indexed
    const result = await connector.confirmIndexing!(
      "https://hub.example.com/en/test-slug/"
    );
    expect(result.indexed).toBe(false);
  });

  it("confirmIndexing returns a checkedAt Date that is current (not null/undefined)", async () => {
    const before = new Date();
    const result = await connector.confirmIndexing!(
      "https://hub.example.com/en/any-slug/"
    );
    const after = new Date();

    expect(result.checkedAt).toBeInstanceOf(Date);
    expect(result.checkedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.checkedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("confirmIndexing is idempotent — repeated calls all return indexed:false", async () => {
    const url = "https://hub.example.com/en/test-slug/";
    const r1 = await connector.confirmIndexing!(url);
    const r2 = await connector.confirmIndexing!(url);
    const r3 = await connector.confirmIndexing!(url);

    expect(r1.indexed).toBe(false);
    expect(r2.indexed).toBe(false);
    expect(r3.indexed).toBe(false);
  });

  it("confirmIndexing performs no network/HTTP call (pure local noop)", async () => {
    // The test verifies this by:
    // 1. Using an obviously-unreachable domain — if any HTTP call were made it would
    //    either throw or take a long time; we cap the test timeout.
    // 2. The call returns instantly (no async delay from network).
    const unreachableUrl = "https://unreachable-fictional-hub-12345.internal/en/slug/";
    const before = Date.now();
    const result = await connector.confirmIndexing!(unreachableUrl);
    const elapsed = Date.now() - before;

    expect(result.indexed).toBe(false);
    // A network call to an unreachable host would take far longer than 1 second
    // (connection timeout) — a pure local noop should be near-instant (<500 ms).
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Connector metadata — 'confirm_indexing' capability declared
// ---------------------------------------------------------------------------

describe("OwnedNetConnector capabilities — confirm_indexing declared", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-net-caps-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      // ignore cleanup errors
    });
  });

  it("OwnedNetConnector declares 'confirm_indexing' in its capabilities array", () => {
    const connector = makeConnector(tmpDir);
    expect(connector.capabilities).toContain("confirm_indexing");
  });

  it("OwnedNetConnector.status is 'ready'", () => {
    const connector = makeConnector(tmpDir);
    expect(connector.status).toBe("ready");
  });

  it("OwnedNetConnector.channelClass is 'owned_net'", () => {
    const connector = makeConnector(tmpDir);
    expect(connector.channelClass).toBe("owned_net");
  });

  it("confirmIndexing method is defined (capability is functional)", async () => {
    const connector = makeConnector(tmpDir);
    expect(typeof connector.confirmIndexing).toBe("function");
    // Calling it does not throw
    await expect(
      connector.confirmIndexing!("https://hub.example.com/en/slug/")
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// indexing_status mapping — 'submitted'/'unknown' only, never 'indexed'
// ---------------------------------------------------------------------------

describe("indexing_status mapping — file-presence maps to submitted/unknown only", () => {
  /**
   * This test models the publish.verify handler logic (T14):
   *
   *   if (connector.confirmIndexing) {
   *     const { indexed } = await connector.confirmIndexing(publishedUrl);
   *     // owned_net FsTarget always returns indexed:false
   *     // → indexing_status = 'submitted' (file exists) or 'unknown'
   *     // → NEVER 'indexed'
   *   }
   *
   * We assert the decision table here without requiring T14's full handler.
   */

  it("indexed:false → indexing_status must be 'submitted' or 'unknown', never 'indexed'", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-net-status-"));
    try {
      const connector = makeConnector(tmpDir);
      const { indexed } = await connector.confirmIndexing!(
        "https://hub.example.com/en/slug/"
      );

      // The verifyIndexing handler maps indexed:false to 'submitted' (when file
      // present) or 'unknown'. It MUST NOT map to 'indexed'.
      const allowedStatuses = new Set(["submitted", "unknown"]);

      // Simulate the mapping the handler would do:
      // indexing_status = indexed ? 'indexed' : (filePresent ? 'submitted' : 'unknown')
      // Since indexed is always false for FsTarget, 'indexed' is unreachable.
      const derivedStatus = indexed ? "indexed" : "submitted";

      expect(allowedStatuses.has(derivedStatus)).toBe(true);
      expect(derivedStatus).not.toBe("indexed");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("a full publish then confirmIndexing still yields indexed:false (not indexed even after write)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-net-post-publish-"));
    try {
      const target = new FsTarget(tmpDir, "https://hub.example.com");
      const connector = new OwnedNetConnector(target, "https://hub.example.com", []);

      // Perform a real publish
      const publishResult = await connector.publish({
        assetId: "indexing-post-publish-test",
        channelClass: "owned_net",
        customerId: null,
        language: "en",
        body: {
          content_type: "definition",
          text: "EMORA is an AI character chat platform.",
          meaning_key: "emora-def",
        },
        disclosureTag: null,
        dryRun: false,
        idempotencyKey: "indexing-post-publish-test",
      });

      expect(publishResult.ok).toBe(true);

      // Now confirm indexing — must still return indexed:false even after real file write
      const indexResult = await connector.confirmIndexing!(
        "https://hub.example.com/en/emora-def/"
      );
      expect(indexResult.indexed).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
