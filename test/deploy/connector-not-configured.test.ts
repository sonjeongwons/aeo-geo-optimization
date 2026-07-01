/**
 * test/deploy/connector-not-configured.test.ts
 *
 * T17 — Connector/registry/§7#3 tests.
 *
 * Assert: stub connectors return NOT_CONFIGURED from publish().
 *
 * Covers:
 *   - Every external channel stub (prWire, directory, web2, social, entity)
 *     returns { ok:false, code:NOT_CONFIGURED } from publish().
 *   - The generic StubConnector factory (makeStubConnector) also returns
 *     NOT_CONFIGURED from publish().
 *   - NOT_CONFIGURED is the exact typed value re-exported from providers/types.ts.
 *
 * SPEC §0, §7#3, §8.
 * DESIGN-phase3.md §"External Channels (stubs)", §"Connector Abstraction".
 */

import { describe, it, expect } from "vitest";

import { NOT_CONFIGURED } from "../../src/deploy/connector.js";
import { makeStubConnector } from "../../src/deploy/connectors/stub.js";
import { prWireConnector } from "../../src/deploy/connectors/prWire.js";
import { directoryConnector } from "../../src/deploy/connectors/directory.js";
import { web2Connector } from "../../src/deploy/connectors/web2.js";
import { socialConnector } from "../../src/deploy/connectors/social.js";
import { entityConnector } from "../../src/deploy/connectors/entity.js";
import type { PublishRequest } from "../../src/deploy/connector.js";

// ---------------------------------------------------------------------------
// Minimal PublishRequest for testing — dryRun:true, all required fields present
// ---------------------------------------------------------------------------

