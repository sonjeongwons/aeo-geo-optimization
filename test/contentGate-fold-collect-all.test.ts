/**
 * test/contentGate-fold-collect-all.test.ts
 *
 * T12 acceptance criteria — runContentGates() non-short-circuit fold:
 *
 * 1. Records a verdict for EVERY gate even when an earlier gate blocks
 *    (full §12 audit trail).
 * 2. Terminal status precedence: block > needs_human > passed.
 * 3. Paid claim-extraction (claimVerificationGate) is NOT invoked for an
 *    asset already blocked by a cheap structural gate.
 */

import { describe, it, expect, vi } from "vitest";
import {
  runContentGates,
  ContentGateRegistry,
  type ContentGate,
  type GateReportEntry,
} from "../src/content/contentGate.js";
import type { ContentGateContext, ContentGateResult } from "../src/content/types.js";

// ---------------------------------------------------------------------------
// Minimal ContentGateContext fixture (enough for the fold)
// ---------------------------------------------------------------------------

/**
 * Create a minimal ContentGateContext for testing.
 * We only need the asset shape that gates inspect; most fields can be minimal.
 */
function makeCtx(overrides: Partial<ContentGateContext> = {}): ContentGateContext {
  const asset = {
    id: "00000000-0000-0000-0000-000000000001",
    customer_id: null,
    industry: "beauty",
    template_id: "00000000-0000-0000-0000-000000000002",
    template_version: 1,
    content_set_id: "00000000-0000-0000-0000-000000000003",
    content_type: "definition" as const,
    format: "definition_sentence" as const,
    channel_class: "owned_net" as const,
    language: "en",
    phrasing_group_id: "group-1",
    body: {
      content_type: "definition" as const,
      text: "EMORA is a conversational AI companion designed for emotional support.",
      meaning_key: "emora-definition",
    },
    claims: [],
    word_count: 12,
    gate_status: "pending" as const,
    gate_report: null,
    disclosure_tag: null,
    needs_native_review: false,
    regen_attempts: 0,
    provenance: null,
    created_at: new Date("2026-06-01T00:00:00Z"),
  };

  return {
    asset,
    siblings: [],
    brandAliases: ["EMORA"],
    claimSources: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test gate builders
// ---------------------------------------------------------------------------

function makePassGate(name: string): ContentGate {
  return {
    name,
    phase: "content",
    apply(_ctx): ContentGateResult {
      return { action: "pass", gate: name };
    },
  };
}

function makeBlockGate(name: string, reason: string): ContentGate {
  return {
    name,
    phase: "content",
    apply(_ctx): ContentGateResult {
      return { action: "block", gate: name, reason };
    },
  };
}

function makeNeedsHumanGate(name: string, reason: string): ContentGate {
  return {
    name,
    phase: "content",
    apply(_ctx): ContentGateResult {
      return { action: "needs_human", gate: name, reason };
    },
  };
}

function makeAsyncBlockGate(name: string, reason: string): ContentGate {
  return {
    name,
    phase: "content",
    async apply(_ctx): Promise<ContentGateResult> {
      return { action: "block", gate: name, reason };
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite: NON-SHORT-CIRCUIT fold — every gate produces a verdict entry
// ---------------------------------------------------------------------------

describe("runContentGates — non-short-circuit fold (§12 audit)", () => {
  it("records verdicts for ALL gates even when gate 1 blocks", async () => {
    const gates: ContentGate[] = [
      makeBlockGate("gate1", "duplicate phrasing"),
      makePassGate("gate2"),
      makePassGate("gate3"),
    ];
    const ctx = makeCtx();
    const { gateReport, terminalStatus } = await runContentGates(gates, ctx);

    expect(gateReport).toHaveLength(3);
    expect(gateReport[0]).toMatchObject({ gate: "gate1", action: "block" });
    expect(gateReport[1]).toMatchObject({ gate: "gate2", action: "pass" });
    expect(gateReport[2]).toMatchObject({ gate: "gate3", action: "pass" });
    expect(terminalStatus).toBe("blocked");
  });

  it("records verdicts for ALL gates when multiple gates block", async () => {
    const gates: ContentGate[] = [
      makeBlockGate("gate1", "phrasing dup"),
      makeBlockGate("gate2", "unbounded superlative"),
      makeNeedsHumanGate("gate3", "unverified claim"),
    ];
    const ctx = makeCtx();
    const { gateReport, terminalStatus } = await runContentGates(gates, ctx);

    expect(gateReport).toHaveLength(3);
    expect(gateReport[0]).toMatchObject({ gate: "gate1", action: "block" });
    expect(gateReport[1]).toMatchObject({ gate: "gate2", action: "block" });
    expect(gateReport[2]).toMatchObject({ gate: "gate3", action: "needs_human" });
    // block takes precedence over needs_human
    expect(terminalStatus).toBe("blocked");
  });

  it("all gates pass → terminal status 'passed'", async () => {
    const gates: ContentGate[] = [
      makePassGate("phrasingVariationGate"),
      makePassGate("verifiableNumbersGate"),
      makePassGate("disclosureGate"),
    ];
    const ctx = makeCtx();
    const { gateReport, terminalStatus } = await runContentGates(gates, ctx);

    expect(gateReport).toHaveLength(3);
    expect(gateReport.every((e) => e.action === "pass")).toBe(true);
    expect(terminalStatus).toBe("passed");
  });

  it("no block but needs_human present → terminal status 'needs_human'", async () => {
    const gates: ContentGate[] = [
      makePassGate("phrasingVariationGate"),
      makeNeedsHumanGate("claimVerificationGate", "unverified superlative"),
      makePassGate("disclosureGate"),
    ];
    const ctx = makeCtx();
    const { gateReport, terminalStatus } = await runContentGates(gates, ctx);

    expect(gateReport).toHaveLength(3);
    expect(terminalStatus).toBe("needs_human");
  });

  it("handles async gates (e.g. paid claim gate)", async () => {
    const gates: ContentGate[] = [
      makePassGate("phrasingVariationGate"),
      makeAsyncBlockGate("claimVerificationGate", "numeric out of bound"),
    ];
    const ctx = makeCtx();
    const { gateReport, terminalStatus } = await runContentGates(gates, ctx);

    expect(gateReport).toHaveLength(2);
    expect(gateReport[1]).toMatchObject({ gate: "claimVerificationGate", action: "block" });
    expect(terminalStatus).toBe("blocked");
  });

  it("empty gate list → terminal status 'passed' with empty report", async () => {
    const { gateReport, terminalStatus } = await runContentGates([], makeCtx());
    expect(gateReport).toHaveLength(0);
    expect(terminalStatus).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// Test suite: Terminal status precedence
// ---------------------------------------------------------------------------

describe("runContentGates — terminal status precedence: block > needs_human > passed", () => {
  it("block > needs_human: if any block, terminal is 'blocked' even with needs_human", async () => {
    const gates: ContentGate[] = [
      makeNeedsHumanGate("gate1", "needs review"),
      makeBlockGate("gate2", "hard block"),
    ];
    const { terminalStatus } = await runContentGates(gates, makeCtx());
    expect(terminalStatus).toBe("blocked");
  });

  it("needs_human > passed: if any needs_human (no block), terminal is 'needs_human'", async () => {
    const gates: ContentGate[] = [
      makePassGate("gate1"),
      makeNeedsHumanGate("gate2", "needs review"),
    ];
    const { terminalStatus } = await runContentGates(gates, makeCtx());
    expect(terminalStatus).toBe("needs_human");
  });

  it("only passes → terminal is 'passed'", async () => {
    const gates: ContentGate[] = [makePassGate("gate1"), makePassGate("gate2")];
    const { terminalStatus } = await runContentGates(gates, makeCtx());
    expect(terminalStatus).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// Test suite: Paid claimVerificationGate cost short-circuit
// ---------------------------------------------------------------------------

describe("runContentGates — cost short-circuit for paid gate", () => {
  it("skips claimVerificationGate when a prior gate blocks (no Gemini call)", async () => {
    const extractionApplied = vi.fn();

    const cheapBlockGate: ContentGate = {
      name: "phrasingVariationGate",
      phase: "content",
      apply(_ctx): ContentGateResult {
        return { action: "block", gate: "phrasingVariationGate", reason: "near-duplicate" };
      },
    };

    const paidGate: ContentGate = {
      name: "claimVerificationGate",
      phase: "content",
      apply(_ctx): ContentGateResult {
        // Should NOT be called when a prior gate blocks
        extractionApplied();
        return { action: "pass", gate: "claimVerificationGate" };
      },
    };

    const ctx = makeCtx();
    const { gateReport, terminalStatus } = await runContentGates(
      [cheapBlockGate, paidGate],
      ctx
    );

    // Paid gate apply() was NOT called
    expect(extractionApplied).not.toHaveBeenCalled();

    // But gate_report still has an entry for claimVerificationGate (audit)
    expect(gateReport).toHaveLength(2);
    expect(gateReport[1]).toMatchObject({
      gate: "claimVerificationGate",
      action: "pass",
    });
    // The skipped entry has a reason explaining why it was skipped
    expect(gateReport[1]!.reason).toContain("skipped");

    expect(terminalStatus).toBe("blocked");
  });

  it("invokes claimVerificationGate when no prior gate blocks", async () => {
    const extractionApplied = vi.fn();

    const cheapPassGate: ContentGate = {
      name: "phrasingVariationGate",
      phase: "content",
      apply(_ctx): ContentGateResult {
        return { action: "pass", gate: "phrasingVariationGate" };
      },
    };

    const paidGate: ContentGate = {
      name: "claimVerificationGate",
      phase: "content",
      apply(_ctx): ContentGateResult {
        extractionApplied();
        return { action: "pass", gate: "claimVerificationGate" };
      },
    };

    const { gateReport, terminalStatus } = await runContentGates(
      [cheapPassGate, paidGate],
      makeCtx()
    );

    // Paid gate DID run
    expect(extractionApplied).toHaveBeenCalledOnce();

    expect(gateReport).toHaveLength(2);
    expect(gateReport[1]).toMatchObject({ gate: "claimVerificationGate", action: "pass" });
    expect(terminalStatus).toBe("passed");
  });

  it("invokes claimVerificationGate when only needs_human prior (not block)", async () => {
    const extractionApplied = vi.fn();

    const needsHumanGate: ContentGate = {
      name: "disclosureGate",
      phase: "content",
      apply(_ctx): ContentGateResult {
        return { action: "needs_human", gate: "disclosureGate", reason: "needs review" };
      },
    };

    const paidGate: ContentGate = {
      name: "claimVerificationGate",
      phase: "content",
      apply(_ctx): ContentGateResult {
        extractionApplied();
        return { action: "needs_human", gate: "claimVerificationGate", reason: "unverified" };
      },
    };

    const { terminalStatus } = await runContentGates(
      [needsHumanGate, paidGate],
      makeCtx()
    );

    // Paid gate still runs (only blocked, not needs_human, triggers cost skip)
    expect(extractionApplied).toHaveBeenCalledOnce();
    expect(terminalStatus).toBe("needs_human");
  });
});

// ---------------------------------------------------------------------------
// Test suite: ContentGateRegistry
// ---------------------------------------------------------------------------

describe("ContentGateRegistry", () => {
  it("registers gates in insertion order and runs them via .run()", async () => {
    const order: string[] = [];
    const registry = new ContentGateRegistry();

    registry.register({
      name: "gate1",
      phase: "content",
      apply(_ctx) {
        order.push("gate1");
        return { action: "pass", gate: "gate1" };
      },
    });
    registry.register({
      name: "gate2",
      phase: "content",
      apply(_ctx) {
        order.push("gate2");
        return { action: "pass", gate: "gate2" };
      },
    });

    const ctx = makeCtx();
    const { terminalStatus } = await registry.run(ctx);

    expect(order).toEqual(["gate1", "gate2"]);
    expect(terminalStatus).toBe("passed");
  });

  it("gates() returns insertion-order snapshot", () => {
    const registry = new ContentGateRegistry();
    registry.register(makePassGate("a"));
    registry.register(makePassGate("b"));
    registry.register(makePassGate("c"));

    const names = registry.gates().map((g) => g.name);
    expect(names).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Test suite: gate_report includes reason field for block/needs_human entries
// ---------------------------------------------------------------------------

describe("runContentGates — gate_report reason field", () => {
  it("includes reason in gate_report entry when gate provides one", async () => {
    const gates: ContentGate[] = [
      makeBlockGate("phrasingVariationGate", "trigramJaccard=0.92 >= 0.85"),
    ];
    const { gateReport } = await runContentGates(gates, makeCtx());

    expect(gateReport[0]).toMatchObject({
      gate: "phrasingVariationGate",
      action: "block",
      reason: "trigramJaccard=0.92 >= 0.85",
    });
  });

  it("omits reason from gate_report entry when gate passes without reason", async () => {
    const gates: ContentGate[] = [makePassGate("phrasingVariationGate")];
    const { gateReport } = await runContentGates(gates, makeCtx());

    expect(gateReport[0]).toMatchObject({ gate: "phrasingVariationGate", action: "pass" });
    expect(gateReport[0]!.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test suite: defaultContentGateRegistry exports all six gates in order
// ---------------------------------------------------------------------------

import { defaultContentGateRegistry } from "../src/content/contentGate.js";

describe("defaultContentGateRegistry", () => {
  it("exports eleven gates in cheap-first order (incl. FTC anti-persona, keyword-stuffing, + advisory geoReadiness)", () => {
    const names = defaultContentGateRegistry.gates().map((g) => g.name);
    expect(names).toEqual([
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
  });

  it("all gates have phase:'content'", () => {
    const gates = defaultContentGateRegistry.gates();
    expect(gates.every((g) => g.phase === "content")).toBe(true);
  });
});
