/**
 * src/content/contentGate.ts
 *
 * T12 — ContentGate interface + runContentGates() non-short-circuit fold.
 *
 * DESIGN-phase2.md §"§7 Guardrail Gates":
 *
 *   runContentGates(gates, ctx): NON-SHORT-CIRCUIT fold — runs EVERY content
 *   gate, collects all verdicts into gate_report, then sets terminal gate_status:
 *     - blocked    if any gate returned 'block'
 *     - needs_human if any gate returned 'needs_human' (and no block)
 *     - passed     otherwise (all gates passed)
 *
 * COST SHORT-CIRCUIT: the paid claimVerificationGate is skipped if the asset
 * has already been blocked by one or more cheap structural gates.  This is
 * NOT a verdict short-circuit — verdicts from cheap gates are still all
 * collected in gate_report.  Verdict collection is always non-short-circuit;
 * only the paid Gemini call is skipped for already-blocked assets.
 *
 * Gate ordering (cheap structural first, paid last):
 *   1. phrasingVariationGate  (§7#1) — cheap
 *   2. verifiableNumbersGate  (§7#2) — cheap
 *   3. noFakeSignalsGate      (§7#3) — cheap
 *   4. disclosureGate         (§7#6) — cheap
 *   5. jsonLdShapeGate        (jsonld only) — cheap
 *   6. claimVerificationGate  (§7#7) — PAID (Gemini) — skipped if blocked
 *
 * ContentGate interface:
 *   - phase: 'content' (the GatePhase tag added by T04)
 *   - apply(ctx): ContentGateResult | Promise<ContentGateResult>
 *
 * ContentGateRegistry: ordered registry for content gates; mirrors
 * GateRegistry from gate.ts but for ContentGate/ContentGateContext.
 *
 * PARALLEL FOLD — does NOT use the Phase 0/1 Gate/GateContext/runGates
 * interface.  The measurement runGates() skips content-phase gates naturally
 * (phase filter), and this fold is completely separate.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import type { ContentGateContext, ContentGateResult } from "./types.js";

// ---------------------------------------------------------------------------
// ContentGate interface
// ---------------------------------------------------------------------------

/**
 * A Phase 2 content guardrail gate.
 *
 * Operates on ContentGateContext (asset/siblings/claims) rather than the
 * measurement-shaped MutableVerdict/GateContext.
 *
 * apply() may be sync or async (the paid claimVerificationGate is async
 * because it calls Gemini via extractClaims).
 *
 * Phase tag 'content' must match the GatePhase union extended by T04.
 */
export interface ContentGate {
  /** Unique name used in gate_report entries and registry. */
  name: string;
  /** Must be 'content' — this is the parallel Phase 2 fold. */
  phase: "content";
  /**
   * Evaluate the content asset and return a pass / block / needs_human result.
   * May be async for paid gates (claimVerification calls Gemini).
   */
  apply(
    ctx: ContentGateContext
  ): ContentGateResult | Promise<ContentGateResult>;
}

// ---------------------------------------------------------------------------
// Gate verdict entry stored in gate_report
// ---------------------------------------------------------------------------

/**
 * One entry in the gate_report audit trail (§12).
 * gate_report contains an entry for EVERY gate, regardless of outcome —
 * this is the non-short-circuit §12 audit contract.
 */
export interface GateReportEntry {
  gate: string;
  action: "pass" | "block" | "needs_human";
  reason?: string;
}

// ---------------------------------------------------------------------------
// runContentGates — NON-SHORT-CIRCUIT fold
// ---------------------------------------------------------------------------