function makePublishRequest(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    assetId: "00000000-0000-0000-0000-000000000001",
    channelClass: "owned_net",
    customerId: null,
    language: "en",
    body: {
      content_type: "definition",
      text: "Test definition.",
      meaning_key: "test-key",
    },
    disclosureTag: null,
    dryRun: true,
    idempotencyKey: "00000000-0000-0000-0000-000000000001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. NOT_CONFIGURED sentinel value
// ---------------------------------------------------------------------------

describe("NOT_CONFIGURED sentinel", () => {
  it("is the string literal 'NOT_CONFIGURED'", () => {
    expect(NOT_CONFIGURED).toBe("NOT_CONFIGURED");
  });

  it("is the same value re-exported from providers/types.ts (single source of truth)", async () => {
    const { NOT_CONFIGURED: providerNC } = await import("../../src/providers/types.js");
    expect(NOT_CONFIGURED).toBe(providerNC);
    expect(NOT_CONFIGURED).toBe("NOT_CONFIGURED");
  });
});

// ---------------------------------------------------------------------------
// 2. Generic StubConnector factory
// ---------------------------------------------------------------------------

describe("makeStubConnector — generic stub factory", () => {
  it("returns status:'stub'", () => {
    const stub = makeStubConnector("pr_wire");
    expect(stub.status).toBe("stub");
  });

  it("publish() returns { ok:false, code:NOT_CONFIGURED }", async () => {
    const stub = makeStubConnector("pr_wire");
    const result = await stub.publish(makePublishRequest({ channelClass: "pr_wire" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });

  it("unpublish() returns { ok:false, code:NOT_CONFIGURED }", async () => {
    const stub = makeStubConnector("web2");
    expect(stub.unpublish).toBeDefined();
    const result = await stub.unpublish!("some-ref");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });

  it("does not throw even when called with dryRun:false", async () => {
    const stub = makeStubConnector("social");
    const result = await stub.publish(
      makePublishRequest({ channelClass: "social", dryRun: false })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. prWireConnector — external stub
// ---------------------------------------------------------------------------

describe("prWireConnector stub", () => {
  it("has status:'stub'", () => {
    expect(prWireConnector.status).toBe("stub");
  });

  it("has channelClass 'pr_wire'", () => {
    expect(prWireConnector.channelClass).toBe("pr_wire");
  });

  it("has 'publish' capability", () => {
    expect(prWireConnector.capabilities).toContain("publish");
  });

  it("publish() returns { ok:false, code:NOT_CONFIGURED }", async () => {
    const result = await prWireConnector.publish(
      makePublishRequest({ channelClass: "pr_wire" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. directoryConnector — external stub
// ---------------------------------------------------------------------------

describe("directoryConnector stub", () => {
  it("has status:'stub'", () => {
    expect(directoryConnector.status).toBe("stub");
  });

  it("has channelClass 'directory'", () => {
    expect(directoryConnector.channelClass).toBe("directory");
  });

  it("has 'publish' capability", () => {
    expect(directoryConnector.capabilities).toContain("publish");
  });

  it("publish() returns { ok:false, code:NOT_CONFIGURED }", async () => {
    const result = await directoryConnector.publish(
      makePublishRequest({ channelClass: "directory" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. web2Connector — external stub
// ---------------------------------------------------------------------------

describe("web2Connector stub", () => {
  it("has status:'stub'", () => {
    expect(web2Connector.status).toBe("stub");
  });

  it("has channelClass 'web2'", () => {
    expect(web2Connector.channelClass).toBe("web2");
  });

  it("has 'publish' and 'update' capabilities", () => {
    expect(web2Connector.capabilities).toContain("publish");
    expect(web2Connector.capabilities).toContain("update");
  });

  it("publish() returns { ok:false, code:NOT_CONFIGURED }", async () => {
    const result = await web2Connector.publish(
      makePublishRequest({ channelClass: "web2" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. socialConnector — external stub
// ---------------------------------------------------------------------------

describe("socialConnector stub", () => {
  it("has status:'stub'", () => {
    expect(socialConnector.status).toBe("stub");
  });

  it("has channelClass 'social'", () => {
    expect(socialConnector.channelClass).toBe("social");
  });

  it("has 'publish' capability", () => {
    expect(socialConnector.capabilities).toContain("publish");
  });

  it("publish() returns { ok:false, code:NOT_CONFIGURED }", async () => {
    const result = await socialConnector.publish(
      makePublishRequest({ channelClass: "social" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. entityConnector — external stub with NO 'publish' capability
// ---------------------------------------------------------------------------

describe("entityConnector stub", () => {
  it("has status:'stub'", () => {
    expect(entityConnector.status).toBe("stub");
  });

  it("has channelClass 'entity'", () => {
    expect(entityConnector.channelClass).toBe("entity");
  });

  it("has NO 'publish' capability (capabilities is empty [])", () => {
    expect(entityConnector.capabilities).not.toContain("publish");
    expect(entityConnector.capabilities).toHaveLength(0);
  });

  it("publish() returns { ok:false, code:NOT_CONFIGURED }", async () => {
    const result = await entityConnector.publish(
      makePublishRequest({ channelClass: "entity" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. All external stubs return NOT_CONFIGURED — parametric check
// ---------------------------------------------------------------------------

describe("all external stub connectors return NOT_CONFIGURED", () => {
  const stubs = [
    { name: "prWire",    connector: prWireConnector,    channelClass: "pr_wire" as const },
    { name: "directory", connector: directoryConnector, channelClass: "directory" as const },
    { name: "web2",      connector: web2Connector,      channelClass: "web2" as const },
    { name: "social",    connector: socialConnector,    channelClass: "social" as const },
    { name: "entity",    connector: entityConnector,    channelClass: "entity" as const },
  ];

  for (const { name, connector, channelClass } of stubs) {
    it(`${name} publish() returns NOT_CONFIGURED`, async () => {
      const result = await connector.publish(makePublishRequest({ channelClass }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(NOT_CONFIGURED);
      }
    });
  }

  it("none of the stubs return ok:true from publish()", async () => {
    for (const { connector, channelClass } of stubs) {
      const result = await connector.publish(makePublishRequest({ channelClass }));
      expect(result.ok).toBe(false);
    }
  });
});
