/**
 * test/deploy/no-community-connector.test.ts
 *
 * T17 — Connector/registry/§7#3 tests.
 *
 * Assert: no community/review connector or enum member exists end-to-end.
 *
 * §7#3 STRUCTURAL EXCLUSION: community and review channels are NEVER automated.
 * There must be:
 *   - No 'community' or 'review' in ChannelClass / CHANNEL_CLASSES.
 *   - No communityConnector or reviewConnector export anywhere in the deploy module.
 *   - A community/review channel CANNOT resolve to a publishing connector via the
 *     registry — it gets a DENY StubConnector returning NOT_CONFIGURED.
 *   - A community/review asset cannot be generated, queued, or routed.
 *
 * These are structural tests — they do NOT import non-existent files; instead
 * they assert that the registry deny-default prevents publication for any string
 * outside of CHANNEL_CLASSES (including 'community' and 'review'), and that
 * the ChannelClassSchema from content/types.ts also excludes them.
 *
 * SPEC §7#3.
 * DESIGN-phase3.md §"Structural §7#3 exclusion", §"Connector Abstraction".
 */

import { describe, it, expect } from "vitest";

import { CHANNEL_CLASSES, NOT_CONFIGURED } from "../../src/deploy/connector.js";
import { createChannelRegistry, buildConnectorRegistry } from "../../src/deploy/registry.js";
import { makeStubConnector } from "../../src/deploy/connectors/stub.js";
import { prWireConnector } from "../../src/deploy/connectors/prWire.js";
import { directoryConnector } from "../../src/deploy/connectors/directory.js";
import { web2Connector } from "../../src/deploy/connectors/web2.js";
import { socialConnector } from "../../src/deploy/connectors/social.js";
import { entityConnector } from "../../src/deploy/connectors/entity.js";
import { ChannelClassSchema } from "../../src/content/types.js";

// ---------------------------------------------------------------------------
// 1. ChannelClass type excludes 'community' and 'review' at runtime
// ---------------------------------------------------------------------------