/**
 * Run all content gates for a given asset, collecting every verdict.
 *
 * NON-SHORT-CIRCUIT (§12 audit):
 *   Every gate runs and its verdict is recorded in gate_report, even if a
 *   previous gate blocked the asset.  This gives the §12 audit trail ALL
 *   §7 violations per asset, not just the first one found.
 *
 * COST SHORT-CIRCUIT (§11):
 *   The paid claimVerificationGate is identified by name
 *   ('claimVerificationGate') and skipped when the asset is already blocked
 *   by one or more cheap structural gates.  The gate still appears in
 *   gate_report as 'pass' with a 'skipped: blocked by prior gate' note, so
 *   the audit trail remains complete without paying for Gemini extraction on
 *   an asset that will be discarded anyway.
 *
 * Terminal gate_status precedence: blocked > needs_human > passed.
 *
 * @param gates - Ordered list of ContentGate objects (all must have phase:'content').
 * @param ctx   - ContentGateContext carrying the asset, siblings, and claim sources.
 * @returns {gateReport, terminalStatus}
 */
export async function runContentGates(
  gates: readonly ContentGate[],
  ctx: ContentGateContext
): Promise<{
  gateReport: GateReportEntry[];
  terminalStatus: "passed" | "blocked" | "needs_human";
}> {
  const gateReport: GateReportEntry[] = [];

  let hasBlock = false;
  let hasNeedsHuman = false;

  for (const gate of gates) {
    // COST SHORT-CIRCUIT: skip the paid Gemini gate if already blocked.
    // The cheap gates have already decided this asset is rejected; no need
    // to pay for claim extraction.  Record a skipped entry in gate_report
    // so the §12 audit trail is complete.
    if (gate.name === "claimVerificationGate" && hasBlock) {
      gateReport.push({
        gate: gate.name,
        action: "pass",
        reason: "skipped: asset already blocked by a cheap structural gate — Gemini extraction not invoked",
      });
      continue;
    }

    // Run the gate (may be async for the paid gate).
    const result = await gate.apply(ctx);

    gateReport.push({
      gate: result.gate,
      action: result.action,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    });

    if (result.action === "block") {
      hasBlock = true;
    } else if (result.action === "needs_human") {
      hasNeedsHuman = true;
    }
    // action === 'pass': continue — verdict already recorded.
  }

  // Terminal gate_status: block > needs_human > passed
  const terminalStatus: "passed" | "blocked" | "needs_human" = hasBlock
    ? "blocked"
    : hasNeedsHuman
    ? "needs_human"
    : "passed";

  return { gateReport, terminalStatus };
}

// ---------------------------------------------------------------------------
// ContentGateRegistry
// ---------------------------------------------------------------------------

/**
 * Ordered registry for content gates.
 *
 * Mirrors the Phase 0 GateRegistry from gate.ts but for ContentGate /
 * ContentGateContext.  Gates are stored in insertion order; runContentGates()
 * receives the ordered list and runs them in that order.
 *
 * DESIGN: The canonical gate order (cheap structural first, paid last) should
 * be established at registry build time (see defaultContentGateRegistry below).
 */
export class ContentGateRegistry {
  private readonly _gates: ContentGate[] = [];

  /** Add a gate to the end of the execution order. */
  register(gate: ContentGate): this {
    this._gates.push(gate);
    return this;
  }

  /** Return a snapshot of registered gates (insertion order). */
  gates(): readonly ContentGate[] {
    return this._gates;
  }

  /**
   * Run all registered content gates against the given context.
   * Delegates to runContentGates().
   */
  async run(
    ctx: ContentGateContext
  ): Promise<{
    gateReport: GateReportEntry[];
    terminalStatus: "passed" | "blocked" | "needs_human";
  }> {
    return runContentGates(this._gates, ctx);
  }
}

// ---------------------------------------------------------------------------
// Default content gate registry (canonical order: cheap structural first)
// ---------------------------------------------------------------------------

import { phrasingVariationGate } from "./gates/phrasingVariation.js";
import { verifiableNumbersGate } from "./gates/verifiableNumbers.js";
import { noFakeSignalsGate } from "./gates/noFakeSignals.js";
import { disclosureGate } from "./gates/disclosure.js";
import { jsonLdShapeGate } from "./gates/jsonLdShape.js";
import { claimVerificationGate, createClaimVerificationGate } from "./gates/claimVerification.js";
import { adversarialBlocklistGate } from "./gates/adversarialBlocklist.js";
import { selfContainednessGate } from "./gates/selfContainedness.js";
import { noFabricatedPersonaGate } from "./gates/noFabricatedPersona.js";
import { keywordStuffingGate } from "./gates/keywordStuffing.js";
import { geoReadinessGate } from "./gates/geoReadiness.js";
import type { ClaimExtractionAdapter, ClaimExtractionLedgerPort } from "./claimExtract.js";
import type { QgenRunBudget } from "../cost/qgenBudget.js";

