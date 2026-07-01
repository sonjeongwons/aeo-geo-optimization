/**
 * Surface v1-b — compliance manifest.
 *
 * DESIGN-phase4.md T02 / SPEC.md §12 (compliance).
 *
 * INVARIANT (§12, hard rule):
 *   Google AI Overviews ("googleAio") and Naver AI ("naverAi") are
 *   OFFICIAL-SERP-API-ONLY surfaces. Raw scraping / RPA runner construction
 *   for these surfaces is DISABLED BY CONSTRUCTION in this codebase.
 *
 *   Rationale (§12):
 *     "AI Overviews·Naver 원시 스크래핑은 그레이존 → 정식 SERP API 우선."
 *     (AI Overviews / Naver raw scraping is a gray zone → official SERP API first.)
 *
 * This module is the SINGLE SOURCE OF TRUTH for surface-level compliance rules.
 * Adapter constructors (T10) and the surface registry (T11) import and enforce
 * these rules at build time so they cannot be bypassed.
 *
 * Pure values — no IO, no pg, no @google/genai.
 */

import type { SurfaceId } from "./types.js";

// ---------------------------------------------------------------------------
// Compliance categories
// ---------------------------------------------------------------------------

/**
 * Surfaces that MUST be resolved via an official SERP API.
 *
 * These surfaces are NOT constructible via the RPA/scrape runner.
 * Any attempt to create a scrape adapter for these surfaces is a
 * compile-time + runtime error (see `assertNotScrapeOnly`).
 *
 * Current members:
 *   - "googleAio"  Google AI Overviews — official SERP API only (ToS, §12)
 *   - "naverAi"    Naver AI answer    — official SERP API only (ToS, §12)
 */
export const SERP_ONLY_SURFACES: ReadonlySet<SurfaceId> = new Set<SurfaceId>([
  "googleAio",
  "googleAiMode",
  "naverAi",
]);

/**
 * Surfaces that use the RPA/scrape runner.
 *
 * These surfaces are disabled by default (must be explicitly enabled via
 * environment configuration when an RPA runner is available).
 *
 * None of these surfaces overlap with SERP_ONLY_SURFACES — that invariant
 * is enforced by `assertNotRpaEligible`.
 */
export const SCRAPE_SURFACES: ReadonlySet<SurfaceId> = new Set<SurfaceId>([
  "copilot",
  "metaAi",
  "line",
  "kakao",
]);

// ---------------------------------------------------------------------------
// Compliance record — static manifest for each v1-b surface
// ---------------------------------------------------------------------------

/**
 * How a surface may be accessed.
 *   "official_serp" — only via a licensed/official SERP API (§12 compliant)
 *   "scrape"        — via RPA/headless browser (ToS gray zone; disabled by default)
 */
export type AccessMethod = "official_serp" | "scrape";

/** Market-language codes relevant to a surface (ISO 639-1 or BCP 47). */
export type MarketLanguage = string;

/**
 * Compliance manifest entry for a single v1-b surface.
 *
 * Fields:
 *   surfaceId         — canonical SurfaceId
 *   accessMethod      — how the surface must be accessed (§12)
 *   scrapePermitted   — false for SERP_ONLY_SURFACES; true for scrape surfaces
 *                       (with the understanding that they are disabled by default)
 *   markets           — primary market languages (ISO 639-1 / BCP 47)
 *   nativeReview      — true when market-language answers need native-speaker QA
 *   complianceNotes   — human-readable rationale for the access constraint
 */
export interface SurfaceComplianceEntry {
  readonly surfaceId: SurfaceId;
  readonly accessMethod: AccessMethod;
  /** Whether RPA/scrape construction is permitted for this surface. */
  readonly scrapePermitted: boolean;
  readonly markets: readonly MarketLanguage[];
  /** True when answers in the surface's market language need native-reviewer sign-off. */
  readonly nativeReview: boolean;
  readonly complianceNotes: string;
}

