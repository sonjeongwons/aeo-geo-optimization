/**
 * test/publishStubs-retired.test.ts
 *
 * T12 acceptance criterion:
 *   "publishStubs-retired test asserts no PHASE_0_NOOP path remains for
 *    content gating"
 *
 * Verifies:
 * 1. The three publish stubs (phrasingVariationGate / claimVerificationGate /
 *    disclosureGate) no longer return a PHASE_0_NOOP note in their GateResult.
 * 2. The publishStubs[] array still has the correct shape (Gate[], phase:'publish',
 *    three members) — registration continuity preserved.
 * 3. The PHASE_0_NOOP sentinel is still exported (for legacy tools), but is
 *    NEVER returned as a result note by any of the three stubs.
 * 4. The content gate fold (runContentGates) NEVER returns a PHASE_0_NOOP
 *    note — the content ContentGate objects are structurally separate from
 *    the publish stubs.
 * 5. The publish-phase stubs are NOT in the default content gate registry
 *    (they are publish-phase Gate objects, not ContentGate objects, and
 *    runContentGates never calls them).
 */

import { describe, it, expect } from "vitest";

import {
  PHASE_0_NOOP,
  phrasingVariationGate,
  claimVerificationGate,
  disclosureGate,
  publishStubs,
} from "../src/guardrails/publishStubs.js";
import type { GateResult } from "../src/guardrails/gate.js";
import {
  runContentGates,
  defaultContentGateRegistry,
  type ContentGate,
} from "../src/content/contentGate.js";
import type { ContentGateContext } from "../src/content/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal GateContext for invoking a publish-phase Gate. */
function makePublishCtx() {
  return {
    verdict: {
      brand_mentioned: false,
      brand_rank: null,
      sentiment: "neutral" as const,
      competitors_found: [],
      evidence: null,
      provenance: { model: "test", judged_at: new Date().toISOString() },
      guardrail_status: "ok" as const,
    },
    answerText: "some answer text",
    brandAliases: ["TestBrand"],
    runId: "run-001",
    responseRawId: "resp-001",
  };
}

/** Minimal ContentGateContext for running content gates. */
function makeContentCtx(): ContentGateContext {
  return {
    asset: {
      id: "00000000-0000-0000-0000-000000000001",
      customer_id: null,
      industry: "beauty",
      template_id: "00000000-0000-0000-0000-000000000002",
      template_version: 1,
      content_set_id: "00000000-0000-0000-0000-000000000003",
      content_type: "definition",
      format: "definition_sentence",
      channel_class: "owned_net",
      language: "en",
      phrasing_group_id: "group-1",
      body: {
        content_type: "definition",
        text: "EMORA is a conversational AI companion.",
        meaning_key: "emora-definition",
      },
      claims: [],
      word_count: 7,
      gate_status: "pending",
      gate_report: null,
      disclosure_tag: null,
      needs_native_review: false,
      regen_attempts: 0,
      provenance: null,
      created_at: new Date("2026-06-01T00:00:00Z"),
    },
    siblings: [],
    brandAliases: ["EMORA"],
    claimSources: [],
  };
}

// ---------------------------------------------------------------------------
// 1. PHASE_0_NOOP sentinel is exported but NEVER returned by any stub
// ---------------------------------------------------------------------------

