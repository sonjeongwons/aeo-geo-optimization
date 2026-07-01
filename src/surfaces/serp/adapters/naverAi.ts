/**
 * Naver AI Answer — SERP surface adapter.
 *
 * DESIGN-phase4.md T10 / SPEC.md §4 (surfaces/tiers), §12 (compliance).
 *
 * KEY INVARIANTS (§12 / DESIGN-phase4.md):
 *   - THIS ADAPTER USES SERP CLIENT ONLY — no RPA/scrape runner permitted.
 *     Naver AI raw scraping is a ToS gray zone (SPEC §12).
 *     Enforced at construction time via `assertSerpOnly("naverAi")`.
 *   - NOT constructible via RpaRunner: the constructor accepts only a SerpClient.
 *     Any attempt to use the RPA runner path is a compile-time type error.
 *   - status='not_configured' when the SerpClient is not armed (no SERP_API_KEY).
 *     generate() returns NOT_CONFIGURED immediately — no network call.
 *   - When armed, delegates to SurfaceAdapter (T07) which orchestrates
 *     fetch → parse (NaverParser, T08) → return prose.
 *   - judge() always returns NOT_CONFIGURED (surface adapters are not judges).
 *   - nSamples is clamped to 1 upstream (T13); this adapter is single-call.
 *
 * NATIVE REVIEW FLAG:
 *   NaverParser (T08) sets nativeReview=true on every SurfaceAnswer.
 *   SurfaceAdapter (T07) propagates this into meta.nativeReview for the
 *   pipeline to pick up and queue for Korean native-speaker review (T14).
 *   SMR measurement is IDENTICAL whether the flag is on or off (advisory only).
 *
 * PROSE/CITATION SEPARATION:
 *   NaverParser (T08) puts ONLY prose in answerText; citations are packed
 *   separately in meta.citations by SurfaceAdapter (T07).
 *   The judge sees clean prose — no URL/title noise.
 *
 * Pure module — no pg, no @google/genai.
 */

import { makeSurfaceAdapter } from "../../SurfaceAdapter.js";
import type { SurfaceAdapter } from "../../SurfaceAdapter.js";
import { naverParser } from "../parse/naverParser.js";
import type { SerpClient, SerpRequest } from "../serpClient.js";
import { assertSerpOnly } from "../../compliance.js";
import type { SurfaceId } from "../../types.js";

// ---------------------------------------------------------------------------
// Compliance guard — enforced at module load time
// ---------------------------------------------------------------------------

// Validate that "naverAi" is in SERP_ONLY_SURFACES (SPEC §12).
// This runs when the module is first imported so any misconfiguration is
// caught immediately at startup/test time, not on the first request.
assertSerpOnly("naverAi" satisfies SurfaceId);

// ---------------------------------------------------------------------------
// buildSerpRequest — translate a pipeline prompt into a SerpRequest
// ---------------------------------------------------------------------------

/**
 * Build a SerpRequest for a Naver AI Answer query.
 *
 * Naver is a Korean-market search engine; the primary locale is always "ko" / "kr".
 * The SERP API param set maps to Naver's search API parameters.
 *
 * @param prompt   The pipeline's question text.
 * @param language ISO 639-1 language code. For Naver, this is typically "ko";
 *                 other language codes are passed through for multi-language
 *                 experiments but Naver primarily answers in Korean.
 * @returns        SerpRequest with query, language, and Naver-specific params.
 */
function buildNaverAiSerpRequest(
  prompt: string,
  language: string
): SerpRequest {
  return {
    query: prompt,
    // Naver's primary market is Korea; use language as-is but region is always kr.
    language,
    region: "kr",
    params: {
      // Instruct the SERP API to include the Naver AI answer block if present.
      // Vendor adapters map this to their own param name in the real implementation.
      include_naver_ai: "true",
      // Naver search engine identifier for SERP API providers that support it.
      engine: "naver",
    },
  };
}

// ---------------------------------------------------------------------------
// makeNaverAiAdapter — factory
// ---------------------------------------------------------------------------

/**
 * Create a Naver AI Answer surface adapter.
 *
 * The adapter wraps `SurfaceAdapter` (T07) configured with:
 *   - kind: "serp"           (SerpClient path, §12 enforced)
 *   - surfaceId: "naverAi"
 *   - client: the provided SerpClient (NotConfiguredSerpClient or fixture)
 *   - parser: NaverParser (T08) — prose-only, citations separate, nativeReview=true
 *   - buildSerpRequest: translates prompt → Naver SERP API params
 *
 * The adapter's `status` reflects the client's armed state:
 *   - 'not_configured' when client.configured === false (stub/no key)
 *   - 'ready'          when client.configured === true  (key present)
 *
 * §12 compliance: this factory only accepts a SerpClient (never an RpaRunner).
 * Attempting to pass an RpaRunner is a TypeScript compile-time error.
 *
 * MARKET NOTE: Naver AI is a Korean-market surface. The nativeReview flag
 * is set to true by NaverParser for all answers, and the native-review hook
 * (T14) will queue them for Korean native-speaker review. SMR measurement is
 * identical whether the flag is on or off.
 *
 * @param client  SerpClient to use. Typically `makeSerpClient(env)` in production,
 *                or `new FixtureSerpClient(raw)` in tests.
 * @returns       A SurfaceAdapter configured for Naver AI Answer.
 */
export function makeNaverAiAdapter(client: SerpClient): SurfaceAdapter {
  return makeSurfaceAdapter({
    kind: "serp",
    surfaceId: "naverAi",
    client,
    parser: naverParser,
    buildSerpRequest: buildNaverAiSerpRequest,
  });
}
