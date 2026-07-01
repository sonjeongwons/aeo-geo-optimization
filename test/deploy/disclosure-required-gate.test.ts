/**
 * test/deploy/disclosure-required-gate.test.ts
 *
 * T19 — Throttle, eligibility, approval, disclosure gate tests.
 *
 * Assert:
 *   - External channel + null disclosure_tag is BLOCKED (fail-closed).
 *   - owned_net + null disclosure_tag is ALLOWED (not a hard gate for OUR hub).
 *   - entity + null disclosure_tag is ALLOWED (entity has no 'publish' capability;
 *     disclosure is moot — gate excluded to avoid double-block).
 *   - requiresDisclosure() returns the correct boolean per channel class.
 *   - assertDisclosure() returns the correct DisclosureCheckResult.
 *   - A non-empty disclosure_tag is allowed on all channels.
 *
 * SPEC §7#6, §8, §12.
 * DESIGN-phase3.md §"Idempotency & Safety" / §"Disclosure (§7#6)".
 */

import { describe, it, expect } from "vitest";

import {
  requiresDisclosure,
  assertDisclosure,
} from "../../src/deploy/disclosureGate.js";
import type { ChannelClass } from "../../src/deploy/connector.js";

// ---------------------------------------------------------------------------
// 1. requiresDisclosure — per-channel boolean predicate
// ---------------------------------------------------------------------------

describe("requiresDisclosure — per-channel boolean", () => {
  it("returns true for pr_wire", () => {
    expect(requiresDisclosure("pr_wire")).toBe(true);
  });

  it("returns true for directory", () => {
    expect(requiresDisclosure("directory")).toBe(true);
  });

  it("returns true for web2", () => {
    expect(requiresDisclosure("web2")).toBe(true);
  });

  it("returns true for social", () => {
    expect(requiresDisclosure("social")).toBe(true);
  });

  it("returns false for owned_net (our controlled property)", () => {
    expect(requiresDisclosure("owned_net")).toBe(false);
  });

  it("returns false for entity (no publish capability; gate is moot)", () => {
    expect(requiresDisclosure("entity")).toBe(false);
  });

  it("all 4 external channels require disclosure", () => {
    const externalChannels: ChannelClass[] = ["pr_wire", "directory", "web2", "social"];
    for (const ch of externalChannels) {
      expect(requiresDisclosure(ch)).toBe(true);
    }
  });

  it("all non-external channels do NOT require disclosure", () => {
    const nonExternal: ChannelClass[] = ["owned_net", "entity"];
    for (const ch of nonExternal) {
      expect(requiresDisclosure(ch)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. assertDisclosure — external channel + null tag → BLOCKED
// ---------------------------------------------------------------------------

describe("assertDisclosure — external channel + null/empty tag is blocked (fail-closed)", () => {
  const externalChannels: ChannelClass[] = ["pr_wire", "directory", "web2", "social"];

  for (const ch of externalChannels) {
    it(`blocks ${ch} when disclosure_tag is null`, () => {
      const result = assertDisclosure(ch, null);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBeTruthy(); // has a meaningful reason string
        expect(typeof result.reason).toBe("string");
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });

    it(`blocks ${ch} when disclosure_tag is empty string`, () => {
      const result = assertDisclosure(ch, "");
      expect(result.allowed).toBe(false);
    });

    it(`blocks ${ch} when disclosure_tag is whitespace-only`, () => {
      const result = assertDisclosure(ch, "   ");
      expect(result.allowed).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. assertDisclosure — owned_net + null tag is ALLOWED
// ---------------------------------------------------------------------------

describe("assertDisclosure — owned_net + null tag is allowed", () => {
  it("allows owned_net when disclosure_tag is null", () => {
    const result = assertDisclosure("owned_net", null);
    expect(result.allowed).toBe(true);
  });

  it("allows owned_net when disclosure_tag is empty string", () => {
    const result = assertDisclosure("owned_net", "");
    expect(result.allowed).toBe(true);
  });

  it("allows owned_net when disclosure_tag is set", () => {
    const result = assertDisclosure("owned_net", "Sponsored content");
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. assertDisclosure — entity + null tag is ALLOWED (moot gate)
// ---------------------------------------------------------------------------

describe("assertDisclosure — entity + null tag is allowed (moot gate)", () => {
  it("allows entity when disclosure_tag is null", () => {
    const result = assertDisclosure("entity", null);
    expect(result.allowed).toBe(true);
  });

  it("allows entity when disclosure_tag is empty string", () => {
    const result = assertDisclosure("entity", "");
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. assertDisclosure — non-empty tag allows external channels
// ---------------------------------------------------------------------------

describe("assertDisclosure — non-empty disclosure_tag allows external channels", () => {
  const externalChannels: ChannelClass[] = ["pr_wire", "directory", "web2", "social"];

  for (const ch of externalChannels) {
    it(`allows ${ch} when disclosure_tag is non-empty`, () => {
      const result = assertDisclosure(ch, "Paid partnership");
      expect(result.allowed).toBe(true);
    });

    it(`allows ${ch} when disclosure_tag is '#ad'`, () => {
      const result = assertDisclosure(ch, "#ad");
      expect(result.allowed).toBe(true);
    });
  }

  it("allows all external channels with the same non-empty tag", () => {
    for (const ch of externalChannels) {
      expect(assertDisclosure(ch, "Sponsored").allowed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Reason string contains channel class and §7#6 reference (informative)
// ---------------------------------------------------------------------------

describe("assertDisclosure — reason string is informative when blocked", () => {
  it("includes the channel class in the reason string for pr_wire", () => {
    const result = assertDisclosure("pr_wire", null);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("pr_wire");
    }
  });

  it("includes the channel class in the reason string for social", () => {
    const result = assertDisclosure("social", null);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("social");
    }
  });

  it("reason string mentions disclosure_tag being null (informative for operator)", () => {
    const result = assertDisclosure("web2", null);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.toLowerCase()).toContain("null");
    }
  });

  it("reason string mentions 'empty' when tag is empty string", () => {
    const result = assertDisclosure("directory", "");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.toLowerCase()).toContain("empty");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Both functions are pure (no IO, deterministic)
// ---------------------------------------------------------------------------

describe("requiresDisclosure and assertDisclosure are pure — no IO", () => {
  it("requiresDisclosure returns the same value on repeated calls", () => {
    expect(requiresDisclosure("pr_wire")).toBe(true);
    expect(requiresDisclosure("pr_wire")).toBe(true);
    expect(requiresDisclosure("owned_net")).toBe(false);
    expect(requiresDisclosure("owned_net")).toBe(false);
  });

  it("assertDisclosure returns the same result on repeated calls with the same inputs", () => {
    const r1 = assertDisclosure("social", null);
    const r2 = assertDisclosure("social", null);
    expect(r1.allowed).toBe(r2.allowed);

    const r3 = assertDisclosure("social", "ad-disclosure");
    const r4 = assertDisclosure("social", "ad-disclosure");
    expect(r3.allowed).toBe(r4.allowed);
  });

  it("does not throw for any channel class or tag value", () => {
    const allChannels: ChannelClass[] = ["owned_net", "pr_wire", "directory", "web2", "social", "entity"];
    for (const ch of allChannels) {
      expect(() => requiresDisclosure(ch)).not.toThrow();
      expect(() => assertDisclosure(ch, null)).not.toThrow();
      expect(() => assertDisclosure(ch, "")).not.toThrow();
      expect(() => assertDisclosure(ch, "some tag")).not.toThrow();
    }
  });
});