describe("PHASE_0_NOOP sentinel — exported but never returned by retired stubs", () => {
  it("PHASE_0_NOOP is still exported as a string constant", () => {
    expect(PHASE_0_NOOP).toBe("PHASE_0_NOOP");
    expect(typeof PHASE_0_NOOP).toBe("string");
  });

  it("phrasingVariationGate does NOT return PHASE_0_NOOP note", () => {
    const ctx = makePublishCtx();
    const result: GateResult = phrasingVariationGate.apply(ctx);
    expect(result.action).toBe("pass");
    // The 'note' field on a pass result must NOT be PHASE_0_NOOP
    if (result.action === "pass") {
      expect(result.note).not.toBe(PHASE_0_NOOP);
      // Specifically: no note at all (retired → inert)
      expect(result.note).toBeUndefined();
    }
  });

  it("claimVerificationGate does NOT return PHASE_0_NOOP note", () => {
    const ctx = makePublishCtx();
    const result: GateResult = claimVerificationGate.apply(ctx);
    expect(result.action).toBe("pass");
    if (result.action === "pass") {
      expect(result.note).not.toBe(PHASE_0_NOOP);
      expect(result.note).toBeUndefined();
    }
  });

  it("disclosureGate does NOT return PHASE_0_NOOP note", () => {
    const ctx = makePublishCtx();
    const result: GateResult = disclosureGate.apply(ctx);
    expect(result.action).toBe("pass");
    if (result.action === "pass") {
      expect(result.note).not.toBe(PHASE_0_NOOP);
      expect(result.note).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Registration shape preserved — publishStubs[] still has correct shape
// ---------------------------------------------------------------------------

describe("publishStubs registration shape — preserved", () => {
  it("publishStubs[] exports three Gate objects", () => {
    expect(publishStubs).toHaveLength(3);
  });

  it("all stubs have phase:'publish'", () => {
    for (const stub of publishStubs) {
      expect(stub.phase).toBe("publish");
    }
  });

  it("stub names are phrasingVariationGate / claimVerificationGate / disclosureGate", () => {
    const names = publishStubs.map((g) => g.name);
    expect(names).toContain("phrasingVariationGate");
    expect(names).toContain("claimVerificationGate");
    expect(names).toContain("disclosureGate");
  });

  it("stub objects are the named exports", () => {
    expect(publishStubs[0]).toBe(phrasingVariationGate);
    expect(publishStubs[1]).toBe(claimVerificationGate);
    expect(publishStubs[2]).toBe(disclosureGate);
  });

  it("all stubs still return { action: 'pass' } (inert, no downgrade)", () => {
    const ctx = makePublishCtx();
    for (const stub of publishStubs) {
      const result = stub.apply(ctx);
      expect(result.action).toBe("pass");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Content gate fold NEVER returns PHASE_0_NOOP
// ---------------------------------------------------------------------------

describe("runContentGates — no PHASE_0_NOOP in content gating", () => {
  it("gate_report entries from defaultContentGateRegistry never contain PHASE_0_NOOP", async () => {
    const ctx = makeContentCtx();

    // Run the default registry (all six real content gates)
    const { gateReport } = await defaultContentGateRegistry.run(ctx);

    for (const entry of gateReport) {
      expect(entry.reason).not.toBe(PHASE_0_NOOP);
      if (entry.reason !== undefined) {
        expect(entry.reason).not.toContain(PHASE_0_NOOP);
      }
    }
  });

  it("the publish-phase stub objects are NOT ContentGate instances in defaultContentGateRegistry", () => {
    // defaultContentGateRegistry contains content-phase gates only.
    // The publish stubs are phase:'publish' Gate objects — they have a DIFFERENT
    // apply() signature (GateContext, not ContentGateContext) and are never
    // registered in the content gate registry.
    const contentGateNames = defaultContentGateRegistry.gates().map((g) => g.name);

    // The content gate registry has exactly these eleven real gates
    // (incl. adversarialBlocklistGate + selfContainednessGate + the FTC
    //  anti-persona noFabricatedPersonaGate + keywordStuffingGate + advisory geoReadinessGate):
    expect(contentGateNames).toEqual([
      "phrasingVariationGate",
      "verifiableNumbersGate",
      "noFakeSignalsGate",
      "adversarialBlocklistGate",
      "selfContainednessGate",
      "noFabricatedPersonaGate",
      "keywordStuffingGate",
      "disclosureGate",
      "jsonLdShapeGate",
      "geoReadinessGate",
      "claimVerificationGate",
    ]);

    // All are phase:'content'
    for (const gate of defaultContentGateRegistry.gates()) {
      expect(gate.phase).toBe("content");
    }
  });

  it("a custom gate that returns PHASE_0_NOOP as reason is still structurally valid but the default registry never produces it", async () => {
    // This test verifies that even if a rogue gate returned PHASE_0_NOOP,
    // the default registry gates don't. (Belt-and-suspenders.)
    const rogueGate: ContentGate = {
      name: "rogueGate",
      phase: "content",
      apply(_ctx) {
        // Simulate a gate returning PHASE_0_NOOP as reason (should never happen)
        return { action: "pass", gate: "rogueGate", reason: PHASE_0_NOOP };
      },
    };

    const ctx = makeContentCtx();
    // Run with the rogue gate — it DOES produce PHASE_0_NOOP
    const { gateReport: rogueReport } = await runContentGates([rogueGate], ctx);
    expect(rogueReport[0]!.reason).toBe(PHASE_0_NOOP);

    // But the DEFAULT registry DOES NOT produce PHASE_0_NOOP
    const { gateReport: defaultReport } = await defaultContentGateRegistry.run(ctx);
    for (const entry of defaultReport) {
      expect(entry.reason).not.toBe(PHASE_0_NOOP);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Structural assertion: publish stubs CANNOT be used as ContentGates
// ---------------------------------------------------------------------------

describe("structural type separation — publish stubs vs content gates", () => {
  it("publish stub apply() receives GateContext (measurement-shaped), not ContentGateContext", () => {
    // This is a runtime duck-typing check. The publish stubs' apply() ignores
    // their context (_ctx: GateContext) and return { action: 'pass' }.
    // They should not be called with ContentGateContext in production.
    // We verify they at least don't crash when called with any context shape.
    const ctx = makePublishCtx();
    expect(() => phrasingVariationGate.apply(ctx)).not.toThrow();
    expect(() => claimVerificationGate.apply(ctx)).not.toThrow();
    expect(() => disclosureGate.apply(ctx)).not.toThrow();
  });

  it("content gate objects all have phase:'content' (never 'publish')", () => {
    for (const gate of defaultContentGateRegistry.gates()) {
      expect(gate.phase).toBe("content");
      expect(gate.phase).not.toBe("publish");
    }
  });
});
