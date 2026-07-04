/**
 * src/content/gates/claimVerification.ts
 *
 * T11 — claimVerificationGate (§7#7): wraps claimVerify + claimExtract,
 * fail-closed.
 *
 * DESIGN-phase2.md §"THE FIVE GATES":
 *   (5) claimVerificationGate (§7#7) — see claimVerification; FAILS CLOSED on
 *   empty/failed extraction; can return needs_human.
 *
 * This gate is the PAID gate (calls claimExtract which calls Gemini) and runs
 * LAST in the fold, AFTER all cheap structural gates.  If an asset has already
 * been blocked by a cheap gate, the fold must NOT invoke this gate (cost
 * short-circuit — enforced by runContentGates in contentGate.ts).
 *
 * Gate logic (from DESIGN-phase2.md §"Claim Verification (§7#7)"):
 *
 * 1. If the asset already has claims[] populated (from a prior extraction pass),
 *    skip re-extraction and go directly to verifyAndDecide().
 *
 * 2. Otherwise, call extractClaims() to run the Gemini extraction pass.
 *    If extraction returns ok:false → fail closed (see verifyAndDecide with
 *    extractionFailed=true + empty claims).
 *
 * 3. Call verifyAndDecide() with the (possibly empty) claims and the
 *    claim_source registry from ctx.claimSources.
 *    - decision='pass'        → action:'pass'
 *    - decision='block'       → action:'block'
 *    - decision='needs_human' → action:'needs_human'
 *
 * NOTE: In Phase 2, the gate fold operates on assets whose claims[] may already
 * be populated by an upstream extraction step.  This gate re-runs
 * verifyAndDecide() on whatever claims[] the asset carries.  If claims[] is
 * empty and extraction is not available (no adapter injected or NOT_CONFIGURED),
 * the gate fails closed to needs_human (not block, not pass).
 *
 * The adapter and ledger are injected at construction time so this gate can be
 * used in tests with stubs.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { verifyAndDecide } from "../claimVerify.js";
import type { ClaimExtractionAdapter, ClaimExtractionLedgerPort } from "../claimExtract.js";
import { extractClaims } from "../claimExtract.js";
import type { ContentAsset, ContentGateContext, ContentGateResult } from "../types.js";
import type { QgenRunBudget } from "../../cost/qgenBudget.js";

// ---------------------------------------------------------------------------
// Gate factory
// ---------------------------------------------------------------------------

/**
 * Options for creating a claimVerificationGate.
 * The adapter and ledger are optional: if absent, the gate still works but
 * will fail closed (needs_human) for assets whose claims[] is empty, because
 * it cannot run extraction.
 */
export interface ClaimVerificationGateOptions {
  /**
   * Gemini adapter for running claimExtract.
   * If absent, the gate will not call Gemini (fails closed for empty claims).
   */
  adapter?: ClaimExtractionAdapter;
  /**
   * Ledger port for recording extraction costs.
   * If absent, costs are not recorded (acceptable for tests).
   */
  ledger?: ClaimExtractionLedgerPort;
  /**
   * Customer ID for the ledger row (null for owned-net assets).
   */
  customerId?: string | null;
  /**
   * Model override for extraction.
   */
  modelId?: string;
  /**
   * IC-03 fix: Per-run budget tracker.
   * When supplied, budget.isWithinCeiling() is checked before the Gemini call
   * and budget.recordUsage(usage.usd) is called after, enforcing the §11
   * per-run ceiling across BOTH generation and extraction call types (mirroring
   * multilingualContent.ts).
   */
  budget?: QgenRunBudget;
}

/**
 * Build the text of the asset body for extraction.
 * Delegates to extractBodyText (same logic as claimExtract.ts).
 */
function extractBodyText(asset: ContentAsset): string {
  const body = asset.body;
  switch (body.content_type) {
    case "definition":
      return body.text;
    case "answer_block":
      return body.text;
    case "faq":
      return body.rows.map((r) => `${r.q} ${r.a}`).join(" ");
    case "comparison": {
      const cols = body.columns.join(" ");
      const rows = body.rows
        .map((r) => `${r.entity} ${r.cells.map((c) => c.value).join(" ")}`)
        .join(" ");
      return `${cols} ${rows}`;
    }
    case "case_study":
      return [body.situation, body.action, body.result].join(" ");
    case "jsonld":
      try {
        return JSON.stringify(body.json);
      } catch {
        return "";
      }
  }
}

