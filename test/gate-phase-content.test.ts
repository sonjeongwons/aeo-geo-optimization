/**
 * test/gate-phase-content.test.ts
 *
 * Regression test for T04: GatePhase += 'content' (additive union member).
 *
 * Asserts:
 *   1. GatePhase now includes 'content' (type-level and value-level).
 *   2. runGates() with phase='measurement' SKIPS a content-phase gate.
 *   3. runGates() with phase='publish' SKIPS a content-phase gate.
 *   4. Existing measurement-gate downgrade behaviour is UNCHANGED.
 *   5. GateRegistry.run() still short-circuits on the first matching downgrade.
 */

import { describe, it, expect, vi } from "vitest";
import {
  GatePhase,
  GateRegistry,
  Gate,
  GateContext,
  GateResult,
  MutableVerdict,
  runGates,
} from "../src/guardrails/gate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMutableVerdict(): MutableVerdict {
  return {
    brand_mentioned: false,
    brand_rank: null,
    sentiment: "neutral",
    competitors_found: [],
    evidence: null,
    provenance: {
      model: "test-model",
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
      latency_ms: 0,
    },
    guardrail_status: "ok",
  };
}

function makeCtx(overrides?: Partial<GateContext>): GateContext {
  return {
    verdict: makeMutableVerdict(),
    answerText: "some answer",
    brandAliases: ["Brand"],
    runId: "run-1",
    responseRawId: "resp-1",
    ...overrides,
  };
}

function makeGate(
  name: string,
  phase: GatePhase,
  result: GateResult = { action: "pass" }
): Gate & { applyCalls: number } {
  const gate = {
    name,
    phase,
    applyCalls: 0,
    apply(_ctx: GateContext): GateResult {
      gate.applyCalls++;
      return result;
    },
  };
  return gate;
}

// ---------------------------------------------------------------------------
// 1. GatePhase type includes 'content'
// ---------------------------------------------------------------------------

describe("GatePhase union", () => {
  it("accepts 'measurement' as a valid GatePhase", () => {
    const phase: GatePhase = "measurement";
    expect(phase).toBe("measurement");
  });

  it("accepts 'publish' as a valid GatePhase", () => {
    const phase: GatePhase = "publish";
    expect(phase).toBe("publish");
  });

  it("accepts 'content' as a valid GatePhase (T04 addition)", () => {
    // This line would be a TypeScript compile error if 'content' were not in
    // the union — so the test passing at the type-check level proves the edit.
    const phase: GatePhase = "content";
    expect(phase).toBe("content");
  });
});

// ---------------------------------------------------------------------------
// 2. runGates with phase='measurement' SKIPS content-phase gates
// ---------------------------------------------------------------------------

describe("runGates — content-phase gate is skipped", () => {
  it("does NOT invoke a content-phase gate when running measurement phase", () => {
    const contentGate = makeGate("contentGate", "content", {
      action: "downgrade",
      status: "downgraded_abstain",
      reason: "should never fire",
    });
    const ctx = makeCtx();

    runGates([contentGate], "measurement", ctx);

    expect(contentGate.applyCalls).toBe(0);
    expect(ctx.verdict.guardrail_status).toBe("ok"); // untouched
  });

  it("does NOT invoke a content-phase gate when running publish phase", () => {
    const contentGate = makeGate("contentGate", "content", {
      action: "downgrade",
      status: "downgraded_abstain",
      reason: "should never fire",
    });
    const ctx = makeCtx();

    runGates([contentGate], "publish", ctx);

    expect(contentGate.applyCalls).toBe(0);
    expect(ctx.verdict.guardrail_status).toBe("ok");
  });

  it("runs measurement gates while ignoring an interleaved content gate", () => {
    const measurementGate = makeGate("m1", "measurement");
    const contentGate = makeGate("c1", "content");
    const ctx = makeCtx();

    runGates([measurementGate, contentGate, measurementGate], "measurement", ctx);

    // measurement gate applied twice (it appears twice in the list), content never
    expect(measurementGate.applyCalls).toBe(2);
    expect(contentGate.applyCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Existing measurement downgrade behaviour is unchanged
// ---------------------------------------------------------------------------

describe("runGates — measurement downgrade behaviour unchanged", () => {
  it("short-circuits on first measurement downgrade and records reason", () => {
    const downgradingGate = makeGate("d1", "measurement", {
      action: "downgrade",
      status: "downgraded_abstain",
      reason: "test downgrade",
    });
    const secondGate = makeGate("d2", "measurement");
    const ctx = makeCtx();

    runGates([downgradingGate, secondGate], "measurement", ctx);

    expect(ctx.verdict.guardrail_status).toBe("downgraded_abstain");
    expect(ctx.verdict.downgrade_reason).toBe("test downgrade");
    // second gate must NOT have run (short-circuit)
    expect(secondGate.applyCalls).toBe(0);
  });

  it("returns the same verdict object reference", () => {
    const gate = makeGate("noop", "measurement");
    const ctx = makeCtx();
    const result = runGates([gate], "measurement", ctx);
    expect(result).toBe(ctx.verdict);
  });

  it("pass-only gates do not mutate guardrail_status", () => {
    const g1 = makeGate("g1", "measurement");
    const g2 = makeGate("g2", "measurement");
    const ctx = makeCtx();

    runGates([g1, g2], "measurement", ctx);

    expect(ctx.verdict.guardrail_status).toBe("ok");
    expect(g1.applyCalls).toBe(1);
    expect(g2.applyCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. GateRegistry.run() still short-circuits on first downgrade
// ---------------------------------------------------------------------------

describe("GateRegistry — short-circuit unaffected by addition of content phase", () => {
  it("short-circuits measurement fold even with a registered content gate", () => {
    const registry = new GateRegistry();

    const downgrader = makeGate("downgrader", "measurement", {
      action: "downgrade",
      status: "downgraded_abstain",
      reason: "blocked",
    });
    const afterGate = makeGate("afterGate", "measurement");
    const contentGate = makeGate("contentGate", "content");

    registry.register(downgrader).register(afterGate).register(contentGate);

    const ctx = makeCtx();
    registry.run("measurement", ctx);

    expect(downgrader.applyCalls).toBe(1);
    expect(afterGate.applyCalls).toBe(0); // short-circuited
    expect(contentGate.applyCalls).toBe(0); // phase-filtered
    expect(ctx.verdict.guardrail_status).toBe("downgraded_abstain");
  });
});
