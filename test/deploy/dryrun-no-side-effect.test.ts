/**
 * test/deploy/dryrun-no-side-effect.test.ts
 *
 * T18 — dry-run produces zero filesystem side effects.
 *
 * Acceptance criteria:
 *   - dryRun:true writes no file (zero filesystem side effects).
 *   - dryRun:true returns PublishDryRun { ok:true, dryRun:true, plannedUrl }.
 *   - plannedUrl is the deterministic URL that WOULD have been published.
 *   - A second dry-run call with the same inputs returns the same plannedUrl (deterministic).
 *   - dryRun:false DOES write a file (contrast).
 *   - The queue row remains re-claimable after a dry-run (no terminal status change).
 *     (This is a logical assertion — the connector itself does not touch the queue;
 *     the assertion is that PublishDryRun is returned, not PublishOk, so the
 *     caller (publishUnit) knows not to mark the row as 'published'.)
 *
 * DESIGN-phase3.md §"Idempotency & Safety" / "DRY-RUN". SPEC §0, §7#5.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OwnedNetConnector,
  FsTarget,
} from "../../src/deploy/connectors/ownedNet.js";
import type { PublishDryRun, PublishOk, PublishRequest } from "../../src/deploy/connector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    assetId: "dryrun-test-asset-00000001",
    channelClass: "owned_net",
    customerId: null,
    language: "en",
    body: {
      content_type: "definition",
      text: "EMORA is an AI character chat platform.",
      meaning_key: "emora-definition",
    },
    disclosureTag: null,
    dryRun: true,  // default is dry-run
    idempotencyKey: "dryrun-test-asset-00000001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OwnedNetConnector dry-run — zero filesystem side effects", () => {
  let tmpDir: string;
  let connector: OwnedNetConnector;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-net-dryrun-"));
    const target = new FsTarget(tmpDir, "https://hub.example.com");
    connector = new OwnedNetConnector(target, "https://hub.example.com", []);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      // ignore cleanup errors
    });
  });

  it("dryRun:true writes no files to the filesystem", async () => {
    const req = makeReq({ dryRun: true });
    const result = await connector.publish(req);

    // Confirm result type
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("dryRun" in result && (result as PublishDryRun).dryRun).toBe(true);
    }

    // Confirm no files were written
    const files = await fs.readdir(tmpDir);
    expect(files).toHaveLength(0);
  });

  it("dryRun:true does NOT create subdirectories", async () => {
    const req = makeReq({ dryRun: true, language: "en" });
    await connector.publish(req);

    // The output directory should still be empty (no lang/slug/ subdirectory created)
    const files = await fs.readdir(tmpDir);
    expect(files).toHaveLength(0);
  });

  it("dryRun:true does NOT write sitemap.xml", async () => {
    const req = makeReq({ dryRun: true });
    await connector.publish(req);

    // No sitemap.xml should exist
    const sitemapPath = path.join(tmpDir, "sitemap.xml");
    await expect(fs.access(sitemapPath)).rejects.toThrow();
  });

  it("dryRun:true returns PublishDryRun with a non-empty plannedUrl", async () => {
    const req = makeReq({ dryRun: true });
    const result = await connector.publish(req);

    expect(result.ok).toBe(true);
    if (result.ok && "dryRun" in result) {
      const dryResult = result as PublishDryRun;
      expect(dryResult.dryRun).toBe(true);
      expect(dryResult.plannedUrl).toBeTruthy();
      expect(dryResult.plannedUrl).toContain("https://hub.example.com");
      expect(dryResult.plannedUrl).toContain("/en/");
    } else {
      throw new Error("Expected PublishDryRun result, got " + JSON.stringify(result));
    }
  });

  it("dryRun:true with same inputs returns the same plannedUrl (deterministic)", async () => {
    const req = makeReq({ dryRun: true });
    const result1 = await connector.publish(req);
    const result2 = await connector.publish(req);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    if (
      result1.ok && "dryRun" in result1 &&
      result2.ok && "dryRun" in result2
    ) {
      expect((result1 as PublishDryRun).plannedUrl).toBe(
        (result2 as PublishDryRun).plannedUrl
      );
    }
  });

  it("multiple dry-runs on the same asset write no files (idempotent no-op)", async () => {
    const req = makeReq({ dryRun: true });
    await connector.publish(req);
    await connector.publish(req);
    await connector.publish(req);

    // Still no files after multiple dry-runs
    const files = await fs.readdir(tmpDir);
    expect(files).toHaveLength(0);
  });

  it("dryRun:false DOES write a file (contrast — confirms the guard is per-call)", async () => {
    const req = makeReq({ dryRun: false });
    const result = await connector.publish(req);

    expect(result.ok).toBe(true);
    // Check it is PublishOk (not PublishDryRun)
    if (result.ok) {
      expect("dryRun" in result).toBe(false);
      const okResult = result as PublishOk;
      expect(okResult.publishedUrl).toContain("https://hub.example.com");
    }

    // At least one file written
    const entries = await getFilesRecursive(tmpDir);
    expect(entries.length).toBeGreaterThan(0);
    // Should have an index.html
    expect(entries.some(f => f.endsWith("index.html"))).toBe(true);
  });

  it("dry-run result is NOT a PublishOk (the caller must not mark queue as 'published')", async () => {
    const req = makeReq({ dryRun: true });
    const result = await connector.publish(req);

    // Confirm this is not a PublishOk (which would trigger queue terminal marking)
    expect(result.ok).toBe(true);
    // PublishDryRun has `dryRun: true` field
    expect("dryRun" in result).toBe(true);
    // PublishOk has `publishedUrl` and `reversible` but no `dryRun`
    expect("publishedUrl" in result).toBe(false);
    expect("reversible" in result).toBe(false);
  });

  it("plannedUrl is URL-safe (no spaces or unsafe characters)", async () => {
    const req = makeReq({ dryRun: true, language: "ko" });
    const result = await connector.publish(req);
    if (result.ok && "dryRun" in result) {
      const { plannedUrl } = result as PublishDryRun;
      // No spaces
      expect(plannedUrl).not.toContain(" ");
      // Starts with https://
      expect(plannedUrl).toMatch(/^https?:\/\//);
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: recursively list files in a directory
// ---------------------------------------------------------------------------

async function getFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const children = await getFilesRecursive(full);
      results.push(...children);
    } else {
      results.push(full);
    }
  }
  return results;
}