/**
 * COMPLIANCE_MANIFEST — static compliance rules for all v1-b surfaces.
 *
 * This is the authoritative, machine-readable policy table that adapter
 * constructors and the registry check at startup.
 */
export const COMPLIANCE_MANIFEST: ReadonlyMap<SurfaceId, SurfaceComplianceEntry> =
  new Map<SurfaceId, SurfaceComplianceEntry>([
    [
      "googleAio",
      {
        surfaceId: "googleAio",
        accessMethod: "official_serp",
        scrapePermitted: false,
        markets: ["en", "ko", "ja", "de", "fr", "es", "pt", "it", "nl", "pl"],
        nativeReview: false,
        complianceNotes:
          "Google AI Overviews: raw scraping is a ToS gray zone (SPEC §12). " +
          "Must be accessed via an official Google SERP API only. " +
          "RPA/scrape runner construction is DISABLED BY CONSTRUCTION.",
      },
    ],
    [
      "googleAiMode",
      {
        surfaceId: "googleAiMode",
        accessMethod: "official_serp",
        scrapePermitted: false,
        markets: ["en", "ko", "ja", "de", "fr", "es", "pt", "it", "nl", "pl"],
        nativeReview: false,
        complianceNotes:
          "Google AI Mode: a DISTINCT surface from AI Overviews (low cited-URL overlap, ~<14%) " +
          "that must NEVER be re-pooled with googleAio in per-engine metrics (W2). " +
          "Raw scraping is a ToS gray zone (SPEC §12) — official Google SERP API only; " +
          "RPA/scrape runner construction is DISABLED BY CONSTRUCTION. " +
          "NOT_CONFIGURED until an official AI Mode SERP API surfaces the AI Mode block.",
      },
    ],
    [
      "naverAi",
      {
        surfaceId: "naverAi",
        accessMethod: "official_serp",
        scrapePermitted: false,
        markets: ["ko"],
        nativeReview: true,
        complianceNotes:
          "Naver AI: raw scraping is a ToS gray zone (SPEC §12). " +
          "Must be accessed via an official Naver SERP API only. " +
          "RPA/scrape runner construction is DISABLED BY CONSTRUCTION. " +
          "Market language is Korean — native-review flag is set.",
      },
    ],
    [
      "copilot",
      {
        surfaceId: "copilot",
        accessMethod: "scrape",
        scrapePermitted: true,
        markets: ["en", "de", "fr", "es", "ja", "ko", "zh-TW"],
        nativeReview: false,
        complianceNotes:
          "Microsoft Copilot: no public API — accessed via RPA/headless browser. " +
          "Disabled by default; enabled when an RPA runner is configured.",
      },
    ],
    [
      "metaAi",
      {
        surfaceId: "metaAi",
        accessMethod: "scrape",
        scrapePermitted: true,
        markets: ["en", "es", "pt", "fr", "de", "it", "ar"],
        nativeReview: false,
        complianceNotes:
          "Meta AI (Llama): no public monitoring API — accessed via RPA/headless browser. " +
          "Disabled by default; enabled when an RPA runner is configured.",
      },
    ],
    [
      "line",
      {
        surfaceId: "line",
        accessMethod: "scrape",
        scrapePermitted: true,
        markets: ["ja", "zh-TW", "th"],
        nativeReview: true,
        complianceNotes:
          "Line AI: JP/TW/TH market surface — accessed via RPA/headless browser. " +
          "Disabled by default; enabled when an RPA runner is configured. " +
          "All market languages (ja, zh-TW, th) require native-reviewer sign-off.",
      },
    ],
    [
      "kakao",
      {
        surfaceId: "kakao",
        accessMethod: "scrape",
        scrapePermitted: true,
        markets: ["ko"],
        nativeReview: true,
        complianceNotes:
          "Kakao AI: KR market surface — accessed via RPA/headless browser. " +
          "Disabled by default; enabled when an RPA runner is configured. " +
          "Market language Korean requires native-reviewer sign-off.",
      },
    ],
  ]);

