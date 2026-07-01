/**
 * Phase 2-3 publish-gate stubs — RETIRED into the content fold (T12).
 *
 * DESIGN-phase2.md §"Phase 0/1 Integration":
 *   The three Phase 0 publish stubs (phrasingVariationGate / claimVerificationGate
 *   / disclosureGate) cannot be 'made real in place' because gate.ts GateResult
 *   is the closed union {pass}|{downgrade,status} and GateContext carries
 *   MutableVerdict (brand_mentioned/brand_rank) with no body/claims slot and no
 *   block/needs_human action.  Phase 2 builds a PARALLEL ContentGate /
 *   ContentGateContext / ContentGateResult + runContentGates() fold in
 *   src/content/contentGate.ts.
 *
 * RETIREMENT (T12):
 *   The three stubs are re-pointed to the content fold by changing their
 *   apply() bodies to delegate to the real content gate implementations:
 *   - phrasingVariationGate → delegates to content/gates/phrasingVariation.ts
 *   - claimVerificationGate → delegates to content/gates/claimVerification.ts
 *   - disclosureGate        → delegates to content/gates/disclosure.ts
 *
 *   HOWEVER: These publish-phase Gate objects receive a measurement-shaped
 *   GateContext (MutableVerdict, no asset/claims), so they CANNOT actually run
 *   the content gate logic on a measurement context.  The correct retirement is
 *   to have the publish-phase stubs return { action: 'pass' } WITHOUT the
 *   PHASE_0_NOOP note — they are now inert placeholders in the publish slot,
 *   while the real guardrail logic lives in the ContentGate fold in
 *   src/content/contentGate.ts.
 *
 *   The PHASE_0_NOOP sentinel export is PRESERVED for legacy measurement-publish
 *   introspection tooling that checks for it; it is NEVER returned by a content
 *   gate (asserted by test/publishStubs-retired.test.ts).
 *
 * REGISTRATION SHAPE PRESERVED:
 *   All three Gate objects and the publishStubs[] array are still exported
 *   with the same names and the same phase:'publish' Gate interface shape.
 *   Callers that register publishStubs into a GateRegistry (measurement/publish
 *   pipeline) continue to work without modification.
 *
 * NO PHASE_0_NOOP IN CONTENT GATING:
 *   The content gate fold (runContentGates in src/content/contentGate.ts) uses
 *   ContentGate objects from src/content/gates/*.ts, none of which ever return
 *   a PHASE_0_NOOP note.  The publishStubs[] publish-phase gates are NOT in
 *   the content gate registry and are NEVER invoked by runContentGates().
 *   See test/publishStubs-retired.test.ts for the structural assertion.
 */

import type { Gate, GateContext, GateResult } from "./gate.js";

// ---------------------------------------------------------------------------
// Sentinel string — PRESERVED for legacy introspection; NEVER returned by
// any content gate (runContentGates / ContentGate fold).
// ---------------------------------------------------------------------------

export const PHASE_0_NOOP = "PHASE_0_NOOP" as const;
export type Phase0Noop = typeof PHASE_0_NOOP;

// ---------------------------------------------------------------------------
// phrasingVariationGate (§7#1) — RETIRED publish-phase placeholder
//
// Real §7#1 logic lives in src/content/gates/phrasingVariation.ts and is
// executed by runContentGates() in src/content/contentGate.ts.
//
// This publish-phase Gate object remains registered for pipeline introspection
// but is INERT in the publish slot: it returns { action: 'pass' } without
// a PHASE_0_NOOP note, signalling retirement (the noop is gone; the slot
// exists only for registration continuity).
// ---------------------------------------------------------------------------

export const phrasingVariationGate: Gate = {
  name: "phrasingVariationGate",
  phase: "publish",

  apply(_ctx: GateContext): GateResult {
    // Retired: §7#1 phrasing-variation is enforced by the Phase 2 content gate
    // fold (src/content/gates/phrasingVariation.ts via runContentGates).
    // This publish-phase slot is now inert — no PHASE_0_NOOP.
    return { action: "pass" };
  },
};

// ---------------------------------------------------------------------------
// claimVerificationGate (§7#7) — RETIRED publish-phase placeholder
//
// Real §7#7 logic lives in src/content/gates/claimVerification.ts and is
// executed by runContentGates() in src/content/contentGate.ts.
// ---------------------------------------------------------------------------

export const claimVerificationGate: Gate = {
  name: "claimVerificationGate",
  phase: "publish",

  apply(_ctx: GateContext): GateResult {
    // Retired: §7#7 claim verification is enforced by the Phase 2 content gate
    // fold (src/content/gates/claimVerification.ts via runContentGates).
    // This publish-phase slot is now inert — no PHASE_0_NOOP.
    return { action: "pass" };
  },
};

// ---------------------------------------------------------------------------
// disclosureGate (§7#6) — RETIRED publish-phase placeholder
//
// Real §7#6 logic lives in src/content/gates/disclosure.ts and is
// executed by runContentGates() in src/content/contentGate.ts.
// ---------------------------------------------------------------------------

export const disclosureGate: Gate = {
  name: "disclosureGate",
  phase: "publish",

  apply(_ctx: GateContext): GateResult {
    // Retired: §7#6 disclosure enforcement is in the Phase 2 content gate
    // fold (src/content/gates/disclosure.ts via runContentGates).
    // This publish-phase slot is now inert — no PHASE_0_NOOP.
    return { action: "pass" };
  },
};

// ---------------------------------------------------------------------------
// publishStubs — ordered list for registration (SHAPE PRESERVED)
// ---------------------------------------------------------------------------

/**
 * All Phase 2-3 publish stubs in execution order.
 *
 * RETIREMENT NOTE: These are now inert publish-phase placeholders.  The real
 * §7 guardrail logic runs through the ContentGate fold (runContentGates in
 * src/content/contentGate.ts).  These objects are preserved for pipeline
 * registration continuity (introspection, gate registry shape).
 *
 * Register via GateRegistry.register() at startup:
 *
 *   import { publishStubs } from './guardrails/publishStubs.js';
 *   for (const gate of publishStubs) registry.register(gate);
 */
export const publishStubs: readonly Gate[] = [
  phrasingVariationGate,
  claimVerificationGate,
  disclosureGate,
] as const;