/**
 * Create a claimVerificationGate (§7#7) with injected adapter + ledger.
 *
 * Returns a gate object compatible with the ContentGate interface.
 *
 * ASYNC: this gate's apply() is async because extractClaims() is async.
 * runContentGates() must await each gate's apply() when the gate is paid.
 */
export function createClaimVerificationGate(
  opts: ClaimVerificationGateOptions = {}
): {
  name: string;
  phase: "content";
  apply(ctx: ContentGateContext): Promise<ContentGateResult>;
} {
  const { adapter, ledger, customerId = null, modelId, budget } = opts;

  return {
    name: "claimVerificationGate",
    phase: "content" as const,

    async apply(ctx: ContentGateContext): Promise<ContentGateResult> {
      const { asset } = ctx;
      let claims = asset.claims;
      let extractionFailed = false;

      // ---- Step 1: extract claims if not already present ----
      if (claims.length === 0) {
        if (adapter === undefined || ledger === undefined) {
          // No adapter available — cannot extract.
          // Body text may still have numeric/superlative content.
          // Fail closed: if body has any text, route to needs_human.
          const bodyText = extractBodyText(asset);
          if (bodyText.trim().length === 0) {
            // Empty body — nothing to verify
            return { action: "pass", gate: "claimVerificationGate" };
          }
          // Adapter absent → treat as extraction failed for verifyAndDecide
          extractionFailed = true;
        } else {
          // Run Gemini extraction (IC-03: pass budget for per-run ceiling enforcement)
          const extractResult = await extractClaims({
            adapter,
            body: asset.body,
            language: asset.language,
            ledger,
            customerId,
            ...(modelId !== undefined ? { modelId } : {}),
            ...(budget !== undefined ? { budget } : {}),
          });

          if (!extractResult.ok) {
            // Extraction failed → fail closed
            extractionFailed = true;
            // claims remains []
          } else {
            claims = extractResult.claims;
          }
        }
      }

      // ---- Step 2: run verifyAndDecide (pure deterministic) ----
      const result = verifyAndDecide({
        body: asset.body,
        language: asset.language,
        claims,
        sources: ctx.claimSources,
        extractionFailed,
      });

      // ---- W1.1: persist the RESOLVED claims back onto the asset ----
      // verifyAndDecide returns claims with resolved_source_id + verification
      // set. Previously these were discarded, so the (paid) extraction was
      // thrown away: re-gating (reviewClaims) had to re-extract, and the
      // geoReadiness evidence_binding pillar was structurally always-false.
      // Writing them back onto ctx.asset lets the caller (assembleContentSet)
      // persist them via updateAssetGateStatus. This is decision-invariant
      // WITHIN a single fold (this gate runs last, so the mutation is
      // post-decision), but it intentionally changes the PERSISTED state that
      // SUBSEQUENT folds (re-gate) read — including resolved_source_id stamped
      // on needs_human/rejected claims. The cheap gates' resolved_source_id
      // checks stay §7-safe only while this gate runs LAST (see W1.1 P2 note in
      // verifiableNumbers.ts / claimVerify.ts isClaimVerified).
      asset.claims = result.claims;

      // ---- Step 3: map VerifyDecision to ContentGateResult ----
      switch (result.decision) {
        case "pass":
          return { action: "pass", gate: "claimVerificationGate" };

        case "block":
          return {
            action: "block",
            gate: "claimVerificationGate",
            reason: result.reason ?? "Claim verification: numeric claim exceeds source bound.",
          };

        case "needs_human":
          return {
            action: "needs_human",
            gate: "claimVerificationGate",
            reason:
              result.reason ??
              "Claim verification: unresolved superlative/claim or extraction failed — human review required.",
          };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default no-adapter instance (structural stub for wiring in contentGate.ts)
// ---------------------------------------------------------------------------

/**
 * Default claimVerificationGate with no adapter.
 *
 * When used without an adapter, the gate:
 * - Passes empty-body assets (nothing to verify).
 * - Routes non-empty assets with empty claims[] to needs_human (fail closed).
 * - Runs verifyAndDecide() on assets with pre-populated claims[].
 *
 * Production use: inject a real GeminiAdapter via createClaimVerificationGate().
 */
export const claimVerificationGate = createClaimVerificationGate();
