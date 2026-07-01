/**
 * test/deploy/registry-subset-channel-enum.test.ts
 *
 * T17 — Connector/registry/§7#3 tests.
 *
 * Assert: registry key set ⊆ ChannelClass ⊆ content_asset channel_class CHECK.
 *
 * The SINGLE source of truth for legal channel classes is the content_asset
 * channel_class CHECK constraint (migration 0009/0010). ChannelClass (the type
 * exported from connector.ts) mirrors that CHECK exactly. The registry only
 * registers connectors for channels in ChannelClass. This three-way ⊆ assertion
 * prevents drift between the deploy layer and the DB schema.
 *
 * Covers:
 *   - CHANNEL_CLASSES runtime array exactly equals the content_asset DB CHECK set.
 *   - Every connector registered in the registry has channelClass ∈ CHANNEL_CLASSES.
 *   - registry.readiness() only returns channels that are in CHANNEL_CLASSES.
 *   - 'community' and 'review' are NOT in CHANNEL_CLASSES.
 *   - buildConnectorRegistry wires all 6 channels (owned_net + 5 stubs).
 *
 * SPEC §7#3, §8.
 * DESIGN-phase3.md §"Connector Abstraction", §"Structural §7#3 exclusion".
 */

import { describe, it, expect } from "vitest";

import { CHANNEL_CLASSES } from "../../src/deploy/connector.js";
import type { ChannelClass } from "../../src/deploy/connector.js";
import {
  buildConnectorRegistry,
  createChannelRegistry,
} from "../../src/deploy/registry.js";
import { makeStubConnector } from "../../src/deploy/connectors/stub.js";
import { prWireConnector } from "../../src/deploy/connectors/prWire.js";
import { directoryConnector } from "../../src/deploy/connectors/directory.js";
import { web2Connector } from "../../src/deploy/connectors/web2.js";
import { socialConnector } from "../../src/deploy/connectors/social.js";
import { entityConnector } from "../../src/deploy/connectors/entity.js";

// ---------------------------------------------------------------------------
// The authoritative DB CHECK set — mirrors content_asset channel_class CHECK
// (migration 0009 + 0010). This is the single source of truth.
// ---------------------------------------------------------------------------

const DB_CHANNEL_CLASS_CHECK: readonly string[] = [
  "owned_net",
  "pr_wire",
  "directory",
  "web2",
  "social",
  "entity",
] as const;

// ---------------------------------------------------------------------------
// 1. CHANNEL_CLASSES runtime array ⊆ DB_CHANNEL_CLASS_CHECK (and vice versa)
// ---------------------------------------------------------------------------

