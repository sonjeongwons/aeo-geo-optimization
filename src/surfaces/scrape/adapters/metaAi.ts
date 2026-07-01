/**
 * Meta AI (Llama) — scrape surface adapter.
 *
 * DESIGN-phase4.md T10 / SPEC.md §4 (surfaces/tiers, scrape), §12 (compliance).
 *
 * KEY INVARIANTS:
 *   - THIS ADAPTER USES RPA RUNNER (scrape) — Meta AI has no public monitoring API.
 *   - §12 compliance guard: assertNotSerpOnly("metaAi") confirms this surface is
 *     NOT in SERP_ONLY_SURFACES, so RPA construction is permitted.
 *   - DISABLED BY DEFAULT: status='not_configured' until an RPA runner is armed
 *     (RPA_RUNNER_URL env var set). generate() returns NOT_CONFIGURED until then.
 *   - When armed, delegates to SurfaceAdapter (T07) which orchestrates
 *     run → parse (MetaAiParser, T09) → return prose.
 *   - judge() always returns NOT_CONFIGURED (surface adapters are not judges).
 *   - nSamples is clamped to 1 upstream (T13); this adapter is single-call.
 *
 * PROSE/CITATION SEPARATION:
 *   MetaAiParser (T09) puts ONLY prose in answerText; citations are packed
 *   separately in meta.citations by SurfaceAdapter (T07).
 *   The judge sees clean prose — no URL/title noise.
 *
 * TARGET URL:
 *   Meta AI is accessed at https://www.meta.ai.
 *   The RPA runner navigates there, submits the query, waits for the AI
 *   response container, and returns a MetaAiSnapshot or raw HTML.
 *
 * MARKET:
 *   Meta AI is a global English-first surface (en, es, pt, fr, de, it, ar).
 *   nativeReview is NOT set — no market-language gating for English-first surfaces.
 *
 * Pure module — no pg, no @google/genai.
 */

import { makeSurfaceAdapter } from "../../SurfaceAdapter.js";
import type { SurfaceAdapter } from "../../SurfaceAdapter.js";
import { metaAiParser } from "../parse/metaAiParser.js";
import type { RpaRunner, RpaRequest } from "../rpaRunner.js";
import { assertNotSerpOnly } from "../../compliance.js";
import type { SurfaceId } from "../../types.js";

// ---------------------------------------------------------------------------
// Compliance guard — enforced at module load time
// ---------------------------------------------------------------------------

// Confirm that "metaAi" is NOT in SERP_ONLY_SURFACES.
// This allows RPA construction for Meta AI (no official SERP API exists for it).
assertNotSerpOnly("metaAi" satisfies SurfaceId);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target URL for the Meta AI web interface. */
const META_AI_URL = "https://www.meta.ai";

/**
 * Default timeout (ms) to wait for Meta AI's answer to render.
 * Meta AI uses streaming generation; 45 s allows for slower Llama responses.
 */
const META_AI_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// buildRpaRequest — translate a pipeline prompt into an RpaRequest
// ---------------------------------------------------------------------------

/**
 * Build an RpaRequest for a Meta AI scrape.
 *
 * @param prompt   The pipeline's question text.
 * @param language ISO 639-1 language code (e.g. "en", "es", "pt").
 * @returns        RpaRequest targeting www.meta.ai.
 */
function buildMetaAiRpaRequest(
  prompt: string,
  language: string
): RpaRequest {
  return {
    targetUrl: META_AI_URL,
    query: prompt,
    language,
    timeoutMs: META_AI_TIMEOUT_MS,
    params: {
      // Hint to the RPA runner: wait for the AI response container selector.
      waitSelector: '[data-testid="ai-response"]',
      // Surface identifier — allows a shared RPA runner to dispatch.
      surface: "metaAi",
    },
  };
}

// ---------------------------------------------------------------------------
// makeMetaAiAdapter — factory
// ---------------------------------------------------------------------------

/**
 * Create a Meta AI (Llama) scrape surface adapter.
 *
 * The adapter wraps `SurfaceAdapter` (T07) configured with:
 *   - kind: "scrape"         (RPA runner path)
 *   - surfaceId: "metaAi"
 *   - runner: the provided RpaRunner (NotConfiguredRpaRunner or fixture)
 *   - parser: MetaAiParser (T09) — prose-only, citations separate
 *   - buildRpaRequest: translates prompt → meta.ai RPA params
 *
 * The adapter's `status` reflects the runner's armed state:
 *   - 'not_configured' when runner.configured === false (stub/no runner)
 *   - 'ready'          when runner.configured === true  (runner available)
 *
 * §12 compliance: Meta AI IS permitted via RPA (no official SERP API available).
 * assertNotSerpOnly guard above confirms this at module-load time.
 *
 * DISABLED BY DEFAULT: The surface registry (T11) wires a NotConfiguredRpaRunner
 * by default. The surface activates only when RPA_RUNNER_URL is set.
 *
 * @param runner  RpaRunner to use. Typically `makeRpaRunner(env)` in production,
 *                or `new FixtureRpaRunner(raw)` in tests.
 * @returns       A SurfaceAdapter configured for Meta AI.
 */
export function makeMetaAiAdapter(runner: RpaRunner): SurfaceAdapter {
  return makeSurfaceAdapter({
    kind: "scrape",
    surfaceId: "metaAi",
    runner,
    parser: metaAiParser,
    buildRpaRequest: buildMetaAiRpaRequest,
  });
}
