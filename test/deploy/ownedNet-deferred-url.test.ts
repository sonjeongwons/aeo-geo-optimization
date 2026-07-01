/**
 * test/deploy/ownedNet-deferred-url.test.ts
 *
 * T18 — owned_net §0 structural guarantee: deferred-url token resolution.
 *
 * Acceptance criteria:
 *   - publish() NEVER accepts a free-form URL string.
 *   - Only resolves the {deferred:true, role:'owned_hub'} token against config.
 *   - Slug is derived from body metadata / assetId from the asset row —
 *     not from any field carried in the deferred token.
 *   - publishedUrl is composed deterministically from hubBaseUrl + lang + slug.
 *   - Dry-run produces a plannedUrl with the same deterministic structure.
 *
 * DESIGN-phase3.md §"Owned-Net (real today)" steps 1–2.
 * SPEC §0 off-site, §7#3.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OwnedNetConnector,
  FsTarget,
  deriveSlug,
  resolveOwnedHubUrl,
} from "../../src/deploy/connectors/ownedNet.js";
import type { PublishRequest } from "../../src/deploy/connector.js";
import type { ContentBody } from "../../src/content/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefinitionBody(text: string, meaningKey: string): ContentBody {
  return {
    content_type: "definition",
    text,
    meaning_key: meaningKey,
  };
}

function makePublishRequest(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    assetId: "asset-uuid-1234-5678-abcd-ef0123456789",
    channelClass: "owned_net",
    customerId: null,
    language: "en",
    body: makeDefinitionBody(
      "EMORA is an AI character chat platform.",
      "emora-definition"
    ),
    disclosureTag: null,
    dryRun: true,
    idempotencyKey: "asset-uuid-1234-5678-abcd-ef0123456789",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveOwnedHubUrl unit tests
// ---------------------------------------------------------------------------

describe("resolveOwnedHubUrl — deferred token resolution", () => {
  it("resolves {deferred:true, role:'owned_hub'} against config hubBaseUrl", () => {
    const jsonLd = {
      "@context": "https://schema.org" as const,
      "@type": "Organization" as const,
      name: "EMORA",
      url: { deferred: true as const, role: "owned_hub" as const },
    };
    const result = resolveOwnedHubUrl(
      jsonLd,
      "https://hub.emora.example.com",
      "en",
      "tech-emora-def"
    );
    expect(result).toBe("https://hub.emora.example.com/en/tech-emora-def/");
  });

  it("returns null for a string URL (free-form URL is NOT resolved by owned_net resolver)", () => {
    const jsonLd = {
      "@context": "https://schema.org" as const,
      "@type": "Organization" as const,
      name: "EMORA",
      url: "https://customer.example.com",
    };
    // A string url field is not a deferred token → returns null
    const result = resolveOwnedHubUrl(
      jsonLd,
      "https://hub.emora.example.com",
      "en",
      "tech-emora-def"
    );
    expect(result).toBeNull();
  });

  it("returns null when role is NOT 'owned_hub' (social_profile/entity_page belong to other connectors)", () => {
    const jsonLd = {
      "@context": "https://schema.org" as const,
      "@type": "Organization" as const,
      name: "EMORA",
      url: { deferred: true as const, role: "social_profile" as const },
    };
    const result = resolveOwnedHubUrl(
      jsonLd,
      "https://hub.emora.example.com",
      "en",
      "tech-emora-def"
    );
    expect(result).toBeNull();
  });

  it("returns null when jsonLd is undefined", () => {
    const result = resolveOwnedHubUrl(
      undefined,
      "https://hub.emora.example.com",
      "en",
      "test-slug"
    );
    expect(result).toBeNull();
  });

  it("strips trailing slash from hubBaseUrl before building URL", () => {
    const jsonLd = {
      "@context": "https://schema.org" as const,
      "@type": "Organization" as const,
      name: "EMORA",
      url: { deferred: true as const, role: "owned_hub" as const },
    };
    const result = resolveOwnedHubUrl(
      jsonLd,
      "https://hub.emora.example.com/",  // trailing slash
      "en",
      "tech-slug"
    );
    expect(result).toBe("https://hub.emora.example.com/en/tech-slug/");
    // Confirm no double slash
    expect(result).not.toContain("//en/");
  });

  it("lowercases the language code in the URL path", () => {
    const jsonLd = {
      "@context": "https://schema.org" as const,
      "@type": "Organization" as const,
      name: "EMORA",
      url: { deferred: true as const, role: "owned_hub" as const },
    };
    const result = resolveOwnedHubUrl(
      jsonLd,
      "https://hub.emora.example.com",
      "KO",  // uppercase
      "test-slug"
    );
    expect(result).toContain("/ko/");
  });
});

// ---------------------------------------------------------------------------
// deriveSlug unit tests
// ---------------------------------------------------------------------------

describe("deriveSlug — slug derived from asset row (not from deferred token)", () => {
  it("derives slug from industry + phrasingSeedOrGroupId", () => {
    const slug = deriveSlug({
      industry: "Technology",
      phrasingSeedOrGroupId: "ai-chatbot-definition",
      assetId: "1234-abcd",
    });
    expect(slug).toBe("technology-ai-chatbot-definition");
  });

  it("falls back to first 8 chars of assetId when industry/seed absent", () => {
    const slug = deriveSlug({
      assetId: "abcdef12-uuid-here-0000-xxxx",
    });
    expect(slug).toBe("abcdef12");
  });

  it("sanitizes unsafe URL characters in industry/phrasing", () => {
    const slug = deriveSlug({
      industry: "AI & Machine Learning",
      phrasingSeedOrGroupId: "my phrasing group!",
      assetId: "irrelevant",
    });
    // Spaces → dashes, ampersands → dashes, collapse dashes
    expect(slug).not.toMatch(/[ &!]/);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("truncates slug to 80 characters max", () => {
    const slug = deriveSlug({
      industry: "a".repeat(50),
      phrasingSeedOrGroupId: "b".repeat(50),
      assetId: "does-not-matter",
    });
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  it("slug does NOT include the deferred token content (structural §0)", () => {
    // The deferred token {deferred:true, role:'owned_hub'} carries no slug info.
    // The slug must come from the asset row fields, never from the token itself.
    const slug = deriveSlug({
      industry: "tech",
      phrasingSeedOrGroupId: "emora-def",
      assetId: "asset-id-000",
    });
    expect(slug).not.toContain("deferred");
    expect(slug).not.toContain("owned_hub");
  });
});

// ---------------------------------------------------------------------------
// OwnedNetConnector.publish() — URL construction from config (not free-form)
// ---------------------------------------------------------------------------

describe("OwnedNetConnector — publishedUrl constructed from config only", () => {
  let tmpDir: string;
  let connector: OwnedNetConnector;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-net-test-"));
    const target = new FsTarget(tmpDir, "https://hub.example.com");
    connector = new OwnedNetConnector(target, "https://hub.example.com", []);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      // ignore cleanup errors
    });
  });

  it("dry-run returns plannedUrl built from config hubBaseUrl (not from req body free-form URL)", async () => {
    const req = makePublishRequest({
      assetId: "test-asset-id",
      language: "en",
      dryRun: true,
    });
    const result = await connector.publish(req);
    expect(result.ok).toBe(true);
    if (result.ok && "dryRun" in result) {
      // plannedUrl starts with our config hubBaseUrl, NOT any customer domain
      expect(result.plannedUrl).toMatch(/^https:\/\/hub\.example\.com\//);
      // Should have lang segment
      expect(result.plannedUrl).toContain("/en/");
      // Should NOT contain "customer" or any external domain
      expect(result.plannedUrl).not.toContain("customer");
    } else {
      throw new Error("Expected PublishDryRun result");
    }
  });

  it("real publish returns publishedUrl built from config hubBaseUrl + lang + slug", async () => {
    const req = makePublishRequest({
      assetId: "test-asset-real-0000",
      language: "ko",
      dryRun: false,
    });
    const result = await connector.publish(req);
    expect(result.ok).toBe(true);
    if (result.ok && !("dryRun" in result)) {
      const ok = result as import("../../src/deploy/connector.js").PublishOk;
      expect(ok.publishedUrl).toMatch(/^https:\/\/hub\.example\.com\//);
      expect(ok.publishedUrl).toContain("/ko/");
      // reversible is true for owned_net
      expect(ok.reversible).toBe(true);
    } else {
      throw new Error("Expected PublishOk result");
    }
  });

  it("publishedUrl never contains a free-form URL from req.body", async () => {
    // Even if body somehow contains a URL-like string, the publishedUrl comes only from config
    const req = makePublishRequest({
      assetId: "inject-url-test-000",
      language: "en",
      dryRun: false,
      body: {
        content_type: "answer_block",
        text: "Visit https://customer-domain.com for more info.",
        length_units: 8,
        numeric_claim_ids: [],
        source_ids: [],
      },
    });
    const result = await connector.publish(req);
    if (result.ok && !("dryRun" in result)) {
      const ok = result as import("../../src/deploy/connector.js").PublishOk;
      // The publishedUrl is ONLY from our config, never from body text
      expect(ok.publishedUrl).not.toContain("customer-domain.com");
      expect(ok.publishedUrl).toMatch(/^https:\/\/hub\.example\.com\//);
    }
  });
});