describe("CHANNEL_CLASSES runtime array mirrors content_asset DB CHECK", () => {
  it("every value in CHANNEL_CLASSES is in the DB CHECK set", () => {
    for (const cc of CHANNEL_CLASSES) {
      expect(DB_CHANNEL_CLASS_CHECK).toContain(cc);
    }
  });

  it("every value in the DB CHECK set is in CHANNEL_CLASSES", () => {
    for (const cc of DB_CHANNEL_CLASS_CHECK) {
      expect(CHANNEL_CLASSES as readonly string[]).toContain(cc);
    }
  });

  it("CHANNEL_CLASSES has exactly 6 values (no extras, no missing)", () => {
    expect(CHANNEL_CLASSES).toHaveLength(6);
  });

  it("CHANNEL_CLASSES contains all 6 expected channel classes", () => {
    const expected: ChannelClass[] = [
      "owned_net",
      "pr_wire",
      "directory",
      "web2",
      "social",
      "entity",
    ];
    for (const cc of expected) {
      expect(CHANNEL_CLASSES).toContain(cc);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 'community' and 'review' are NOT in CHANNEL_CLASSES (§7#3 structural exclusion)
// ---------------------------------------------------------------------------

describe("community and review are NOT in CHANNEL_CLASSES", () => {
  it("'community' is not in CHANNEL_CLASSES", () => {
    expect(CHANNEL_CLASSES as readonly string[]).not.toContain("community");
  });

  it("'review' is not in CHANNEL_CLASSES", () => {
    expect(CHANNEL_CLASSES as readonly string[]).not.toContain("review");
  });

  it("'community' is not in the DB CHECK set", () => {
    expect(DB_CHANNEL_CLASS_CHECK).not.toContain("community");
  });

  it("'review' is not in the DB CHECK set", () => {
    expect(DB_CHANNEL_CLASS_CHECK).not.toContain("review");
  });
});

// ---------------------------------------------------------------------------
// 3. All external connector channelClass values are in CHANNEL_CLASSES
// ---------------------------------------------------------------------------

describe("external connector channelClass values ⊆ CHANNEL_CLASSES", () => {
  const externalConnectors = [
    prWireConnector,
    directoryConnector,
    web2Connector,
    socialConnector,
    entityConnector,
  ];

  it("every external connector's channelClass is in CHANNEL_CLASSES", () => {
    for (const connector of externalConnectors) {
      expect(CHANNEL_CLASSES as readonly string[]).toContain(connector.channelClass);
    }
  });

  it("prWireConnector.channelClass is 'pr_wire'", () => {
    expect(prWireConnector.channelClass).toBe("pr_wire");
    expect(CHANNEL_CLASSES).toContain(prWireConnector.channelClass);
  });

  it("directoryConnector.channelClass is 'directory'", () => {
    expect(directoryConnector.channelClass).toBe("directory");
    expect(CHANNEL_CLASSES).toContain(directoryConnector.channelClass);
  });

  it("web2Connector.channelClass is 'web2'", () => {
    expect(web2Connector.channelClass).toBe("web2");
    expect(CHANNEL_CLASSES).toContain(web2Connector.channelClass);
  });

  it("socialConnector.channelClass is 'social'", () => {
    expect(socialConnector.channelClass).toBe("social");
    expect(CHANNEL_CLASSES).toContain(socialConnector.channelClass);
  });

  it("entityConnector.channelClass is 'entity'", () => {
    expect(entityConnector.channelClass).toBe("entity");
    expect(CHANNEL_CLASSES).toContain(entityConnector.channelClass);
  });
});

// ---------------------------------------------------------------------------
// 4. ChannelRegistry key set ⊆ CHANNEL_CLASSES
// ---------------------------------------------------------------------------

describe("ChannelRegistry key set ⊆ CHANNEL_CLASSES", () => {
  it("createChannelRegistry starts empty — readiness() returns []", () => {
    const registry = createChannelRegistry();
    expect(registry.readiness()).toHaveLength(0);
  });

  it("readiness() after registering all connectors reports only CHANNEL_CLASSES members", () => {
    const allConnectors = [
      makeStubConnector("owned_net", ["publish", "update", "unpublish", "confirm_indexing"]),
      prWireConnector,
      directoryConnector,
      web2Connector,
      socialConnector,
      entityConnector,
    ];
    const registry = buildConnectorRegistry(allConnectors);
    const readiness = registry.readiness();

    for (const r of readiness) {
      expect(CHANNEL_CLASSES as readonly string[]).toContain(r.channelClass);
    }
  });

  it("readiness() reports exactly 6 channels when all 6 connectors are wired", () => {
    const allConnectors = [
      makeStubConnector("owned_net"),
      prWireConnector,
      directoryConnector,
      web2Connector,
      socialConnector,
      entityConnector,
    ];
    const registry = buildConnectorRegistry(allConnectors);
    expect(registry.readiness()).toHaveLength(6);
  });

  it("readiness() channel classes form a subset of CHANNEL_CLASSES", () => {
    const allConnectors = [
      makeStubConnector("owned_net"),
      prWireConnector,
      directoryConnector,
      web2Connector,
      socialConnector,
      entityConnector,
    ];
    const registry = buildConnectorRegistry(allConnectors);
    const registeredChannels = registry.readiness().map((r) => r.channelClass);

    for (const cc of registeredChannels) {
      expect(CHANNEL_CLASSES as readonly string[]).toContain(cc);
    }
  });

  it("a partially wired registry (only owned_net) still has its channel ⊆ CHANNEL_CLASSES", () => {
    const registry = buildConnectorRegistry([
      makeStubConnector("owned_net"),
    ]);
    const readiness = registry.readiness();
    expect(readiness).toHaveLength(1);
    expect(CHANNEL_CLASSES).toContain(readiness[0]!.channelClass);
  });
});

// ---------------------------------------------------------------------------
// 5. buildConnectorRegistry — registry.get() returns a connector for every
//    CHANNEL_CLASSES member
// ---------------------------------------------------------------------------

describe("buildConnectorRegistry — get() for all CHANNEL_CLASSES members", () => {
  const allConnectors = [
    makeStubConnector("owned_net"),
    prWireConnector,
    directoryConnector,
    web2Connector,
    socialConnector,
    entityConnector,
  ];

  it("registry.get() returns a connector (not undefined) for every CHANNEL_CLASSES member", () => {
    const registry = buildConnectorRegistry(allConnectors);
    for (const cc of CHANNEL_CLASSES) {
      const connector = registry.get(cc);
      expect(connector).toBeDefined();
    }
  });

  it("registry.get() for a registered channel returns the registered connector", () => {
    const registry = buildConnectorRegistry(allConnectors);
    const connector = registry.get("pr_wire");
    // It should be the same instance we registered
    expect(connector.channelClass).toBe("pr_wire");
  });
});