// ---------------------------------------------------------------------------
// Compliance guards — enforced at construction time by adapters and registry
// ---------------------------------------------------------------------------

/**
 * Assert that a surface is NOT in SERP_ONLY_SURFACES before allowing RPA
 * construction. Throws a descriptive TypeError when called for a SERP-only
 * surface so the violation is caught at startup (not at runtime per-request).
 *
 * Adapter constructors (T10) call this in their constructor body:
 *
 *   class CopilotScrapeAdapter {
 *     constructor() {
 *       assertNotSerpOnly("copilot");   // OK — not in SERP_ONLY_SURFACES
 *       ...
 *     }
 *   }
 *
 * Trying to construct a scrape adapter for "googleAio" or "naverAi" will
 * throw immediately at test/startup time.
 *
 * @throws TypeError if surfaceId is in SERP_ONLY_SURFACES
 */
export function assertNotSerpOnly(surfaceId: SurfaceId): void {
  if (SERP_ONLY_SURFACES.has(surfaceId)) {
    const entry = COMPLIANCE_MANIFEST.get(surfaceId);
    throw new TypeError(
      `[compliance] Surface "${surfaceId}" is OFFICIAL-SERP-API-ONLY and cannot be ` +
        `constructed via the RPA/scrape runner. ` +
        `Reason: ${entry?.complianceNotes ?? "see SPEC §12"}. ` +
        `Use a SerpClient-based adapter instead.`
    );
  }
}

/**
 * Assert that a surface IS in SERP_ONLY_SURFACES before allowing SERP-client
 * construction. This is the mirror guard: SERP adapters call this to document
 * that they are intentionally using the official SERP API path.
 *
 * @throws TypeError if surfaceId is NOT in SERP_ONLY_SURFACES
 */
export function assertSerpOnly(surfaceId: SurfaceId): void {
  if (!SERP_ONLY_SURFACES.has(surfaceId)) {
    throw new TypeError(
      `[compliance] Surface "${surfaceId}" is not a SERP-only surface. ` +
        `SerpClient adapters may only be constructed for SERP_ONLY_SURFACES ` +
        `(${[...SERP_ONLY_SURFACES].join(", ")}). ` +
        `Use the RPA/scrape runner instead.`
    );
  }
}

/**
 * Return the compliance manifest entry for a surface, or throw if the surface
 * is not registered in the manifest.
 *
 * @throws RangeError if surfaceId is not in COMPLIANCE_MANIFEST
 */
export function getComplianceEntry(surfaceId: SurfaceId): SurfaceComplianceEntry {
  const entry = COMPLIANCE_MANIFEST.get(surfaceId);
  if (!entry) {
    throw new RangeError(
      `[compliance] Surface "${surfaceId}" has no compliance manifest entry. ` +
        `All v1-b surfaces must be registered in COMPLIANCE_MANIFEST.`
    );
  }
  return entry;
}

/**
 * Return true when a surface requires native-speaker review of its answers.
 *
 * This is a convenience wrapper over the manifest for use in the native-review
 * hook (T14) without importing the full manifest.
 */
export function requiresNativeReview(surfaceId: SurfaceId): boolean {
  return COMPLIANCE_MANIFEST.get(surfaceId)?.nativeReview ?? false;
}

/**
 * Return true when a surface is permitted to be accessed via the RPA/scrape runner.
 *
 * Note: "permitted" does NOT mean "currently enabled". Scrape surfaces are
 * permitted by construction but disabled by default until an RPA runner is
 * configured. Check the surface registry's `enabled` flag for runtime eligibility.
 */
export function isScrapePermitted(surfaceId: SurfaceId): boolean {
  return COMPLIANCE_MANIFEST.get(surfaceId)?.scrapePermitted ?? false;
}
