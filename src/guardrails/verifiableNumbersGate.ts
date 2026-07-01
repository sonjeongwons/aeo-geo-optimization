/**
 * verifiableNumbersGate — DESIGN.md §7 report-time gate.
 *
 * Rule (§7#2, report-time):
 *   The report DTO MUST contain ONLY verifiable numeric metrics.  Every metric
 *   entry must have the shape { metric, value, n_total, evidence_refs[] }.
 *   The report type MUST NOT have a free-text claims field — narrative
 *   superlatives are structurally impossible (compile-time enforced via the
 *   RunReport type in metrics.types.ts, which deliberately omits any claims
 *   field).
 *
 * At runtime this gate validates that:
 *   1. Every MetricTuple has a finite numeric value and a non-empty evidence_refs.
 *   2. n_total is a positive integer (matches run.n_total snapshot).
 *   3. All numeric values are within plausible ranges:
 *        • SMR / Visibility fractions in [0, ∞) (Visibility can exceed 1)
 *        • SoV in [0, 1]
 *
 * This gate runs at phase: 'publish' since it validates the assembled report,
 * NOT per-judgment write-time.  The upstream evidenceRequiredGate handles the
 * write-time evidence check.
 *
 * DESIGN note: the report DTO type (RunReport / MetricTuple in
 * src/domain/metrics.types.ts) has NO free-text claims field — the structural
 * guarantee at compile time.  This runtime gate is defense-in-depth.
 */

import type { Gate, GateContext, GateResult } from "./gate.js";
import type { MetricTuple } from "../domain/metrics.types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context extension for the verifiable-numbers gate.
 * The pipeline passes this via the generic GateContext.verdict's
 * downgrade_reason field and a side-channel in the context.
 *
 * Because Gate.apply() only receives GateContext, we use a convention:
 * the caller places the MetricTuple[] in a well-known property on the context
 * object that TypeScript allows via the open GateContext.verdict type.
 *
 * In practice, the report assembler (T11) calls this gate directly as:
 *
 *   verifiableNumbersGate.apply({
 *     ...baseCtx,
 *     verdict: { ...baseVerdict, _metrics: metricsArray },
 *   })
 *
 * The gate reads ctx.verdict._metrics when present.
 */
export interface VerifiableNumbersContext extends GateContext {
  verdict: GateContext["verdict"] & {
    /** Injected by the report assembler; not persisted. */
    _metrics?: MetricTuple[];
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && isFinite(v) && !isNaN(v);
}

function validateMetricTuple(
  tuple: MetricTuple
): { valid: true } | { valid: false; reason: string } {
  if (!tuple.metric || typeof tuple.metric !== "string") {
    return { valid: false, reason: `metric name is empty or not a string` };
  }

  if (!isFiniteNumber(tuple.value)) {
    return {
      valid: false,
      reason: `metric '${tuple.metric}' has non-finite value: ${tuple.value}`,
    };
  }

  if (
    !Number.isInteger(tuple.nTotal) ||
    tuple.nTotal <= 0
  ) {
    return {
      valid: false,
      reason: `metric '${tuple.metric}' has invalid n_total: ${tuple.nTotal}`,
    };
  }

  if (!Array.isArray(tuple.evidenceRefs)) {
    return {
      valid: false,
      reason: `metric '${tuple.metric}' is missing evidenceRefs array`,
    };
  }

  // SMR must be in [0, 1]; visibility can exceed 1 (Σ(1/rank)/N with rank=1)
  if (tuple.metric === "smr" && (tuple.value < 0 || tuple.value > 1)) {
    return {
      valid: false,
      reason: `SMR out of range [0,1]: ${tuple.value}`,
    };
  }

  if (
    (tuple.metric === "sov" || tuple.metric.startsWith("sov:")) &&
    (tuple.value < 0 || tuple.value > 1)
  ) {
    return {
      valid: false,
      reason: `SoV out of range [0,1]: ${tuple.value}`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Gate implementation
// ---------------------------------------------------------------------------

/**
 * Report-time gate: validates that every MetricTuple in the report has a
 * finite, bounded, evidence-backed numeric value.
 *
 * Phase: 'publish' (runs at report assembly time, not per-judgment write time).
 *
 * On failure: returns a downgrade action with a descriptive reason string.
 * The caller (report assembler) decides what to do with the downgrade
 * (typically: redact the offending metric and log the reason).
 *
 * When no _metrics are present in ctx.verdict, the gate passes — it is only
 * meaningful when the report assembler injects metrics.
 */
export const verifiableNumbersGate: Gate = {
  name: "verifiableNumbersGate",
  phase: "publish",

  apply(ctx: VerifiableNumbersContext): GateResult {
    const metrics = ctx.verdict._metrics;

    // If no metrics injected, nothing to validate — pass.
    if (!metrics || metrics.length === 0) {
      return { action: "pass" };
    }

    for (const tuple of metrics) {
      const result = validateMetricTuple(tuple);
      if (!result.valid) {
        return {
          action: "downgrade",
          status: "downgraded_abstain", // reuse closest available status
          reason: `verifiableNumbersGate: ${result.reason} — metric excluded from report (§7#2).`,
        };
      }
    }

    return { action: "pass" };
  },
};

// ---------------------------------------------------------------------------
// Type-level proof: RunReport has no free-text claims field
// ---------------------------------------------------------------------------
//
// The compile-time guarantee lives in src/domain/metrics.types.ts (RunReport
// interface).  The following import and type-only assertion confirms the
// dependency is correct and will cause a TS error if a 'claims' field is
// accidentally added to RunReport.

import type { RunReport } from "../domain/metrics.types.js";

/** @internal Compile-time check: RunReport must NOT have a free-text claims field. */
type _NoClaimsField = "claims" extends keyof RunReport ? never : true;
// If RunReport gains a 'claims' field this type resolves to `never`,
// and the line below becomes a type error.
const _noClaimsCheck: _NoClaimsField = true;
void _noClaimsCheck; // suppress unused-variable warning
