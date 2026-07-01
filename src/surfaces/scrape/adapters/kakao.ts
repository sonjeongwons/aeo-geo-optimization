/**
 * Kakao AI — scrape surface adapter.
 *
 * DESIGN-phase4.md T10 / SPEC.md §4 (surfaces/tiers, scrape), §12 (compliance).
 *
 * KEY INVARIANTS:
 *   - THIS ADAPTER USES RPA RUNNER (scrape) — Kakao AI has no public monitoring API.
 *   - §12 compliance guard: assertNotSerpOnly("kakao") confirms this surface is
 *     NOT in SERP_ONLY_SURFACES, so RPA construction is permitted.
 *   - DISABLED BY DEFAULT: status='not_configured' until an RPA runner is armed
 *     (RPA_RUNNER_URL env var set). generate() returns NOT_CONFIGURED until then.
 *   - When armed, delegates to SurfaceAdapter (T07) which orchestrates
 *     run → parse (KakaoParser, T09) → return prose.
 *   - judge() always returns NOT_CONFIGURED (surface adapters are not judges).
 *   - nSamples is clamped to 1 upstream (T13); this adapter is single-call.
 *
 * NATIVE REVIEW FLAG:
 *   KakaoParser (T09) sets nativeReview=true on every SurfaceAnswer.
 *   SurfaceAdapter (T07) propagates this into meta.nativeReview for the
 *   pipeline to queue answers for Korean native-speaker review (T14).
 *   SMR measurement is IDENTICAL on/off (advisory metadata only).
 *
 * PROSE/CITATION SEPARATION:
 *   KakaoParser (T09) puts ONLY prose in answerText; citations are packed
 *   separately in meta.citations by SurfaceAdapter (T07).
 *   The judge sees clean prose — no URL/title noise.
 *
 * TARGET URL:
 *   Kakao AI is accessed via Daum search (https://search.daum.net) or Kakao Talk.
 *   The RPA runner navigates to the Daum search AI summary page, submits the
 *   query, waits for the AI answer block, and returns a KakaoSnapshot or raw HTML.
 *   Kakao Talk's AI assistant is an alternative entry point but requires auth;
 *   Daum search is preferred as a publicly accessible surface.
 *
 * MARKET: ko (South Korea).
 *
 * Pure module — no pg, no @google/genai.
 */

import { makeSurfaceAdapter } from "../../SurfaceAdapter.js";
import type { SurfaceAdapter } from "../../SurfaceAdapter.js";
import { kakaoParser } from "../parse/kakaoParser.js";
import type { RpaRunner, RpaRequest } from "../rpaRunner.js";
import { assertNotSerpOnly } from "../../compliance.js";
import type { SurfaceId } from "../../types.js";

// ---------------------------------------------------------------------------
// Compliance guard — enforced at module load time
// ---------------------------------------------------------------------------

// Confirm that "kakao" is NOT in SERP_ONLY_SURFACES.
// This allows RPA construction for Kakao AI (no official SERP API exists).
assertNotSerpOnly("kakao" satisfies SurfaceId);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target URL for Kakao AI via Daum search (publicly accessible, KR market). */
const KAKAO_AI_URL = "https://search.daum.net";

/**
 * Default timeout (ms) to wait for Kakao AI's answer to render.
 * Kakao AI (Daum) answers are typically fast; 30 s is generous.
 */
const KAKAO_AI_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// buildRpaRequest — translate a pipeline prompt into an RpaRequest
// ---------------------------------------------------------------------------

/**
 * Build an RpaRequest for a Kakao AI (Daum search) scrape.
 *
 * @param prompt   The pipeline's question text.
 * @param language ISO 639-1 language code. For Kakao, this is typically "ko";
 *                 other language codes are passed through but the surface
 *                 primarily operates in Korean.
 * @returns        RpaRequest targeting search.daum.net.
 */
function buildKakaoRpaRequest(
  prompt: string,
  language: string
): RpaRequest {
  return {
    targetUrl: KAKAO_AI_URL,
    query: prompt,
    language,
    timeoutMs: KAKAO_AI_TIMEOUT_MS,
    params: {
      // Hint to the RPA runner: wait for the Kakao AI answer container selector.
      // Daum search uses the ccs_ai_summary class for AI summary blocks.
      waitSelector: '[data-testid="ai-answer"], .ccs_ai_summary, .ai_answer_wrap',
      // Surface identifier — allows a shared RPA runner to dispatch.
      surface: "kakao",
      // Kakao/Daum search locale is always Korean.
      locale: "ko",
    },
  };
}

// ---------------------------------------------------------------------------
// makeKakaoAdapter — factory
// ---------------------------------------------------------------------------

/**
 * Create a Kakao AI scrape surface adapter.
 *
 * The adapter wraps `SurfaceAdapter` (T07) configured with:
 *   - kind: "scrape"         (RPA runner path)
 *   - surfaceId: "kakao"
 *   - runner: the provided RpaRunner (NotConfiguredRpaRunner or fixture)
 *   - parser: KakaoParser (T09) — prose-only, citations separate, nativeReview=true
 *   - buildRpaRequest: translates prompt → search.daum.net RPA params
 *
 * The adapter's `status` reflects the runner's armed state:
 *   - 'not_configured' when runner.configured === false (stub/no runner)
 *   - 'ready'          when runner.configured === true  (runner available)
 *
 * §12 compliance: Kakao AI IS permitted via RPA (no official SERP API available).
 * assertNotSerpOnly guard above confirms this at module-load time.
 *
 * DISABLED BY DEFAULT: The surface registry (T11) wires a NotConfiguredRpaRunner
 * by default. The surface activates only when RPA_RUNNER_URL is set.
 *
 * MARKET NOTE: Kakao AI is a KR (Korean) market surface. The nativeReview flag
 * is set to true by KakaoParser for all answers, and the native-review hook
 * (T14) will queue them for Korean native-speaker review. SMR measurement is
 * identical whether the flag is on or off.
 *
 * @param runner  RpaRunner to use. Typically `makeRpaRunner(env)` in production,
 *                or `new FixtureRpaRunner(raw)` in tests.
 * @returns       A SurfaceAdapter configured for Kakao AI.
 */
export function makeKakaoAdapter(runner: RpaRunner): SurfaceAdapter {
  return makeSurfaceAdapter({
    kind: "scrape",
    surfaceId: "kakao",
    runner,
    parser: kakaoParser,
    buildRpaRequest: buildKakaoRpaRequest,
  });
}
