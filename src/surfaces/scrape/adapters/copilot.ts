/**
 * Microsoft Copilot — scrape surface adapter.
 *
 * DESIGN-phase4.md T10 / SPEC.md §4 (surfaces/tiers, scrape), §12 (compliance).
 *
 * KEY INVARIANTS:
 *   - THIS ADAPTER USES RPA RUNNER (scrape) — Copilot has no public monitoring API.
 *   - §12 compliance guard: assertNotSerpOnly("copilot") confirms this surface is
 *     NOT in SERP_ONLY_SURFACES, so RPA construction is permitted.
 *   - DISABLED BY DEFAULT: status='not_configured' until an RPA runner is armed
 *     (RPA_RUNNER_URL env var set). generate() returns NOT_CONFIGURED until then.
 *   - When armed, delegates to SurfaceAdapter (T07) which orchestrates
 *     run → parse (CopilotParser, T09) → return prose.
 *   - judge() always returns NOT_CONFIGURED (surface adapters are not judges).
 *   - nSamples is clamped to 1 upstream (T13); this adapter is single-call.
 *
 * PROSE/CITATION SEPARATION:
 *   CopilotParser (T09) puts ONLY prose in answerText; citations are packed
 *   separately in meta.citations by SurfaceAdapter (T07).
 *   The judge sees clean prose — no URL/title noise.
 *
 * TARGET URL:
 *   Microsoft Copilot is accessed at https://copilot.microsoft.com.
 *   The RPA runner navigates there, submits the query, waits for the AI answer
 *   container, and returns a CopilotSnapshot or raw HTML.
 *
 * Pure module — no pg, no @google/genai.
 */

import { makeSurfaceAdapter } from "../../SurfaceAdapter.js";
import type { SurfaceAdapter } from "../../SurfaceAdapter.js";
import { copilotParser } from "../parse/copilotParser.js";
import type { RpaRunner, RpaRequest } from "../rpaRunner.js";
import { assertNotSerpOnly } from "../../compliance.js";
import type { SurfaceId } from "../../types.js";

// ---------------------------------------------------------------------------
// Compliance guard — enforced at module load time
// ---------------------------------------------------------------------------

// Confirm that "copilot" is NOT in SERP_ONLY_SURFACES.
// This allows RPA construction for Copilot (unlike googleAio / naverAi).
assertNotSerpOnly("copilot" satisfies SurfaceId);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target URL for the Microsoft Copilot web interface. */
const COPILOT_URL = "https://copilot.microsoft.com";

/**
 * Default timeout (ms) to wait for Copilot's AI answer to render.
 * Copilot uses streaming; 30 s is generous for most queries.
 */
const COPILOT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// buildRpaRequest — translate a pipeline prompt into an RpaRequest
// ---------------------------------------------------------------------------

/**
 * Build an RpaRequest for a Microsoft Copilot scrape.
 *
 * @param prompt   The pipeline's question text.
 * @param language ISO 639-1 language code (e.g. "en", "de", "ja").
 * @returns        RpaRequest targeting copilot.microsoft.com.
 */
function buildCopilotRpaRequest(
  prompt: string,
  language: string
): RpaRequest {
  return {
    targetUrl: COPILOT_URL,
    query: prompt,
    language,
    timeoutMs: COPILOT_TIMEOUT_MS,
    params: {
      // Hint to the RPA runner: wait for the answer container selector.
      waitSelector: '[data-testid="answer-section"]',
      // Surface identifier — allows a shared RPA runner to dispatch.
      surface: "copilot",
    },
  };
}

// ---------------------------------------------------------------------------
// makeCopilotAdapter — factory
// ---------------------------------------------------------------------------

/**
 * Create a Microsoft Copilot scrape surface adapter.
 *
 * The adapter wraps `SurfaceAdapter` (T07) configured with:
 *   - kind: "scrape"         (RPA runner path)
 *   - surfaceId: "copilot"
 *   - runner: the provided RpaRunner (NotConfiguredRpaRunner or fixture)
 *   - parser: CopilotParser (T09) — prose-only, citations separate
 *   - buildRpaRequest: translates prompt → copilot.microsoft.com RPA params
 *
 * The adapter's `status` reflects the runner's armed state:
 *   - 'not_configured' when runner.configured === false (stub/no runner)
 *   - 'ready'          when runner.configured === true  (runner available)
 *
 * §12 compliance: Copilot IS permitted via RPA (no SERP API available).
 * assertNotSerpOnly guard above confirms this at module-load time.
 *
 * DISABLED BY DEFAULT: The surface registry (T11) wires a NotConfiguredRpaRunner
 * by default. The surface activates only when RPA_RUNNER_URL is set.
 *
 * @param runner  RpaRunner to use. Typically `makeRpaRunner(env)` in production,
 *                or `new FixtureRpaRunner(raw)` in tests.
 * @returns       A SurfaceAdapter configured for Microsoft Copilot.
 */
export function makeCopilotAdapter(runner: RpaRunner): SurfaceAdapter {
  return makeSurfaceAdapter({
    kind: "scrape",
    surfaceId: "copilot",
    runner,
    parser: copilotParser,
    buildRpaRequest: buildCopilotRpaRequest,
  });
}
