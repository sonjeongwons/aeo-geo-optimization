/**
 * SERP API client seam — T06 (Phase 4, surface v1-b).
 *
 * DESIGN-phase4.md §T06 / SPEC.md §4 (surfaces/tiers), §12 (compliance).
 *
 * KEY INVARIANTS:
 *   - NOT_CONFIGURED stub today: no SERP API key is present yet.
 *     Flips to real when a key arrives (SERP_API_KEY env var).
 *   - Google AI Overviews + Naver MUST be resolved via this SERP-API client ONLY.
 *     They are NOT constructible via RpaRunner (§12 compliance, gray-zone raw
 *     scraping disabled by construction). See surfaces/compliance.ts.
 *   - SerpClient.configured returns false until a real key is injected.
 *   - Unit-testable with fixtures — no live network calls.
 *   - All outcomes are typed return values; NEVER throw for missing keys.
 *
 * The `SerpClient` interface is the seam that surface adapters (T10) depend on.
 * The `NotConfiguredSerpClient` stub is what gets wired in today (T11/T16).
 * When SERP_API_KEY is set, `makeSerpClient()` returns the real implementation.
 *
 * Pure module — no pg, no @google/genai.
 */

import { NOT_CONFIGURED } from "../../providers/types.js";
import type { NotConfigured } from "../../providers/types.js";

// ---------------------------------------------------------------------------
// SERP request / response shapes
// ---------------------------------------------------------------------------

/**
 * A SERP API request — what surfaces pass to the client to fetch an answer.
 */
export interface SerpRequest {
  /** The search query / question text. */
  query: string;
  /**
   * ISO 639-1 language code for the query (e.g. "en", "ko", "ja").
   * Used to set SERP API locale/hl parameters.
   */
  language: string;
  /**
   * Country/region code for the search (e.g. "us", "kr", "jp").
   * Used to set SERP API gl/cr parameters.
   */
  region?: string;
  /**
   * Opaque extra params forwarded to the SERP API (e.g. surface-specific flags).
   * Each surface adapter may pass surface-specific options here.
   */
  params?: Record<string, string>;
}

/**
 * A successful SERP API response — the raw JSON blob returned by the API.
 * The surface-specific parsers (T08) consume this.
 */
export interface SerpResponseOk {
  ok: true;
  /** The raw SERP API JSON response. Parsers narrow to their expected shape. */
  raw: unknown;
  /** USD cost metered via the llm_call ledger (§11 surfacePricing). */
  usdCost: number;
}

/**
 * NOT_CONFIGURED — no SERP API key present.
 * Surface adapters surface this as a NOT_CONFIGURED generate() result.
 */
export interface SerpResponseNotConfigured {
  ok: false;
  code: NotConfigured;
}

/**
 * SERP API call failed (network, quota, auth error).
 * Retryable surfaces may retry; others surface as error.
 */
export interface SerpResponseError {
  ok: false;
  /** RATE_LIMITED | TIMEOUT | AUTH_ERROR | PROVIDER_ERROR */
  code: string;
  message: string;
  retryable: boolean;
}

/** Discriminated union of all SERP client call outcomes. */
export type SerpResponse =
  | SerpResponseOk
  | SerpResponseNotConfigured
  | SerpResponseError;

// ---------------------------------------------------------------------------
// SerpClient interface — the seam
// ---------------------------------------------------------------------------

/**
 * The SERP API client seam.
 *
 * Surface adapters (T10) depend only on this interface. The stub and real
 * implementations are swapped via `makeSerpClient()`.
 *
 * §12 compliance: Google AI Overviews + Naver AI MUST NOT be constructed
 * via RpaRunner — they are SERP-API-only surfaces. This is enforced by
 * construction: their adapters (T10) accept only a SerpClient, never an RpaRunner.
 */
export interface SerpClient {
  /**
   * Whether this client is configured with a valid API key.
   * Surface adapters check this before calling `fetch()` and return
   * NOT_CONFIGURED immediately if false (no network call made).
   */
  readonly configured: boolean;

  /**
   * Execute a SERP API query and return the raw JSON response.
   *
   * When `configured` is false, returns `{ ok: false, code: NOT_CONFIGURED }`.
   * NEVER throws — all outcomes are typed return values.
   */
  fetch(req: SerpRequest): Promise<SerpResponse>;
}

// ---------------------------------------------------------------------------
// NotConfiguredSerpClient — stub for today (no SERP_API_KEY)
// ---------------------------------------------------------------------------

/**
 * Stub SERP client — returned when no SERP API key is present.
 *
 * Mirrors the NOT_CONFIGURED pattern from providers/stub.ts:
 *   - configured: false
 *   - fetch(): always returns { ok: false, code: NOT_CONFIGURED }
 *
 * The stub is unit-testable with fixtures: callers can inject a
 * FixtureSerpClient (returning fixture raw JSON) in tests.
 */
export class NotConfiguredSerpClient implements SerpClient {
  readonly configured = false as const;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetch(_req: SerpRequest): Promise<SerpResponse> {
    return { ok: false, code: NOT_CONFIGURED };
  }
}

// ---------------------------------------------------------------------------
// FixtureSerpClient — test helper (injects fixture raw JSON)
// ---------------------------------------------------------------------------

/**
 * Test fixture SERP client — returns a pre-set raw JSON blob as if it came
 * from the SERP API. Used in unit tests (T17) for parsers and adapters
 * WITHOUT any live network calls.
 *
 * Usage:
 *   const client = new FixtureSerpClient({ aiOverview: { ... } });
 *   const result = await client.fetch({ query: "...", language: "en" });
 *   // result.ok === true, result.raw === the fixture blob
 */
export class FixtureSerpClient implements SerpClient {
  readonly configured = true as const;

  constructor(
    private readonly fixtureRaw: unknown,
    private readonly usdCost: number = 0
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetch(_req: SerpRequest): Promise<SerpResponse> {
    return { ok: true, raw: this.fixtureRaw, usdCost: this.usdCost };
  }
}

// ---------------------------------------------------------------------------
// makeSerpClient — factory (flips to real when SERP_API_KEY arrives)
// ---------------------------------------------------------------------------

/**
 * Build and return a SerpClient from the environment.
 *
 * Today: always returns `NotConfiguredSerpClient` (no SERP_API_KEY present).
 * When a real SERP API key is available, this factory will return the real
 * implementation that wraps the SERP API provider (e.g. ValueSERP, SerpAPI,
 * DataForSEO) — without changing any caller code.
 *
 * @param env  Env variable map (default: process.env). Injected for testability.
 */
export function makeSerpClient(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): SerpClient {
  const apiKey = env["SERP_API_KEY"];

  if (!apiKey) {
    // No key → stub. Surface adapters receive NOT_CONFIGURED gracefully.
    return new NotConfiguredSerpClient();
  }

  // TODO: when SERP_API_KEY is present, instantiate the real SERP API client.
  // For now we return stub even if a key appears (real implementation TBD).
  // This is intentional: the seam is ready; the real HTTP client is a future drop-in.
  void apiKey; // suppress unused-var lint until real impl lands
  return new NotConfiguredSerpClient();
}
