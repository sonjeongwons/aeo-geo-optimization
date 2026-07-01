/**
 * Surface selection — filters the v1-b surface adapter set for a given run context.
 *
 * DESIGN-phase4.md T12 / SPEC.md §4 (surfaces/tiers), §5 (measurement).
 *
 * INVARIANTS (hard rules from the DESIGN + SPEC):
 *
 *   1. NOT-CONFIGURED EXCLUDED:
 *      Any surface adapter whose `status` is NOT 'ready' (i.e. 'not_configured'
 *      or 'stub') is excluded from the eligible set.  A not-configured surface
 *      has no key/runner and will return NOT_CONFIGURED for every generate() call,
 *      producing zero useful work-units.  Dropping them here avoids scheduling
 *      zero-yield work and keeps the SMR denominator (n_total) accurate.
 *
 *   2. SCRAPE SURFACES EXCLUDED FROM BASELINE:
 *      Scrape (RPA/headless-browser) surfaces are excluded from the BASELINE run
 *      path.  Baseline runs establish ground-truth brand-mention rates using
 *      API-grade (deterministic) sources.  Scrape surfaces are non-deterministic,
 *      infrastructure-dependent, and disabled by default — they participate only
 *      in OPERATING runs where the extended surface set is desired.
 *
 *      The SERP surfaces (googleAio, naverAi) ARE included in baseline when armed,
 *      because they are accessed via an official API (§12) and are deterministic.
 *
 *   3. CHAT SURFACES ARE NOT FILTERED HERE:
 *      Chat (API) surfaces are managed by the provider registry and plan builder
 *      (not this module).  `selectEligibleSurfaces` only filters the v1-b
 *      SERP/scrape surface set (modality !== 'chat').  Passing chat adapters
 *      through is a no-op safe: they are already handled upstream.
 *
 *   4. PURE, NO IO:
 *      This function is purely functional — no DB reads, no network calls.
 *      The caller (pipeline/runCycle.ts, cli/diagnose.ts, scheduler/worker.ts)
 *      is responsible for fetching the adapters from the registry and the run
 *      kind from the current run context.
 *
 * Pure module — no IO, no pg, no @google/genai.
 */

import type { ProviderAdapter } from "../providers/types.js";
import type { RunKind } from "../domain/types.js";

// ---------------------------------------------------------------------------
// SurfaceSelectionInput
// ---------------------------------------------------------------------------

/**
 * Input for surface selection.
 *
 * @param adapters  All registered ProviderAdapters (both v1-a chat and v1-b
 *                  SERP/scrape).  Only the non-chat adapters are filtered here;
 *                  chat adapters pass through unchanged.
 * @param runKind   The kind of run being planned ('baseline' | 'operating').
 *                  Determines whether scrape surfaces are included.
 */
export interface SurfaceSelectionInput {
  adapters: ProviderAdapter[];
  runKind: RunKind;
}

// ---------------------------------------------------------------------------
// SurfaceSelectionResult
// ---------------------------------------------------------------------------

/**
 * Result of surface selection.
 *
 * @param eligible       Adapters that passed all selection filters.
 *                       These are safe to pass to the plan builder as the model list.
 * @param droppedCount   Total number of adapters that were excluded, for logging.
 * @param droppedReasons Diagnostic breakdown of why adapters were dropped.
 *                       Keys match the drop reason strings used internally.
 */
export interface SurfaceSelectionResult {
  eligible: ProviderAdapter[];
  droppedCount: number;
  droppedReasons: {
    /** Dropped because status !== 'ready' (not_configured or stub). */
    notReady: number;
    /** Dropped because modality === 'scrape' on a 'baseline' run. */
    scrapeOnBaseline: number;
  };
}

// ---------------------------------------------------------------------------
// selectEligibleSurfaces — main entry point
// ---------------------------------------------------------------------------

/**
 * Filter a list of ProviderAdapters to the eligible subset for a given run.
 *
 * Applies the two surface selection invariants (see module-level docs):
 *   1. NOT_CONFIGURED / stub adapters are excluded.
 *   2. Scrape surfaces are excluded from baseline runs.
 *
 * All other adapters (chat, ready SERP, ready scrape on operating runs) are
 * passed through.
 *
 * @param input  Selection input: adapter list + run kind.
 * @returns      Selection result with eligible list + drop diagnostics.
 */
export function selectEligibleSurfaces(
  input: SurfaceSelectionInput,
): SurfaceSelectionResult {
  const { adapters, runKind } = input;
  const isBaseline = runKind === "baseline";

  const eligible: ProviderAdapter[] = [];
  let notReady = 0;
  let scrapeOnBaseline = 0;

  for (const adapter of adapters) {
    // Rule 1: Exclude not-configured and stub adapters.
    // status === 'ready' is the ONLY accepted state.
    // 'not_configured' (key/runner absent) and 'stub' (unimplemented) both produce
    // NOT_CONFIGURED from generate(), yielding zero useful work.
    if (adapter.status !== "ready") {
      notReady++;
      continue;
    }

    // Rule 2: Exclude scrape surfaces from baseline runs.
    // Scrape surfaces (modality === 'scrape') are RPA/headless-browser based.
    // They are excluded from baseline because:
    //   a) They are disabled by default (no RPA runner until configured).
    //   b) Even when armed, they are non-deterministic / infrastructure-dependent.
    //   c) Baseline runs establish ground-truth using API-grade (deterministic) data.
    // SERP surfaces (modality === 'serp') ARE included in baseline when ready,
    // because they use an official API (§12 compliant) and are deterministic.
    if (adapter.modality === "scrape" && isBaseline) {
      scrapeOnBaseline++;
      continue;
    }

    // Passes all filters — include in eligible set.
    eligible.push(adapter);
  }

  const droppedCount = notReady + scrapeOnBaseline;

  return {
    eligible,
    droppedCount,
    droppedReasons: {
      notReady,
      scrapeOnBaseline,
    },
  };
}

// ---------------------------------------------------------------------------
// selectEligibleSurfaceAdapters — convenience wrapper (surfaces-only variant)
// ---------------------------------------------------------------------------

/**
 * Convenience variant of `selectEligibleSurfaces` that pre-filters to only
 * the v1-b SERP/scrape surfaces (modality !== 'chat') before applying the
 * selection rules.
 *
 * Use this when you want to select ONLY surface adapters from a unified
 * provider+surface adapter list, without the chat adapters flowing through.
 * The returned `eligible` list contains only serp/scrape adapters that are
 * ready and (for baseline) non-scrape.
 *
 * @param input  Selection input: unified adapter list + run kind.
 * @returns      Selection result containing only eligible surface adapters.
 */
export function selectEligibleSurfaceAdapters(
  input: SurfaceSelectionInput,
): SurfaceSelectionResult {
  // Pre-filter to non-chat (v1-b surface) adapters only.
  const surfaceAdapters = input.adapters.filter(
    (a) => a.modality !== "chat",
  );

  return selectEligibleSurfaces({
    adapters: surfaceAdapters,
    runKind: input.runKind,
  });
}
