/**
 * Google AI Mode — SERP surface adapter (W2).
 *
 * Mirrors googleAio.ts but for Google's AI Mode surface, which is DISTINCT from
 * AI Overviews (low cited-URL overlap) and must never be re-pooled with it.
 *
 * KEY INVARIANTS (§12, identical discipline to googleAio):
 *   - SERP CLIENT ONLY — no RPA/scrape runner (enforced via assertSerpOnly).
 *   - status='not_configured' until the SerpClient is armed AND an official AI
 *     Mode SERP API exists; generate() returns NOT_CONFIGURED with no network call.
 *   - When armed, delegates to SurfaceAdapter → aiModeParser (prose-only,
 *     citations separate), tagged surfaceId 'googleAiMode'.
 *
 * Pure module — no pg, no @google/genai.
 */

import { makeSurfaceAdapter } from "../../SurfaceAdapter.js";
import type { SurfaceAdapter } from "../../SurfaceAdapter.js";
import { aiModeParser } from "../parse/aiModeParser.js";
import type { SerpClient, SerpRequest } from "../serpClient.js";
import { assertSerpOnly } from "../../compliance.js";
import type { SurfaceId } from "../../types.js";

// Compliance guard at module-load time (SPEC §12).
assertSerpOnly("googleAiMode" satisfies SurfaceId);

function buildGoogleAiModeSerpRequest(prompt: string, language: string): SerpRequest {
  const regionMap: Record<string, string> = {
    en: "us", ko: "kr", ja: "jp", de: "de", fr: "fr", es: "es",
    pt: "br", it: "it", nl: "nl", pl: "pl", zh: "cn", "zh-TW": "tw", th: "th",
  };
  const region = regionMap[language] ?? "us";
  return {
    query: prompt,
    language,
    region,
    params: {
      // Vendor param requesting the AI Mode block; the real HTTP adapter maps
      // this to its vendor-specific name once the AI Mode SERP API exists.
      include_ai_mode: "true",
    },
  };
}

/**
 * Create a Google AI Mode surface adapter. Accepts ONLY a SerpClient (§12).
 * NOT_CONFIGURED until the SerpClient is armed and the AI Mode SERP API exists.
 */
export function makeGoogleAiModeAdapter(client: SerpClient): SurfaceAdapter {
  return makeSurfaceAdapter({
    kind: "serp",
    surfaceId: "googleAiMode",
    client,
    parser: aiModeParser,
    buildSerpRequest: buildGoogleAiModeSerpRequest,
  });
}
