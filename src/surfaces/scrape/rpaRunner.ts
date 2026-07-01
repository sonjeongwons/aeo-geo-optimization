/**
 * RPA runner seam — T06 (Phase 4, surface v1-b).
 *
 * DESIGN-phase4.md §T06 / SPEC.md §4 (surfaces/tiers), §12 (compliance).
 *
 * KEY INVARIANTS:
 *   - NOT_CONFIGURED stub today: no RPA/headless-browser infra is present yet.
 *     Flips to real when a runner arrives (RPA_RUNNER_URL env var).
 *   - §12 compliance: Google AI Overviews + Naver AI MUST NOT be constructible
 *     via this RPA runner. Their adapters (T10) accept only a SerpClient.
 *     Scrape surfaces (Copilot, Meta AI, Line, Kakao) use this runner.
 *   - RpaRunner.configured returns false until a real runner is injected.
 *   - Scrape surfaces are DISABLED by default (SurfaceMeta.enabled = false).
 *     They activate only when an RPA runner is configured AND the surface is
 *     explicitly enabled.
 *   - Unit-testable with fixtures — no live browser/network calls.
 *   - All outcomes are typed return values; NEVER throw for missing runner.
 *
 * The `RpaRunner` interface is the seam that scrape surface adapters (T10) depend on.
 * The `NotConfiguredRpaRunner` stub is what gets wired in today (T11/T16).
 * When RPA_RUNNER_URL is set, `makeRpaRunner()` returns the real implementation.
 *
 * Pure module — no pg, no @google/genai.
 */

import { NOT_CONFIGURED } from "../../providers/types.js";
import type { NotConfigured } from "../../providers/types.js";

// ---------------------------------------------------------------------------
// RPA request / response shapes
// ---------------------------------------------------------------------------

/**
 * An RPA runner request — what scrape surface adapters pass to the runner.
 */
export interface RpaRequest {
  /**
   * The target URL to navigate to (e.g. "https://copilot.microsoft.com").
   * The runner opens this URL in a headless browser session.
   */
  targetUrl: string;
  /**
   * The query / question text to submit in the surface's input field.
   * The runner locates the input, types the query, and submits.
   */
  query: string;
  /**
   * ISO 639-1 language code for the query (e.g. "en", "ja", "ko").
   * Used to set Accept-Language headers or UI locale if needed.
   */
  language: string;
  /**
   * Maximum wait time in milliseconds for the AI answer to appear.
   * Defaults to 30_000 (30 s) if not set.
   */
  timeoutMs?: number;
  /**
   * Opaque extra params forwarded to the runner (e.g. surface-specific
   * CSS selectors, wait conditions, scroll actions).
   */
  params?: Record<string, string>;
}

/**
 * A successful RPA run — the raw DOM snapshot or extracted HTML/JSON
 * returned by the runner.
 * The surface-specific parsers (T09) consume this.
 */
export interface RpaResponseOk {
  ok: true;
  /**
   * The raw DOM snapshot or extracted content from the page.
   * May be a string (HTML fragment) or an unknown structured blob,
   * depending on what the RPA runner extracts. Parsers narrow to their
   * expected shape.
   */
  raw: unknown;
  /**
   * USD cost metered via the llm_call ledger (§11 surfacePricing).
   * Typically 0 for scrape runs (no per-call API billing), but reserved
   * for future RPA-as-a-service pricing.
   */
  usdCost: number;
}

/**
 * NOT_CONFIGURED — no RPA runner is available.
 * Scrape surface adapters surface this as a NOT_CONFIGURED generate() result.
 */
export interface RpaResponseNotConfigured {
  ok: false;
  code: NotConfigured;
}

/**
 * RPA run failed (navigation error, timeout, selector drift, auth wall).
 */
export interface RpaResponseError {
  ok: false;
  /** TIMEOUT | NAVIGATION_ERROR | SELECTOR_DRIFT | AUTH_WALL | RUNNER_ERROR */
  code: string;
  message: string;
  retryable: boolean;
}

/** Discriminated union of all RPA runner call outcomes. */
export type RpaResponse =
  | RpaResponseOk
  | RpaResponseNotConfigured
  | RpaResponseError;

