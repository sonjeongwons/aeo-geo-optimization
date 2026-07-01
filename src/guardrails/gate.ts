/**
 * Pluggable guardrail gate interface and runner.
 *
 * DESIGN.md §7 — "Pluggable Gate{name,phase,apply} + runGates() fold".
 *
 * Three phases:
 *   "measurement" — applied at write-time (per judgment, before insert).
 *   "publish"     — applied at report/publish time (Phase 2-3 seam).
 *   "content"     — applied by the Phase 2 content-gate fold (runContentGates
 *                   in src/content/contentGate.ts).  runGates() IGNORES
 *                   content-phase gates — they are run exclusively through the
 *                   parallel ContentGate/runContentGates fold which carries
 *                   ContentGateContext (asset/siblings/claims) instead of the
 *                   measurement-shaped MutableVerdict.
 *
 * runGates() short-circuits on the FIRST downgrade (guardrail_status change)
 * and returns the mutated verdict immediately.  Gates that return { action:
 * 'pass' } do NOT mutate and execution continues to the next gate.
 *
 * Gate list is received via INJECTION (parameter) — never hard-imported here.
 * The pipeline (T13) wires in the concrete gate list at startup.
 */

import type { JudgeVerdict } from "../domain/mention.schema.js";
import type { GuardrailStatus, Provenance } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Public contract types
// ---------------------------------------------------------------------------

/**
 * Phase tag aligns with DESIGN §7 gate seam.
 *
 * "measurement" and "publish" are the original Phase 0/1 phases handled by
 * runGates().  "content" is the Phase 2 addition: runGates() skips it (the
 * phase filter `gate.phase !== phase` naturally excludes it); it is used
 * exclusively by runContentGates() in src/content/contentGate.ts.
 */
export type GatePhase = "measurement" | "publish" | "content";

/**
 * Mutable context passed through the gate chain.
 * Gates may mutate verdict fields in-place.
 */
export interface GateContext {
  /** The parsed judge verdict (may be mutated by a gate). */
  verdict: MutableVerdict;
  /** The raw answer text the judgment is about. */
  answerText: string | null;
  /** Brand aliases (canonical name + aliases) for evidence normalization. */
  brandAliases: string[];
  /** Metadata for logging / audit. */
  runId: string;
  responseRawId: string;
}

/**
 * Mutable projection of the judgment fields that gates may modify.
 * Mirrors the columns that `mention_judgment` stores.
 */
export interface MutableVerdict {
  brand_mentioned: boolean;
  brand_rank: number | null;
  sentiment: JudgeVerdict["sentiment"];
  competitors_found: JudgeVerdict["competitors_found"];
  evidence: JudgeVerdict["evidence"] | null;
  provenance: Provenance;
  guardrail_status: GuardrailStatus;
  /** Optional note appended by the gate for audit logging. */
  downgrade_reason?: string;
}

/** Result returned by a single gate. */
export type GateResult =
  | {
      action: "pass";
      /**
       * Optional informational note for audit/logging.
       * Phase 0 stubs set this to 'PHASE_0_NOOP' so introspection
       * tools can confirm the stub ran.
       */
      note?: string;
    }
  | {
      action: "downgrade";
      /**
       * New guardrail_status to apply.  Currently only 'downgraded_abstain'
       * is defined; future phases may add others.
       */
      status: GuardrailStatus;
      reason: string;
    };

/**
 * A guardrail gate.  Implement this interface to add a new gate.
 *
 * @example
 * const myGate: Gate = {
 *   name: 'myGate',
 *   phase: 'measurement',
 *   apply(ctx) {
 *     if (someCondition(ctx)) {
 *       return { action: 'downgrade', status: 'downgraded_abstain', reason: '...' };
 *     }
 *     return { action: 'pass' };
 *   },
 * };
 */
export interface Gate {
  /** Unique identifier used in logs and registry. */
  name: string;
  /** Phase this gate runs in. */
  phase: GatePhase;
  /**
   * Evaluate the verdict and return a pass or downgrade action.
   * MAY mutate ctx.verdict in-place (e.g. to clear evidence fields).
   */
  apply(ctx: GateContext): GateResult;
}

// ---------------------------------------------------------------------------
// runGates — ordered fold with short-circuit on first downgrade
// ---------------------------------------------------------------------------

/**
 * Run an ordered list of gates for a given phase.
 *
 * Behaviour (DESIGN):
 * - Only gates whose `.phase` matches `phase` are executed.
 * - Gates are executed in array order.
 * - On the FIRST gate that returns `{ action: 'downgrade' }`:
 *     • ctx.verdict.guardrail_status is set to the returned status.
 *     • ctx.verdict.downgrade_reason is recorded.
 *     • Execution stops immediately (short-circuit).
 * - Returns the (possibly mutated) verdict.
 *
 * The gate list is INJECTED by the caller — this function has no knowledge of
 * which concrete gates exist.
 *
 * @param gates   - Ordered list of all registered gates (any phase).
 * @param phase   - Only run gates matching this phase.
 * @param ctx     - Mutable context; verdict is mutated in-place on downgrade.
 * @returns       The mutated verdict (same object reference as ctx.verdict).
 */
export function runGates(
  gates: Gate[],
  phase: GatePhase,
  ctx: GateContext
): MutableVerdict {
  for (const gate of gates) {
    if (gate.phase !== phase) {
      continue;
    }

    const result = gate.apply(ctx);

    if (result.action === "downgrade") {
      ctx.verdict.guardrail_status = result.status;
      ctx.verdict.downgrade_reason = result.reason;
      // Short-circuit: do not evaluate further gates.
      break;
    }
    // action === 'pass': continue to next gate.
  }

  return ctx.verdict;
}

// ---------------------------------------------------------------------------
// Gate registry helper (used by publishStubs.ts and concrete gate files)
// ---------------------------------------------------------------------------

/**
 * Simple ordered registry.  Gates are stored insertion-order; runGates
 * receives the full list and filters by phase internally.
 */
export class GateRegistry {
  private readonly _gates: Gate[] = [];

  /** Add a gate to the end of the execution order. */
  register(gate: Gate): this {
    this._gates.push(gate);
    return this;
  }

  /** Return a snapshot of registered gates (insertion order). */
  gates(): readonly Gate[] {
    return this._gates;
  }

  /**
   * Run all gates for the given phase on the provided context.
   * Short-circuits on first downgrade.
   */
  run(phase: GatePhase, ctx: GateContext): MutableVerdict {
    return runGates(this._gates, phase, ctx);
  }
}
