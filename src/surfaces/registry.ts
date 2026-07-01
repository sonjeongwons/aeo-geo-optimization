/**
 * Surface v1-b registry — builds all v1-b surface adapters (stubs today).
 *
 * DESIGN-phase4.md T11 / SPEC.md §4 (surfaces/tiers), §12 (compliance).
 *
 * INVARIANTS:
 *   - All v1-b surfaces start as NOT_CONFIGURED stubs until keys/runners arrive.
 *   - SERP surfaces (googleAio, naverAi) are wired with makeSerpClient(env) —
 *     today always NotConfiguredSerpClient (no SERP_API_KEY).
 *   - Scrape surfaces (copilot, metaAi, line, kakao) are wired with makeRpaRunner(env) —
 *     today always NotConfiguredRpaRunner (no RPA_RUNNER_URL).
 *   - §12 compliance: googleAio and naverAi are ONLY constructible via SerpClient
 *     (never RpaRunner). This is enforced by construction in their adapter factories
 *     (assertSerpOnly guard in googleAio.ts / naverAi.ts).
 *   - chat/API v1-b surfaces (mistral, deepseek, copilotApi) are registered in
 *     providers/registry.ts (not here) — they use the existing stub adapter pattern.
 *   - The surface registry is separate from the provider registry; the two are merged
 *     in providers/registry.ts via buildRegistry() (see additive wiring below).
 *
 * ADDITIVE:
 *   This module is NEW; it does not modify any Phase 0-3 file's exports.
 *   providers/registry.ts imports and calls buildSurfaceRegistry() to merge surfaces
 *   into the existing ProviderRegistry without touching existing adapter entries.
 *
 * Pure module — no pg, no @google/genai.
 */

import type { ProviderAdapter, ProviderReadiness } from "../providers/types.js";
import { makeSerpClient } from "./serp/serpClient.js";
import { makeRpaRunner } from "./scrape/rpaRunner.js";
import { makeGoogleAioAdapter } from "./serp/adapters/googleAio.js";
import { makeGoogleAiModeAdapter } from "./serp/adapters/googleAiMode.js";
import { makeNaverAiAdapter } from "./serp/adapters/naverAi.js";
import { makeCopilotAdapter } from "./scrape/adapters/copilot.js";
import { makeMetaAiAdapter } from "./scrape/adapters/metaAi.js";
import { makeLineAdapter } from "./scrape/adapters/line.js";
import { makeKakaoAdapter } from "./scrape/adapters/kakao.js";
import type { SurfaceId } from "./types.js";

// ---------------------------------------------------------------------------
// SurfaceRegistry interface
// ---------------------------------------------------------------------------

/**
 * Registry of all v1-b surface adapters.
 *
 * Surface adapters implement ProviderAdapter so they slot directly into the
 * existing runResponse → judge → SMR pipeline without any core changes.
 *
 * The surface registry is built separately from the provider registry and then
 * merged into it by buildRegistry() in providers/registry.ts. This keeps the
 * Phase 0-3 provider registry unchanged while adding v1-b surfaces additively.
 */
export interface SurfaceRegistry {
  /**
   * Get a surface adapter by its SurfaceId.
   * Returns undefined if the surfaceId is unknown.
   */
  get(surfaceId: SurfaceId): ProviderAdapter | undefined;

  /**
   * List all registered surface adapters.
   */
  all(): ProviderAdapter[];

  /**
   * Readiness summary for all surface adapters.
   * Stubs are reported as 'not_configured' (mirrors provider registry behavior).
   */
  readiness(): ProviderReadiness[];
}

// ---------------------------------------------------------------------------
// buildSurfaceRegistry — factory
// ---------------------------------------------------------------------------

/**
 * Build and return a SurfaceRegistry with all v1-b surface adapters.
 *
 * Today, ALL surface adapters are NOT_CONFIGURED stubs:
 *   - SERP surfaces: NotConfiguredSerpClient (no SERP_API_KEY)
 *   - Scrape surfaces: NotConfiguredRpaRunner (no RPA_RUNNER_URL)
 *
 * When keys/runners arrive:
 *   - Set SERP_API_KEY → makeSerpClient returns a real client → googleAio / naverAi arm
 *   - Set RPA_RUNNER_URL → makeRpaRunner returns a real runner → scrape surfaces arm
 *
 * §12 compliance is enforced by construction:
 *   - googleAio / naverAi adapters ONLY accept a SerpClient (never RpaRunner)
 *   - assertSerpOnly guard runs at module-load time in each adapter file
 *
 * @param env  Env variable map (default: process.env). Injected for testability.
 * @returns    A SurfaceRegistry with all v1-b surfaces registered.
 */
export function buildSurfaceRegistry(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): SurfaceRegistry {
  // Build client/runner seams (stubs until keys are set)
  const serpClient = makeSerpClient(env);
  const rpaRunner = makeRpaRunner(env);

  // Build all surface adapters
  // SERP-only (§12 compliance: SerpClient path, not RpaRunner)
  const googleAio = makeGoogleAioAdapter(serpClient);
  const googleAiMode = makeGoogleAiModeAdapter(serpClient);
  const naverAi = makeNaverAiAdapter(serpClient);

  // Scrape surfaces (RPA runner path; disabled until RPA_RUNNER_URL is set)
  const copilot = makeCopilotAdapter(rpaRunner);
  const metaAi = makeMetaAiAdapter(rpaRunner);
  const line = makeLineAdapter(rpaRunner);
  const kakao = makeKakaoAdapter(rpaRunner);

  // Build the surface adapter map keyed by surfaceId (= adapter.provider)
  const adapters = new Map<string, ProviderAdapter>([
    ["googleAio",    googleAio],
    ["googleAiMode", googleAiMode],
    ["naverAi",      naverAi],
    ["copilot",   copilot],
    ["metaAi",    metaAi],
    ["line",      line],
    ["kakao",     kakao],
  ]);

  return {
    get(surfaceId: SurfaceId): ProviderAdapter | undefined {
      return adapters.get(surfaceId);
    },

    all(): ProviderAdapter[] {
      return [...adapters.values()];
    },

    readiness(): ProviderReadiness[] {
      return [...adapters.values()].map((a) => ({
        provider: a.provider,
        // Surface adapters are never 'stub' — they are 'ready' when armed,
        // 'not_configured' when not armed. Mirror provider registry convention:
        // report the adapter's actual status directly.
        status: a.status === "stub" ? "not_configured" : a.status,
        modality: a.modality,
      }));
    },
  };
}
