/**
 * evidenceRequiredGate — DESIGN.md §7 measurement gate.
 *
 * Rule (§7#7 / §7#2, write-time):
 *   If brand_mentioned === true AND there is no alias-normalized locatable span
 *   (evidence is null or missing start/end) → downgrade to 'downgraded_abstain'.
 *
 * Effect:
 *   • guardrail_status = 'downgraded_abstain'
 *   • brand_mentioned  forced to false    (excluded from numerator)
 *   • brand_rank       forced to null     (no rank without a located span)
 *   • evidence         cleared to null    (it was unverifiable)
 *   • provenance       forced to 'abstain'
 *
 * The row is still PERSISTED (excluded from numerator, counts in denominator
 * via N_total snapshot — §5.2).
 *
 * Defense-in-depth: the same-table DB CHECK enforces this at storage layer:
 *   CONSTRAINT mention_evidence_chk CHECK
 *     (brand_mentioned = false OR evidence_quote IS NOT NULL)
 *
 * Cross-table "evidence ⊂ answer_text" check is APP code (evidence.ts), not a
 * DB CHECK (a CHECK can't reference another table) — DESIGN decision §9.
 */

import type { Gate, GateContext, GateResult } from "./gate.js";

/**
 * Checks whether the verdict contains a locatable alias-normalized evidence
 * span.  A span is considered "located" if:
 *   - evidence is non-null
 *   - evidence.quote is a non-empty string
 *   - evidence.start is a non-negative integer
 *   - evidence.end > evidence.start
 *
 * This mirrors the criteria used by evidence.ts when it returns a located span.
 */
function hasLocatableSpan(verdict: GateContext["verdict"]): boolean {
  const ev = verdict.evidence;
  if (ev === null || ev === undefined) return false;
  if (!ev.quote || ev.quote.trim().length === 0) return false;
  if (typeof ev.start !== "number" || typeof ev.end !== "number") return false;
  if (ev.start < 0) return false;
  if (ev.end <= ev.start) return false;
  return true;
}

export const evidenceRequiredGate: Gate = {
  name: "evidenceRequiredGate",
  phase: "measurement",

  apply(ctx: GateContext): GateResult {
    const { verdict } = ctx;

    // Only fires when brand is claimed to be mentioned.
    if (!verdict.brand_mentioned) {
      return { action: "pass" };
    }

    // If a locatable span exists, evidence requirement is satisfied.
    if (hasLocatableSpan(verdict)) {
      return { action: "pass" };
    }

    // brand_mentioned=true but no locatable alias-normalized span → downgrade.
    // Mutate the verdict fields in-place to reflect abstain state.
    verdict.brand_mentioned = false;
    verdict.brand_rank = null;
    verdict.evidence = null;
    verdict.provenance = "abstain";

    return {
      action: "downgrade",
      status: "downgraded_abstain",
      reason:
        "brand_mentioned=true but no alias-normalized evidence span could be located in answer_text; " +
        "downgraded to abstain (§7#7). Row persisted, excluded from SMR numerator.",
    };
  },
};