// ---------------------------------------------------------------------------
// RpaRunner interface — the seam
// ---------------------------------------------------------------------------

/**
 * The RPA/headless-browser runner seam.
 *
 * Scrape surface adapters (T10) depend only on this interface. The stub and
 * real implementations are swapped via `makeRpaRunner()`.
 *
 * §12 compliance: Google AI Overviews + Naver AI are SERP-API-only and MUST
 * NOT be constructed via this runner. Enforced by construction: their adapters
 * (T10) accept only a SerpClient, never an RpaRunner.
 */
export interface RpaRunner {
  /**
   * Whether this runner is configured and available.
   * Scrape surface adapters check this before calling `run()` and return
   * NOT_CONFIGURED immediately if false (no browser session started).
   */
  readonly configured: boolean;

  /**
   * Execute an RPA run: navigate to `targetUrl`, submit `query`, wait for the
   * AI answer element, and return the raw DOM snapshot or extracted content.
   *
   * When `configured` is false, returns `{ ok: false, code: NOT_CONFIGURED }`.
   * NEVER throws — all outcomes are typed return values.
   */
  run(req: RpaRequest): Promise<RpaResponse>;
}

// ---------------------------------------------------------------------------
// NotConfiguredRpaRunner — stub for today (no RPA infra)
// ---------------------------------------------------------------------------

/**
 * Stub RPA runner — returned when no RPA runner is configured.
 *
 * Mirrors the NOT_CONFIGURED pattern from providers/stub.ts:
 *   - configured: false
 *   - run(): always returns { ok: false, code: NOT_CONFIGURED }
 *
 * The stub is unit-testable with fixtures: callers can inject a
 * FixtureRpaRunner (returning fixture DOM/HTML) in tests.
 */
export class NotConfiguredRpaRunner implements RpaRunner {
  readonly configured = false as const;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_req: RpaRequest): Promise<RpaResponse> {
    return { ok: false, code: NOT_CONFIGURED };
  }
}

// ---------------------------------------------------------------------------
// FixtureRpaRunner — test helper (injects fixture DOM/HTML)
// ---------------------------------------------------------------------------

/**
 * Test fixture RPA runner — returns a pre-set raw DOM/HTML blob as if it came
 * from a real headless browser session. Used in unit tests (T17) for scrape
 * parsers and adapters WITHOUT any live browser/network calls.
 *
 * Usage:
 *   const runner = new FixtureRpaRunner("<html>...AI answer...</html>");
 *   const result = await runner.run({ targetUrl: "...", query: "...", language: "en" });
 *   // result.ok === true, result.raw === the fixture HTML
 */
export class FixtureRpaRunner implements RpaRunner {
  readonly configured = true as const;

  constructor(
    private readonly fixtureRaw: unknown,
    private readonly usdCost: number = 0
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_req: RpaRequest): Promise<RpaResponse> {
    return { ok: true, raw: this.fixtureRaw, usdCost: this.usdCost };
  }
}

// ---------------------------------------------------------------------------
// makeRpaRunner — factory (flips to real when RPA_RUNNER_URL arrives)
// ---------------------------------------------------------------------------

/**
 * Build and return an RpaRunner from the environment.
 *
 * Today: always returns `NotConfiguredRpaRunner` (no RPA infra present).
 * When an RPA runner URL is configured, this factory will return the real
 * implementation that connects to the headless-browser runner service —
 * without changing any caller code.
 *
 * @param env  Env variable map (default: process.env). Injected for testability.
 */
export function makeRpaRunner(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): RpaRunner {
  const runnerUrl = env["RPA_RUNNER_URL"];

  if (!runnerUrl) {
    // No runner configured → stub. Scrape surface adapters receive NOT_CONFIGURED.
    return new NotConfiguredRpaRunner();
  }

  // TODO: when RPA_RUNNER_URL is present, instantiate the real RPA runner client
  // that proxies requests to the headless-browser service.
  // For now we return stub even if a URL appears (real implementation TBD).
  // This is intentional: the seam is ready; the real runner is a future drop-in.
  void runnerUrl; // suppress unused-var lint until real impl lands
  return new NotConfiguredRpaRunner();
}
