/**
 * src/surfaces/wireSurfaces.ts
 *
 * Shared helper — wire v1-b surface adapters into a plan's model list + adapter map.
 *
 * DESIGN-phase4.md ICS-01:
 *   The CLI diagnose path already calls selectEligibleSurfaceAdapters and merges
 *   surface adapters/models into the plan.  The operating weekly worker (index.ts
 *   depsFactory) and the API /diagnose baseline (server.ts) previously skipped this
 *   step, so surfaces were never measured on those two entry points.
 *
 *   This module extracts the CLI wiring block into one canonical place so that all
 *   three entry points get identical surface-wiring behavior.
 *
 * INVARIANTS (preserved from CLI implementation):
 *   - NOT_CONFIGURED surfaces (status !== 'ready') are excluded by
 *     selectEligibleSurfaceAdapters — they produce zero useful work.
 *   - Scrape surfaces are excluded from 'baseline' runs per SPEC §4/§12.
 *   - Surface adapter.provider is used as both the synthetic model ID and the
 *     adapter map key (mirrors CLI path exactly).
 *   - Surfaces are flat-rate (not token-based): inputUsdPerMtok / outputUsdPerMtok = 0.
 *
 * Pure module — no IO, no pg, no @google/genai.
 */

import pino from "pino";
import { selectEligibleSurfaceAdapters } from "./surfaceSelection.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { ModelRef, RunKind } from "../domain/types.js";

const log = pino({ name: "surfaces.wireSurfaces" });

// ---------------------------------------------------------------------------
// WireSurfacesInput
// ---------------------------------------------------------------------------

/**
 * Input for wireSurfaces.
 *
 * @param registryAdapters  All registered ProviderAdapters from registry.all()
 *                          (both v1-a chat and v1-b SERP/scrape).
 * @param runKind           'baseline' | 'operating' — determines whether scrape
 *                          surfaces are included.
 */
export interface WireSurfacesInput {
  registryAdapters: ProviderAdapter[];
  runKind: RunKind;
}

// ---------------------------------------------------------------------------
// WireSurfacesResult
// ---------------------------------------------------------------------------

/**
 * Result of surface wiring.
 *
 * @param surfaceModels   ModelRef list for all eligible surface adapters.
 *                        Append to the chat models list before building the plan.
 * @param surfaceAdapters Map of provider (surfaceId) → adapter for all eligible
 *                        surface adapters.  Merge into the existing adapters map.
 */
export interface WireSurfacesResult {
  surfaceModels: ModelRef[];
  surfaceAdapters: Map<string, ProviderAdapter>;
}

// ---------------------------------------------------------------------------
// wireSurfaces
// ---------------------------------------------------------------------------

/**
 * Select eligible v1-b surface adapters and produce the surface model refs +
 * adapter map entries needed to extend a plan with surface measurements.
 *
 * Call this from every entry point that builds RunCycleDeps so that surface
 * adapters are consistently wired regardless of how the run is triggered.
 *
 * Usage:
 *   const { surfaceModels, surfaceAdapters } = wireSurfaces({
 *     registryAdapters: registry.all(),
 *     runKind,
 *   });
 *   // Merge into the existing adapters map:
 *   for (const [key, adapter] of surfaceAdapters) {
 *     adapters.set(key, adapter);
 *   }
 *   // Append to models list:
 *   const models = [...chatModels, ...surfaceModels];
 *
 * @param input  registryAdapters + runKind.
 * @returns      surfaceModels + surfaceAdapters ready to merge into deps.
 */
export function wireSurfaces(input: WireSurfacesInput): WireSurfacesResult {
  const { registryAdapters, runKind } = input;

  const surfaceSelectionResult = selectEligibleSurfaceAdapters({
    adapters: registryAdapters,
    runKind,
  });

  if (surfaceSelectionResult.droppedCount > 0) {
    log.debug(
      {
        droppedCount: surfaceSelectionResult.droppedCount,
        notReady: surfaceSelectionResult.droppedReasons.notReady,
        scrapeOnBaseline: surfaceSelectionResult.droppedReasons.scrapeOnBaseline,
      },
      "wireSurfaces: surface adapters dropped (not_configured or scrape-on-baseline)",
    );
  }

  const surfaceModels: ModelRef[] = [];
  const surfaceAdapters = new Map<string, ProviderAdapter>();

  for (const surfaceAdapter of surfaceSelectionResult.eligible) {
    surfaceAdapters.set(surfaceAdapter.provider, surfaceAdapter);
    surfaceModels.push({
      id: surfaceAdapter.provider,        // surfaceId used as synthetic model ID
      provider: surfaceAdapter.provider,  // surfaceId used as provider key too
      modality: surfaceAdapter.modality,  // "serp" | "scrape"
      capabilities: surfaceAdapter.capabilities,
      isCheapMonitor: false,              // surfaces are not cheap-monitor chat models
      isJudge: false,                     // surfaces never act as judge
      inputUsdPerMtok: 0,                 // SERP/scrape surfaces are flat-rate, not token-based
      outputUsdPerMtok: 0,
      enabled: true,
    });
  }

  log.debug(
    {
      runKind,
      surfaceModelCount: surfaceModels.length,
      eligibleSurfaces: surfaceModels.map((m) => m.id),
    },
    "wireSurfaces: wired surface adapters",
  );

  return { surfaceModels, surfaceAdapters };
}
