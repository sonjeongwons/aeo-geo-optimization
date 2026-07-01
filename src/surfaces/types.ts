/**
 * Surface v1-b — core types for SERP/scrape surface adapters.
 *
 * DESIGN-phase4.md T01 / SPEC.md §4 (surfaces/tiers), §5.1 (Response atom),
 * §12 (compliance).
 *
 * KEY INVARIANTS:
 *   - PROSE/CITATION SEPARATION: parsers put ONLY the answer prose into
 *     `answerText`. Citations are a SEPARATE structured list (never
 *     concatenated into `answerText`), so the judge sees clean prose and
 *     brand attribution stays faithful.
 *   - NO_ANSWER is a typed value (not an exception) — mirrors NOT_CONFIGURED
 *     from providers/types.ts. Parsers return it when there is no AI answer
 *     (e.g. AIO absent, scrape drifted, page layout changed).
 *   - SurfaceParser is the seam: each surface parser takes a raw blob and
 *     returns ParseResult (ok SurfaceAnswer or NO_ANSWER).
 *   - SurfaceId enumerates all v1-b surface identifiers (used in registry,
 *     selection, migration seed, compliance manifest).
 *
 * Pure types — no IO, no pg, no @google/genai.
 */

// ---------------------------------------------------------------------------
// NO_ANSWER — typed value, not an exception
// ---------------------------------------------------------------------------

export const NO_ANSWER = "NO_ANSWER" as const;
export type NoAnswer = typeof NO_ANSWER;

// ---------------------------------------------------------------------------
// Surface identifiers (v1-b)
// ---------------------------------------------------------------------------

/**
 * Stable string IDs for all v1-b monitoring surfaces.
 * These are the canonical identifiers used across registry, DB seed, compliance
 * manifest, cost ledger, and surface selection.
 *
 * SPEC §4 surface set:
 *   SERP-only (official SERP API, no RPA):  googleAio, naverAi
 *   Scrape (RPA runner, disabled by default): copilot, metaAi, line, kakao
 *   API (chat modality, separate from surfaces): mistral, deepseek, copilotApi
 *
 * Note: mistral and deepseek are v1-b "Extension 1" surfaces that use the
 * chat/api modality and are registered in the provider registry, not here.
 * The SurfaceId type covers the serp/scrape surfaces only.
 */
export type SurfaceId =
  | "googleAio"     // Google AI Overviews (SERP-API only, §12)
  | "googleAiMode"  // Google AI Mode — DISTINCT from AI Overviews (<14% URL overlap); SERP-API only, NOT_CONFIGURED until an official AI Mode SERP API exists (W2)
  | "naverAi"     // Naver AI answer (SERP-API only, §12)
  | "copilot"     // Microsoft Copilot (scrape)
  | "metaAi"      // Meta AI / Llama (scrape)
  | "line"        // Line AI (scrape, JP/TW/TH markets)
  | "kakao"       // Kakao AI (scrape, KR market);

// ---------------------------------------------------------------------------
// Citation — structured reference, NEVER concatenated into answerText
// ---------------------------------------------------------------------------

/**
 * A single citation returned by a SERP/scrape surface.
 *
 * PROSE/CITATION SEPARATION invariant: citations MUST NOT appear in
 * `answerText`. Parsers extract them into this structured list so:
 *   1. The judge receives clean prose (no URL/title noise).
 *   2. Brand attribution (which source mentions the brand) stays faithful.
 *   3. Front-end can render citations separately.
 *
 * All fields are optional because:
 *   - SERP API responses may omit snippet.
 *   - Scrape parsers may extract only partial data before drift.
 */
export interface Citation {
  /** Canonical URL of the cited source. */
  url: string;
  /** Page/article title of the cited source. May be absent if not extractable. */
  title?: string;
  /** Short excerpt from the source supporting the answer. May be absent. */
  snippet?: string;
  /** 1-based ordinal of this citation in the original surface answer (if known). */
  rank?: number;
}

// ---------------------------------------------------------------------------
// SurfaceAnswer — the parsed output of a surface call
// ---------------------------------------------------------------------------

/**
 * Parsed, normalized output from a SERP or scrape surface.
 *
 * DESIGN-phase4.md §5.1: a surface answer is just `answer_text` (+ citations)
 * that the judge pipeline consumes — the same way it consumes a chat adapter's
 * `GenerateOk.answerText`.
 *
 * Fields:
 *   answerText   — the AI/SERP answer prose. ONLY prose; no citation text here.
 *   citations    — structured citations list (may be empty if none found).
 *   surfaceId    — which v1-b surface produced this answer.
 *   rawInput     — the raw SERP API response or scrape DOM blob used to parse;
 *                  stored as `provider_meta` JSONB (§5.1 ResponseRaw.providerMeta).
 *   nativeReview — advisory flag: true when the answer is in a market language
 *                  (JP/TW/TH for Line, KR for Kakao/Naver) and should be
 *                  queued for native-speaker review before publishing.
 *                  SMR measurement is IDENTICAL whether the flag is on or off.
 */
