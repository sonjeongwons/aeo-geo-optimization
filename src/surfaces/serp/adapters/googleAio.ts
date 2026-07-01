/**
 * Google AI Overviews — SERP surface adapter.
 *
 * DESIGN-phase4.md T10 / SPEC.md §4 (surfaces/tiers), §12 (compliance).
 *
 * KEY INVARIANTS (§12 / DESIGN-phase4.md):
 *   - THIS ADAPTER USES SERP CLIENT ONLY — no RPA/scrape runner permitted.
 *     Google AI Overviews raw scraping is a ToS gray zone (SPEC §12).
 *     Enforced at construction time via `assertSerpOnly("googleAio")`.
 *   - NOT constructible via RpaRunner: the constructor accepts only a SerpClient.
 *     Any attempt to use the RPA runner path is a compile-time type error.
 *   - status='not_configured' when the SerpClient is not armed (no SERP_API_KEY).
 *     generate() returns NOT_CONFIGURED immediately — no network call.
 *   - When armed, delegates to SurfaceAdapter (T07) which orchestrates
 *     fetch → parse (AiOverviewParser, T08) → return prose.
 *   - judge() always returns NOT_CONFIGURED (surface adapters are not judges).
 *   - nSamples is clamped to 1 upstream (T13); this adapter is single-call.
 *
 * PROSE/CITATION SEPARATION:
 *   AiOverviewParser (T08) puts ONLY prose in answerText; citations are
 *   packed separately in meta.citations by SurfaceAdapter (T07).
 *   The judge sees clean prose — no URL/title noise.
 *
 * Pure module — no pg, no @google/genai.
 */

import { makeSurfaceAdapter } from "../../SurfaceAdapter.js";
import type { SurfaceAdapter } from "../../SurfaceAdapter.js";
import { aiOverviewParser } from "../parse/aiOverviewParser.js";
import type { SerpClient, SerpRequest } from "../serpClient.js";
import { assertSerpOnly } from "../../compliance.js";
import type { SurfaceId } from "../../types.js";

// ---------------------------------------------------------------------------
// Compliance guard — enforced at module load time
// ---------------------------------------------------------------------------

// Validate that "googleAio" is in SERP_ONLY_SURFACES (SPEC §12).
// This runs when the module is first imported so any misconfiguration is
// caught immediately at startup/test time, not on the first request.
assertSerpOnly("googleAio" satisfies SurfaceId);

// ---------------------------------------------------------------------------
// buildSerpRequest — translate a pipeline prompt into a SerpRequest
// ---------------------------------------------------------------------------

/**
 * Build a SerpRequest for a Google AI Overviews query.
 *
 * @param prompt   The pipeline's question text.
 * @param language ISO 639-1 language code (e.g. "en", "ko", "ja").
 * @returns        SerpRequest with query, language, and optional region set.
 */
function buildGoogleAioSerpRequest(
  prompt: string,
  language: string
): SerpRequest {
  // Map language code to a Google search region/country code.
  // For Google AIO the relevant SERP API params are:
  //   hl  = UI language (e.g. "en", "ko")
  //   gl  = country (e.g. "us", "kr")
  // We use a simple mapping for the most common language/region pairs.
  const regionMap: Record<string, string> = {
    en: "us",
    ko: "kr",
    ja: "jp",
    de: "de",
    fr: "fr",
    es: "es",
    pt: "br",
    it: "it",
    nl: "nl",
    pl: "pl",
    zh: "cn",
    "zh-TW": "tw",
    th: "th",
  };

  const region = regionMap[language] ?? "us";

  return {
    query: prompt,
    language,
    region,
    params: {
      // Instruct the SERP API to include the AI Overview block if present.
      // ValueSERP / DataForSEO specific param — vendor adapters map this
      // to their own param name in the real HTTP implementation.
      include_ai_overview: "true",
    },
  };
}

// ---------------------------------------------------------------------------
// makeGoogleAioAdapter — factory
// ---------------------------------------------------------------------------

/**
 * Create a Google AI Overviews surface adapter.
 *
 * The adapter wraps `SurfaceAdapter` (T07) configured with:
 *   - kind: "serp"            (SerpClient path, §12 enforced)
 *   - surfaceId: "googleAio"
 *   - client: the provided SerpClient (NotConfiguredSerpClient or fixture)
 *   - parser: AiOverviewParser (T08) — prose-only, citations separate
 *   - buildSerpRequest: translates prompt → Google SERP API params
 *
 * The adapter's `status` reflects the client's armed state:
 *   - 'not_configured' when client.configured === false (stub/no key)
 *   - 'ready'          when client.configured === true  (key present)
 *
 * §12 compliance: this factory only accepts a SerpClient (never an RpaRunner).
 * Attempting to pass an RpaRunner is a TypeScript compile-time error.
 *
 * @param client  SerpClient to use. Typically `makeSerpClient(env)` in production,
 *                or `new FixtureSerpClient(raw)` in tests.
 * @returns       A SurfaceAdapter configured for Google AI Overviews.
 */
export function makeGoogleAioAdapter(client: SerpClient): SurfaceAdapter {
  return makeSurfaceAdapter({
    kind: "serp",
    surfaceId: "googleAio",
    client,
    parser: aiOverviewParser,
    buildSerpRequest: buildGoogleAioSerpRequest,
  });
}