/**
 * Default content gate registry in canonical order:
 *
 * Cheap structural gates run first so blocked assets NEVER pay for
 * Gemini claim extraction:
 *   1. phrasingVariationGate  (§7#1)  — pure Jaccard
 *   2. verifiableNumbersGate  (§7#2)  — lexicon + structural
 *   3. noFakeSignalsGate      (§7#3)  — structural patterns
 *   4. disclosureGate         (§7#6)  — structural
 *   5. jsonLdShapeGate        (jsonld) — structural schema
 *   6. claimVerificationGate  (§7#7)  — PAID Gemini (skipped if blocked)
 *
 * The default claimVerificationGate is the no-adapter instance (fails closed
 * for empty claims).  Production use: buildProductionContentGateRegistry().
 */
export const defaultContentGateRegistry: ContentGateRegistry =
  new ContentGateRegistry()
    .register(phrasingVariationGate)
    .register(verifiableNumbersGate)
    .register(noFakeSignalsGate)
    .register(adversarialBlocklistGate)
    .register(selfContainednessGate)
    .register(noFabricatedPersonaGate)
    .register(keywordStuffingGate)
    .register(disclosureGate)
    .register(jsonLdShapeGate)
    .register(geoReadinessGate)
    .register(claimVerificationGate);

// ---------------------------------------------------------------------------
// Production registry factory (CO-2 / IC-02 fix)
// ---------------------------------------------------------------------------

/**
 * Options for building a production-wired content gate registry.
 */
export interface ProductionGateRegistryOptions {
  /**
   * Live Gemini adapter for claim extraction.
   * Required for the §7#7 claimVerificationGate to run extraction.
   */
  adapter: ClaimExtractionAdapter;
  /**
   * Ledger port for recording claim extraction costs.
   */
  ledger: ClaimExtractionLedgerPort;
  /**
   * Customer UUID for the ledger row (null for owned-net generic assets).
   */
  customerId?: string | null;
  /**
   * Per-run budget tracker (IC-03 fix): isWithinCeiling() is checked before
   * the Gemini extraction call; recordUsage() is called after, enforcing the
   * §11 per-run ceiling across BOTH generation and extraction call types.
   */
  budget?: QgenRunBudget;
}

/**
 * Build a production ContentGateRegistry with the REAL Gemini-adapter-backed
 * claimVerificationGate (§7#7).
 *
 * CO-2/IC-02 fix: the CLI entry points (genContent, gateContent) MUST call
 * this factory rather than defaultContentGateRegistry so that:
 *   - claim extraction actually runs (instead of failing closed due to the
 *     no-adapter stub), and
 *   - every answer_block with numeric/sourced claims can reach gate_status='passed'.
 *
 * The no-adapter defaultContentGateRegistry is preserved for test isolation.
 *
 * @param opts  Adapter, ledger, customerId, and optional budget for the paid gate.
 * @returns     ContentGateRegistry with all five gates in canonical cheap-first order.
 */
export function buildProductionContentGateRegistry(
  opts: ProductionGateRegistryOptions
): ContentGateRegistry {
  const productionClaimGate = createClaimVerificationGate({
    adapter: opts.adapter,
    ledger: opts.ledger,
    customerId: opts.customerId ?? null,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  });

  return new ContentGateRegistry()
    .register(phrasingVariationGate)
    .register(verifiableNumbersGate)
    .register(noFakeSignalsGate)
    .register(adversarialBlocklistGate)
    .register(selfContainednessGate)
    .register(noFabricatedPersonaGate)
    .register(keywordStuffingGate)
    .register(disclosureGate)
    .register(jsonLdShapeGate)
    .register(geoReadinessGate)
    .register(productionClaimGate);
}
