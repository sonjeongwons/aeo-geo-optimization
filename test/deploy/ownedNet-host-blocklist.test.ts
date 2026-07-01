/**
 * test/deploy/ownedNet-host-blocklist.test.ts
 *
 * T18 — §0 CUSTOMER_DOMAIN_BLOCKLIST fail-closed host guard.
 *
 * Acceptance criteria:
 *   - A resolved URL whose host is on the blocklist returns PublishError
 *     BEFORE any file is written (fail-closed).
 *   - A resolved URL whose host is NOT on the blocklist is allowed.
 *   - Subdomain matching: blocked host "example.com" also blocks "sub.example.com".
 *   - An empty blocklist allows all hosts (defensive default).
 *   - The guard fires for dry-run and real publish alike.
 *
 * DESIGN-phase3.md §"Owned-Net (real today)" step 1. SPEC §0.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertNotBlocklisted,
  OwnedNetConnector,
  FsTarget,
} from "../../src/deploy/connectors/ownedNet.js";
import type { PublishRequest } from "../../src/deploy/connector.js";

// ---------------------------------------------------------------------------
// assertNotBlocklisted unit tests (pure, no IO)
// ---------------------------------------------------------------------------

describe("assertNotBlocklisted — pure host blocklist guard", () => {
  it("returns null (safe) when blocklist is empty", () => {
    const err = assertNotBlocklisted("https://hub.emora.example.com/en/slug/", []);
    expect(err).toBeNull();
  });

  it("returns null when host is NOT on the blocklist", () => {
    const err = assertNotBlocklisted(
      "https://hub.emora.example.com/en/slug/",
      ["customer-domain.com", "evil.com"]
    );
    expect(err).toBeNull();
  });

  it("returns PublishError when host exactly matches a blocklisted host", () => {
    const err = assertNotBlocklisted(
      "https://customer-domain.com/page",
      ["customer-domain.com"]
    );
    expect(err).not.toBeNull();
    expect(err?.ok).toBe(false);
    expect(err?.code).toBe("BLOCKED");
    expect(err?.retryable).toBe(false);
    expect(err?.message).toContain("customer-domain.com");
    expect(err?.message).toContain("CUSTOMER_DOMAIN_BLOCKLIST");
  });

  it("blocks a subdomain of a blocklisted host (sub.example.com when example.com is blocked)", () => {
    const err = assertNotBlocklisted(
      "https://sub.customer-domain.com/page",
      ["customer-domain.com"]
    );
    expect(err).not.toBeNull();
    expect(err?.ok).toBe(false);
    expect(err?.code).toBe("BLOCKED");
  });

  it("does NOT block a domain that only contains the blocklisted string as a substring prefix", () => {
    // "customer-domain.com" should NOT block "notcustomer-domain.com"
    const err = assertNotBlocklisted(
      "https://notcustomer-domain.com/page",
      ["customer-domain.com"]
    );
    // This should not be blocked because "notcustomer-domain.com" !== "customer-domain.com"
    // and it does not end with ".customer-domain.com"
    expect(err).toBeNull();
  });

  it("is case-insensitive (blocklist stored lowercase, host compared lowercase)", () => {
    const err = assertNotBlocklisted(
      "https://CUSTOMER-DOMAIN.COM/page",  // uppercase
      ["customer-domain.com"]              // lowercase in blocklist
    );
    expect(err).not.toBeNull();
    expect(err?.code).toBe("BLOCKED");
  });

  it("returns PublishError for an invalid URL string", () => {
    const err = assertNotBlocklisted("not-a-valid-url", ["example.com"]);
    expect(err).not.toBeNull();
    expect(err?.ok).toBe(false);
    expect(err?.code).toBe("BLOCKED");
    expect(err?.message).toContain("not a valid URL");
  });

  it("checks all entries in a multi-entry blocklist", () => {
    const blocklist = ["safe.com", "also-safe.com", "blocked-host.com"];
    const err = assertNotBlocklisted("https://blocked-host.com/page", blocklist);
    expect(err).not.toBeNull();
    expect(err?.code).toBe("BLOCKED");
  });
});

// ---------------------------------------------------------------------------
// OwnedNetConnector.publish() — blocklist integration (fail-closed before write)
// ---------------------------------------------------------------------------

describe("OwnedNetConnector — blocklist guard fires before any file write", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-net-blocklist-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      // ignore cleanup errors
    });
  });

  function makeConnector(blocklist: string[]): OwnedNetConnector {
    const target = new FsTarget(tmpDir, "https://hub.emora.example.com");
    return new OwnedNetConnector(
      target,
      "https://hub.emora.example.com",
      blocklist
    );
  }

  function makeReq(overrides: Partial<PublishRequest> = {}): PublishRequest {
    return {
      assetId: "blocklist-test-asset-0001",
      channelClass: "owned_net",
      customerId: null,
      language: "en",
      body: {
        content_type: "answer_block",
        text: "EMORA is an AI character chat platform with multilingual support.",
        length_units: 11,
        numeric_claim_ids: [],
        source_ids: [],
      },
      disclosureTag: null,
      dryRun: false,
      idempotencyKey: "blocklist-test-asset-0001",
      ...overrides,
    };
  }

  it("returns PublishError(BLOCKED) when hubBaseUrl resolves to a blocklisted host", async () => {
    // The connector's hubBaseUrl IS the blocklisted host.
    // This tests that the §0 defense-in-depth guard blocks even if config is wrong.
    const target = new FsTarget(tmpDir, "https://hub.emora.example.com");
    // Block our own hub — artificial test of the guard path.
    const connector = new OwnedNetConnector(
      target,
      "https://hub.emora.example.com",
      ["hub.emora.example.com"]  // explicitly block our hub URL for this test
    );

    const result = await connector.publish(makeReq({ dryRun: false }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BLOCKED");
      expect("retryable" in result && result.retryable).toBe(false);
    }
  });

  it("writes NO file when the blocklist guard fires (fail-closed before any write)", async () => {
    const target = new FsTarget(tmpDir, "https://blocked-hub.example.com");
    const connector = new OwnedNetConnector(
      target,
      "https://blocked-hub.example.com",
      ["blocked-hub.example.com"]
    );

    const result = await connector.publish(makeReq({ dryRun: false }));

    expect(result.ok).toBe(false);
    expect(result.code).toBe("BLOCKED");

    // Confirm no files were written (outDir should be empty)
    const files = await fs.readdir(tmpDir);
    expect(files).toHaveLength(0);
  });

  it("blocklist guard also fires in dry-run mode (before even computing the dry result)", async () => {
    const target = new FsTarget(tmpDir, "https://blocked-hub.example.com");
    const connector = new OwnedNetConnector(
      target,
      "https://blocked-hub.example.com",
      ["blocked-hub.example.com"]
    );

    const result = await connector.publish(makeReq({ dryRun: true }));

    // Even in dry-run, the blocklist guard fires (fail-closed) before returning dry result.
    // The blocklist check happens before the dryRun check in the connector.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BLOCKED");
    }
  });

  it("allows publish when the hubBaseUrl host is NOT on the blocklist", async () => {
    const connector = makeConnector(["other-blocked.com", "another.com"]);
    const result = await connector.publish(makeReq({ dryRun: true }));

    // Should not be blocked — hub.emora.example.com is not on the blocklist
    expect(result.ok).toBe(true);
    if (result.ok && "dryRun" in result) {
      expect(result.plannedUrl).toContain("hub.emora.example.com");
    }
  });

  it("blocks a subdomain of a blocklisted domain", async () => {
    // Connector uses "hub.emora.example.com" — block "emora.example.com" (parent)
    const target = new FsTarget(tmpDir, "https://hub.emora.example.com");
    const connector = new OwnedNetConnector(
      target,
      "https://hub.emora.example.com",
      ["emora.example.com"]  // parent domain — subdomain "hub.emora.example.com" should be blocked
    );

    const result = await connector.publish(makeReq({ dryRun: false }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BLOCKED");
    }

    // No files written
    const files = await fs.readdir(tmpDir);
    expect(files).toHaveLength(0);
  });
});
