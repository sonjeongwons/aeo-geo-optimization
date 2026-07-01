/**
 * Line AI — scrape surface adapter.
 *
 * DESIGN-phase4.md T10 / SPEC.md §4 (surfaces/tiers, scrape), §12 (compliance).
 *
 * KEY INVARIANTS:
 *   - THIS ADAPTER USES RPA RUNNER (scrape) — Line AI has no public monitoring API.
 *   - §12 compliance guard: assertNotSerpOnly("line") confirms this surface is
 *     NOT in SERP_ONLY_SURFACES, so RPA construction is permitted.
 *   - DISABLED BY DEFAULT: status='not_configured' until an RPA runner is armed
 *     (RPA_RUNNER_URL env var set). generate() returns NOT_CONFIGURED until then.
 *   - When armed, delegates to SurfaceAdapter (T07) which orchestrates
 *     run → parse (LineParser, T09) → return prose.
 *   - judge() always returns NOT_CONFIGURED (surface adapters are not judges).
 *   - nSamples is clamped to 1 upstream (T13); this adapter is single-call.
 *
 * NATIVE REVIEW FLAG:
 *   LineParser (T09) sets nativeReview=true on every SurfaceAnswer.
 *   SurfaceAdapter (T07) propagates this into meta.nativeReview for the
 *   pipeline to queue answers for native-speaker review in Japanese, Traditional
 *   Chinese, and Thai (T14). SMR measurement is IDENTICAL on/off (advisory only).
 *
 * PROSE/CITATION SEPARATION:
 *   LineParser (T09) puts ONLY prose in answerText; citations are packed
 *   separately in meta.citations by SurfaceAdapter (T07).
 *   The judge sees clean prose — no URL/title noise.
 *
 * TARGET URL:
 *   Line AI search/assistant is accessed at https://search.line.me (JP/TW/TH).
 *   The RPA runner navigates there, selects the appropriate language locale,
 *   submits the query, waits for the AI chat/search response, and returns a
 *   LineSnapshot or raw HTML.
 *
 * MARKETS: ja (Japan), zh-TW (Taiwan), th (Thailand).
 *
 * Pure module — no pg, no @google/genai.
 */

import { makeSurfaceAdapter } from "../../SurfaceAdapter.js";
import type { SurfaceAdapter } from "../../SurfaceAdapter.js";
import { lineParser } from "../parse/lineParser.js";
import type { RpaRunner, RpaRequest } from "../rpaRunner.js";
import { assertNotSerpOnly } from "../../compliance.js";
import type { SurfaceId } from "../../types.js";

// ---------------------------------------------------------------------------
// Compliance guard — enforced at module load time
// ---------------------------------------------------------------------------

// Confirm that "line" is NOT in SERP_ONLY_SURFACES.
// This allows RPA construction for Line AI (no official SERP API exists).
assertNotSerpOnly("line" satisfies SurfaceId);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target URL for Line AI search/assistant (JP/TW/TH web entry point). */
const LINE_AI_URL = "https://search.line.me";

/**
 * Default timeout (ms) to wait for Line AI's answer to render.
 * Line AI responses may involve streaming or pagination; 40 s is conservative.
 */
const LINE_AI_TIMEOUT_MS = 40_000;

// ---------------------------------------------------------------------------
// buildRpaRequest — translate a pipeline prompt into an RpaRequest
// ---------------------------------------------------------------------------

/**
 * Build an RpaRequest for a Line AI scrape.
 *
 * @param prompt   The pipeline's question text.
 * @param language ISO 639-1 / BCP 47 language code (e.g. "ja", "zh-TW", "th").
 * @returns        RpaRequest targeting search.line.me with market locale.
 */
function buildLineRpaRequest(
  prompt: string,
  language: string
): RpaRequest {
  // Map BCP 47 language to Line's internal locale identifiers.
  // Line's web interface uses country/language-specific entry points.
  const localeMap: Record<string, string> = {
    ja: "ja",
    "zh-TW": "zh_TW",
    th: "th",
  };

  const lineLocale = localeMap[language] ?? "ja"; // Default to Japanese market

  return {
    targetUrl: LINE_AI_URL,
    query: prompt,
    language,
    timeoutMs: LINE_AI_TIMEOUT_MS,
    params: {
      // Hint to the RPA runner: wait for the AI answer content selector.
      waitSelector: '[data-testid="ai-answer-content"]',
      // Surface identifier — allows a shared RPA runner to dispatch.
      surface: "line",
      // Line locale for the market-specific entry point.
      locale: lineLocale,
    },
  };
}

// ---------------------------------------------------------------------------
// makeLineAdapter — factory
// ---------------------------------------------------------------------------

/**
 * Create a Line AI scrape surface adapter.
 *
 * The adapter wraps `SurfaceAdapter` (T07) configured with:
 *   - kind: "scrape"         (RPA runner path)
 *   - surfaceId: "line"
 *   - runner: the provided RpaRunner (NotConfiguredRpaRunner or fixture)
 *   - parser: LineParser (T09) — prose-only, citations separate, nativeReview=true
 *   - buildRpaRequest: translates prompt → search.line.me RPA params
 *
 * The adapter's `status` reflects the runner's armed state:
 *   - 'not_configured' when runner.configured === false (stub/no runner)
 *   - 'ready'          when runner.configured === true  (runner available)
 *
 * §12 compliance: Line AI IS permitted via RPA (no official SERP API available).
 * assertNotSerpOnly guard above confirms this at module-load time.
 *
 * DISABLED BY DEFAULT: The surface registry (T11) wires a NotConfiguredRpaRunner
 * by default. The surface activates only when RPA_RUNNER_URL is set.
 *
 * MARKET NOTE: Line AI is a JP/TW/TH market surface. The nativeReview flag
 * is set to true by LineParser for all answers, and the native-review hook
 * (T14) will queue them for Japanese/Chinese/Thai native-speaker review.
 * SMR measurement is identical whether the flag is on or off.
 *
 * @param runner  RpaRunner to use. Typically `makeRpaRunner(env)` in production,
 *                or `new FixtureRpaRunner(raw)` in tests.
 * @returns       A SurfaceAdapter configured for Line AI.
 */
export function makeLineAdapter(runner: RpaRunner): SurfaceAdapter {
  return makeSurfaceAdapter({
    kind: "scrape",
    surfaceId: "line",
    runner,
    parser: lineParser,
    buildRpaRequest: buildLineRpaRequest,
  });
}