export interface SurfaceAnswer {
  /** AI/SERP answer prose — ONLY prose, no citation URLs or titles. */
  answerText: string;
  /** Structured citations — separate from prose; may be empty. */
  citations: Citation[];
  /** The surface that produced this answer. */
  surfaceId: SurfaceId;
  /**
   * The raw input that was parsed (SERP API JSON blob or scraped DOM string).
   * Stored verbatim as `provider_meta` JSONB in `response_raw`.
   */
  rawInput: unknown;
  /**
   * Advisory native-review flag.
   * True for market-language surfaces (Line JP/TW/TH, Kakao KR, Naver KR).
   * Does NOT affect SMR calculation — measurement is identical on/off.
   */
  nativeReview?: boolean;
}

// ---------------------------------------------------------------------------
// ParseResult — discriminated union returned by every SurfaceParser
// ---------------------------------------------------------------------------

/** Parser found a valid AI answer — returns the structured SurfaceAnswer. */
export interface ParseOk {
  ok: true;
  answer: SurfaceAnswer;
}

/**
 * Parser found no AI answer (e.g. AIO absent on this query, page layout
 * drifted, element no longer present).
 *
 * NO_ANSWER is a TYPED VALUE (not an exception). The pipeline treats it as a
 * valid measurement outcome: `response_raw.status = 'not_configured'` (surface
 * temporarily absent) rather than an error.
 *
 * Callers MUST NOT throw; they return this variant.
 */
export interface ParseNoAnswer {
  ok: false;
  code: NoAnswer;
  /** Human-readable reason for debugging (not stored in DB). */
  reason?: string;
}

/**
 * Parser encountered an unrecoverable structural error (e.g. unexpected API
 * schema change, required field missing). Distinct from NO_ANSWER because this
 * indicates the parser itself needs updating (drift alert), not just absence.
 */
export interface ParseError {
  ok: false;
  /** DRIFT | SCHEMA_ERROR | UNEXPECTED */
  code: "DRIFT" | "SCHEMA_ERROR" | "UNEXPECTED";
  message: string;
  /** Raw input fragment that triggered the error (for diagnostics). */
  rawFragment?: unknown;
}

/** Discriminated union of all parse outcomes. */
export type ParseResult = ParseOk | ParseNoAnswer | ParseError;

// ---------------------------------------------------------------------------
// SurfaceParser — the parser seam contract
// ---------------------------------------------------------------------------

/**
 * A SurfaceParser takes a raw surface response (SERP API JSON or scraped DOM)
 * and returns a ParseResult.
 *
 * DESIGN invariants:
 *   - NEVER throw — all outcomes are typed return values.
 *   - answerText in ParseOk MUST be prose only — no citation URLs/titles.
 *   - Citations MUST be in the `answer.citations` list (not answerText).
 *   - Return ParseNoAnswer (NO_ANSWER) when the AI answer block is absent.
 *   - Return ParseError (DRIFT) when the expected DOM/JSON structure is gone.
 *
 * The raw type parameter `TRaw` is the input type that this parser accepts:
 *   - SERP parsers: T = the SERP API response JSON shape (unknown at this layer)
 *   - Scrape parsers: T = string (raw HTML/DOM) or unknown (browser snapshot)
 *
 * Using `unknown` as the default allows callers to pass any raw input; each
 * concrete parser validates and narrows internally.
 */
export interface SurfaceParser<TRaw = unknown> {
  /** The surface this parser handles. */
  readonly surfaceId: SurfaceId;

  /**
   * Parse a raw surface response.
   *
   * @param raw — the raw SERP API JSON blob or scraped DOM string.
   * @returns ParseResult — ok, no-answer, or error; NEVER throws.
   */
  parse(raw: TRaw): ParseResult;
}

// ---------------------------------------------------------------------------
// SurfaceModality helper (mirrors providers/types.ts Modality)
// ---------------------------------------------------------------------------

/**
 * The modality of a v1-b surface.
 * Mirrors `Modality` from providers/types.ts; declared here for surfaces layer
 * isolation (surfaces do not import from providers at this type level).
 *
 *   serp   — fetched via official SERP API (e.g. Google AI Overviews, Naver)
 *   scrape — fetched via RPA/headless browser runner (e.g. Copilot, Meta AI)
 */
export type SurfaceModality = "serp" | "scrape";

// ---------------------------------------------------------------------------
// SurfaceMeta — static configuration for a registered surface
// ---------------------------------------------------------------------------

/**
 * Static metadata for a registered v1-b surface.
 * Used by the surface registry, selection logic, and compliance manifest.
 *
 * Fields:
 *   id          — canonical SurfaceId
 *   modality    — serp | scrape
 *   markets     — ISO 639-1 language codes where this surface is relevant
 *   nativeReviewLanguages — languages that require native speaker review
 *   nSamples    — ALWAYS 1 for serp/scrape (deterministic, not probabilistic)
 *   enabled     — false = disabled by default (scrape surfaces start disabled)
 */
export interface SurfaceMeta {
  readonly id: SurfaceId;
  readonly modality: SurfaceModality;
  /** ISO 639-1 language codes where this surface applies. */
  readonly markets: readonly string[];
  /** Languages within `markets` that require native-reviewer sign-off. */
  readonly nativeReviewLanguages: readonly string[];
  /**
   * Sample count per work-unit.
   * ALWAYS 1 for serp/scrape surfaces (non-chat, deterministic).
   * The plan builder enforces this clamp (T13).
   */
  readonly nSamples: 1;
  /**
   * Whether this surface is enabled for scheduling.
   * Scrape surfaces default to false (disabled) until an RPA runner is
   * configured. SERP surfaces default to false until a SERP API key is set.
   */
  readonly enabled: boolean;
}