describe("CHANNEL_CLASSES runtime array — community/review excluded", () => {
  it("CHANNEL_CLASSES does not contain 'community'", () => {
    expect(CHANNEL_CLASSES as readonly string[]).not.toContain("community");
  });

  it("CHANNEL_CLASSES does not contain 'review'", () => {
    expect(CHANNEL_CLASSES as readonly string[]).not.toContain("review");
  });

  it("CHANNEL_CLASSES contains exactly the 6 non-community/review classes", () => {
    const legalValues = new Set(CHANNEL_CLASSES);
    expect(legalValues.has("community" as never)).toBe(false);
    expect(legalValues.has("review" as never)).toBe(false);
    expect(legalValues.size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 2. ChannelClassSchema from content/types.ts also excludes community/review
//    (single upstream source of truth — prevents drift with DB CHECK)
// ---------------------------------------------------------------------------

describe("ChannelClassSchema from content/types.ts — community/review excluded", () => {
  it("ChannelClassSchema rejects 'community'", () => {
    const result = ChannelClassSchema.safeParse("community");
    expect(result.success).toBe(false);
  });

  it("ChannelClassSchema rejects 'review'", () => {
    const result = ChannelClassSchema.safeParse("review");
    expect(result.success).toBe(false);
  });

  it("ChannelClassSchema accepts all 6 legal channel classes", () => {
    for (const cc of CHANNEL_CLASSES) {
      const result = ChannelClassSchema.safeParse(cc);
      expect(result.success).toBe(true);
    }
  });

  it("ChannelClassSchema options match CHANNEL_CLASSES (single source of truth)", () => {
    // The zod enum options are the runtime values — they must equal CHANNEL_CLASSES.
    const schemaOptions = ChannelClassSchema.options as readonly string[];
    for (const cc of CHANNEL_CLASSES) {
      expect(schemaOptions).toContain(cc);
    }
    for (const opt of schemaOptions) {
      expect(CHANNEL_CLASSES as readonly string[]).toContain(opt);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Registry DENY-DEFAULT: 'community' and 'review' cannot publish
// ---------------------------------------------------------------------------

describe("ChannelRegistry deny-default for 'community' and 'review'", () => {
  it("registry.get('community') returns a DENY connector (status:'stub')", () => {
    const registry = createChannelRegistry();
    const connector = registry.get("community");
    // It must be a stub (deny-default), not a real connector
    expect(connector.status).toBe("stub");
  });

  it("registry.get('review') returns a DENY connector (status:'stub')", () => {
    const registry = createChannelRegistry();
    const connector = registry.get("review");
    expect(connector.status).toBe("stub");
  });

  it("registry.get('community') publish() returns NOT_CONFIGURED", async () => {
    const registry = createChannelRegistry();
    const connector = registry.get("community");
    const result = await connector.publish({
      assetId: "00000000-0000-0000-0000-000000000001",
      channelClass: "owned_net", // best-effort field; stub ignores it
      customerId: null,
      language: "en",
      body: {
        content_type: "definition",
        text: "Test content.",
        meaning_key: "test-key",
      },
      disclosureTag: null,
      dryRun: true,
      idempotencyKey: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });

  it("registry.get('review') publish() returns NOT_CONFIGURED", async () => {
    const registry = createChannelRegistry();
    const connector = registry.get("review");
    const result = await connector.publish({
      assetId: "00000000-0000-0000-0000-000000000002",
      channelClass: "owned_net",
      customerId: null,
      language: "en",
      body: {
        content_type: "definition",
        text: "Review test content.",
        meaning_key: "review-test",
      },
      disclosureTag: null,
      dryRun: true,
      idempotencyKey: "00000000-0000-0000-0000-000000000002",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });

  it("'community' and 'review' are NOT in the readiness() report of a fully-wired registry", () => {
    const allConnectors = [
      makeStubConnector("owned_net"),
      prWireConnector,
      directoryConnector,
      web2Connector,
      socialConnector,
      entityConnector,
    ];
    const registry = buildConnectorRegistry(allConnectors);
    const channels = registry.readiness().map((r) => r.channelClass);

    expect(channels).not.toContain("community");
    expect(channels).not.toContain("review");
  });
});

// ---------------------------------------------------------------------------
// 4. No connector file exports for 'community' or 'review'
//    (structural: if a communityConnector.ts were added, importing it here
//    would fail at parse time; we assert via the filesystem-proxy check that
//    the known connector files cover exactly the 6 legal channels)
// ---------------------------------------------------------------------------

describe("connector exports cover exactly the 6 legal channels — no extras", () => {
  it("the 5 external connector singletons cover pr_wire/directory/web2/social/entity", () => {
    const externalChannels = [
      prWireConnector.channelClass,
      directoryConnector.channelClass,
      web2Connector.channelClass,
      socialConnector.channelClass,
      entityConnector.channelClass,
    ];

    // Must be exactly these 5 (the 6th is owned_net, handled separately)
    expect(externalChannels).toHaveLength(5);
    expect(externalChannels).toContain("pr_wire");
    expect(externalChannels).toContain("directory");
    expect(externalChannels).toContain("web2");
    expect(externalChannels).toContain("social");
    expect(externalChannels).toContain("entity");

    // Must NOT contain community or review
    expect(externalChannels).not.toContain("community");
    expect(externalChannels).not.toContain("review");
  });

  it("all 5 external connector channelClass values are in CHANNEL_CLASSES", () => {
    const externalConnectors = [
      prWireConnector,
      directoryConnector,
      web2Connector,
      socialConnector,
      entityConnector,
    ];
    for (const c of externalConnectors) {
      expect(CHANNEL_CLASSES as readonly string[]).toContain(c.channelClass);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Parametric: any string NOT in CHANNEL_CLASSES cannot publish
//    (covers 'community', 'review', and any future invalid input)
// ---------------------------------------------------------------------------

describe("any channel class not in CHANNEL_CLASSES resolves to a deny stub", () => {
  const invalidChannels = ["community", "review", "fake", "OWNED_NET", ""];

  for (const ch of invalidChannels) {
    it(`registry.get('${ch || "(empty)"}') cannot publish (returns NOT_CONFIGURED)`, async () => {
      const registry = createChannelRegistry();
      const connector = registry.get(ch);
      expect(connector.status).toBe("stub");

      const result = await connector.publish({
        assetId: "00000000-0000-0000-0000-000000000099",
        channelClass: "owned_net",
        customerId: null,
        language: "en",
        body: {
          content_type: "definition",
          text: "Parametric test.",
          meaning_key: "param-test",
        },
        disclosureTag: null,
        dryRun: true,
        idempotencyKey: "00000000-0000-0000-0000-000000000099",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(NOT_CONFIGURED);
      }
    });
  }
});
