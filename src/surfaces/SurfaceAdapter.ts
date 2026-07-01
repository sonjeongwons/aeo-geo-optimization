/**
 * SurfaceAdapter — bridges SERP/scrape surfaces into the ProviderAdapter contract.
 *
 * DESIGN-phase4.md T07 / SPEC.md §4 (surfaces/tiers), §5 (measurement), §11 (cost).
 *
 * INVARIANTS:
 *   - Implements ProviderAdapter so SERP/scrape surfaces plug into the EXISTING
 *     runResponse → judge → SMR path WITHOUT any changes to core pipeline files.
 *   - generate() orchestrates: fetch (SERP or RPA) → parse → return prose as answerText.
 *   - judge() ALWAYS returns NOT_CONFIGURED. Surface adapters are not LLM judges;
 *     the judgeAdapter in RunResponseDeps handles judgment (Gemini forced-JSON).
 *   - NO_ANSWER (parser finds no AI answer) → GenerateNotConfigured is returned.
 *     Rationale: from the pipeline's perspective, a surface with no current answer is
 *     equivalent to "not configured for this query" — it persists as response_status=
 *     'not_configured', abstains from judgment, and records $0 in the ledger.
 *     This mirrors how NOT_CONFIGURED chat adapters are handled in runResponse.ts.
 *   - SERP calls are metered via surfacePricing.ts (surfaceUsdPerCall), recorded in
 *     AdapterUsage.usd so the llm_call ledger can capture the cost.
 *   - status is always 'not_configured' when the underlying client/runner is not armed;
 *     'ready' when it is armed. 'stub' is never used for SurfaceAdapter instances.
 *   - nSamples is clamped to 1 upstream (T13) for serp/scrape surfaces.
 *     The adapter itself does not enforce the clamp — it is a pure single-call unit.
 *
 * ARMING:
 *   SurfaceAdapter is "armed" when the client or runner it wraps reports configured=true.
 *   Until armed, generate() returns NOT_CONFIGURED immediately (no network call).
 *   The surface registry (T11) constructs adapters with the appropriate seam objects;
 *   tests can inject FixtureSerpClient / FixtureRpaRunner to arm them in unit tests.
 *
 * PROSE/CITATION SEPARATION:
 *   The adapter passes the parser's answerText directly as GenerateOk.answerText.
 *   Citations are stored in provider_meta so the pipeline can persist them, but they
 *   are NEVER concatenated into answerText. The judge sees clean prose only.
 *
 * Pure module — no pg, no @google/genai. IO is delegated to the client/runner seams.
 */

import { NOT_CONFIGURED } from "../providers/types.js";
import type {
  ProviderAdapter,
  GenerateRequest,
  GenerateResult,
  JudgeRequest,
  JudgeResult,
  AdapterUsage,
} from "../providers/types.js";
import type { Modality, SurfaceCapability } from "../domain/types.js";
import type { SurfaceId, SurfaceParser } from "./types.js";
import { NO_ANSWER } from "./types.js";
import type {
  SerpClient,
  SerpRequest,
  SerpResponseError,
} from "./serp/serpClient.js";
import type {
  RpaRunner,
  RpaRequest,
  RpaResponseError,
} from "./scrape/rpaRunner.js";
import { surfaceUsdPerCall, isSurfaceMeterEnabled } from "./surfacePricing.js";
import { assertNotSerpOnly, assertSerpOnly } from "./compliance.js";

// ---------------------------------------------------------------------------
// SurfaceAdapterConfig — configuration for a SERP or scrape surface adapter
// ---------------------------------------------------------------------------

/**
 * Configuration for the SERP variant of SurfaceAdapter.
 * Uses an official SERP API client (§12 compliant for googleAio, naverAi).
 */
export interface SerpSurfaceConfig {
  readonly kind: "serp";
  /** The canonical surface identifier. */
  readonly surfaceId: SurfaceId;
  /** The SERP API client (NotConfiguredSerpClient or FixtureSerpClient in tests). */
  readonly client: SerpClient;
  /** The parser that converts raw SERP API JSON → SurfaceAnswer | NO_ANSWER. */
  readonly parser: SurfaceParser;
  /**
   * Map a GenerateRequest.prompt to a SerpRequest.
   * Surface adapters supply this to translate the pipeline's prompt into
   * the SERP API's query + locale parameters.
   */
  readonly buildSerpRequest: (prompt: string, language: string) => SerpRequest;
}

/**
 * Configuration for the scrape variant of SurfaceAdapter.
 * Uses an RPA/headless-browser runner (§12 compliant: googleAio/naverAi
 * are NOT permitted here — use SerpSurfaceConfig for those).
 */
export interface ScrapeSurfaceConfig {
  readonly kind: "scrape";
  /** The canonical surface identifier. */
  readonly surfaceId: SurfaceId;
  /** The RPA runner (NotConfiguredRpaRunner or FixtureRpaRunner in tests). */
  readonly runner: RpaRunner;
  /** The parser that converts raw DOM/HTML → SurfaceAnswer | NO_ANSWER. */
  readonly parser: SurfaceParser;
  /**
   * Map a GenerateRequest.prompt to an RpaRequest.
   * Surface adapters supply this to translate the pipeline's prompt into
   * the RPA runner's target URL + query parameters.
   */
  readonly buildRpaRequest: (prompt: string, language: string) => RpaRequest;
}

/** Union config — either SERP or scrape. */
export type SurfaceAdapterConfig = SerpSurfaceConfig | ScrapeSurfaceConfig;

// ---------------------------------------------------------------------------
// SurfaceAdapter — implements ProviderAdapter
// ---------------------------------------------------------------------------

/**
 * SurfaceAdapter wraps a SERP or scrape surface so it fits the ProviderAdapter
 * contract that runResponse, the judge pipeline, and the SMR aggregator expect.
 *
 * Usage (SERP):
 *   const adapter = new SurfaceAdapter({
 *     kind: "serp",
 *     surfaceId: "googleAio",
 *     client: makeSerpClient(),
 *     parser: new AiOverviewParser(),
 *     buildSerpRequest: (prompt, lang) => ({ query: prompt, language: lang }),
 *   });
 *
 * Usage (scrape):
 *   const adapter = new SurfaceAdapter({
 *     kind: "scrape",
 *     surfaceId: "copilot",
 *     runner: makeRpaRunner(),
 *     parser: new CopilotParser(),
 *     buildRpaRequest: (prompt, lang) => ({ targetUrl: "https://copilot.microsoft.com", query: prompt, language: lang }),
 *   });
 */
export class SurfaceAdapter implements ProviderAdapter {
  readonly provider: string;
  readonly modality: Modality;
  readonly capabilities: SurfaceCapability[];

  private readonly config: SurfaceAdapterConfig;

  constructor(config: SurfaceAdapterConfig) {
    // CS-01: enforce §12 compliance at construction time, not per-caller convention.
    // This makes makeSurfaceAdapter({kind:'scrape', surfaceId:'googleAio',...}) THROW
    // immediately, regardless of which code path calls it.
    if (config.kind === "scrape") {
      // Scrape surfaces must NOT be SERP-only (googleAio / naverAi).
      assertNotSerpOnly(config.surfaceId);
    } else {
      // SERP surfaces must BE in SERP_ONLY_SURFACES.
      assertSerpOnly(config.surfaceId);
    }

    this.config = config;
    this.provider = config.surfaceId;
    this.modality = config.kind === "serp" ? "serp" : "scrape";
    // Surface adapters can generate but cannot judge (judge returns NOT_CONFIGURED).
    this.capabilities = ["generate"];
  }

  /**
   * Whether the underlying client/runner is armed (configured with a key/URL).
   * - 'ready'         — client/runner is configured; calls will proceed.
   * - 'not_configured'— client/runner has no key/URL; calls return NOT_CONFIGURED.
   */
  get status(): "ready" | "not_configured" {
    const configured =
      this.config.kind === "serp"
        ? this.config.client.configured
        : this.config.runner.configured;
    return configured ? "ready" : "not_configured";
  }

  // --------------------------------------------------------------------------
  // generate() — the core surface fetch + parse path
  // --------------------------------------------------------------------------

  /**
   * Fetch the surface response for the given prompt and parse it into prose.
   *
   * Flow:
   *   1. If client/runner is not configured → return NOT_CONFIGURED immediately.
   *   2. Call client.fetch() or runner.run() with the translated request.
   *   3. On NOT_CONFIGURED response → return NOT_CONFIGURED.
   *   4. On error response → return GenerateError (retryable or not).
   *   5. Parse the raw response via this.config.parser.parse().
   *   6. On parser NO_ANSWER → return NOT_CONFIGURED (no AI answer present).
   *   7. On parser DRIFT / SCHEMA_ERROR → return non-retryable GenerateError.
   *   8. On parser ok → return GenerateOk with clean prose (answerText) +
   *      citations packed into meta (PROSE/CITATION SEPARATION invariant).
   *
   * The language parameter is extracted from req.prompt if possible, but surfaces
   * use the modelId field as the surface's synthetic ID (e.g. "googleAio").
   * The actual query language is inferred from the prompt text or the language
   * param injected via buildSerpRequest / buildRpaRequest.
   *
   * NOTE: GenerateRequest.modelId for surfaces is the surfaceId (e.g. "googleAio").
   * The pipeline passes the adapter's surfaceId as the modelId when scheduling work-units.
   */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const { prompt, modelId: _modelId } = req;

    // PM-01 fix: use req.language directly (threaded from the work-unit via
    // runResponse → adapter.generate()). Fall back to "en" when absent (e.g.
    // legacy callers or chat adapters that do not supply the field).
    // The old extractLanguageFromPromptVersion sentinel is no longer the primary
    // source; it is kept as a secondary fallback for backward compatibility with
    // any callers that still encode "lang:<code>:<rest>" in promptVersion.
    const language =
      req.language ??
      extractLanguageFromPromptVersion(req.promptVersion) ??
      "en";

    if (this.config.kind === "serp") {
      return this._generateSerp(prompt, language);
    } else {
      return this._generateScrape(prompt, language);
    }
  }

  /**
   * judge() — always returns NOT_CONFIGURED.
   *
   * Surface adapters are not LLM judges. The judgeAdapter in RunResponseDeps
   * (always a Gemini adapter) handles judgment for all surface types, including
   * serp/scrape surfaces. This is the SAME judge pipeline as chat adapters.
   *
   * Returning NOT_CONFIGURED here causes runResponse to delegate judgment to
   * the separate judgeAdapter, which is the correct behavior for surfaces.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async judge(_req: JudgeRequest): Promise<JudgeResult> {
    return { ok: false, code: NOT_CONFIGURED };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async _generateSerp(
    prompt: string,
    language: string
  ): Promise<GenerateResult> {
    const { client, parser, buildSerpRequest, surfaceId } = this.config as SerpSurfaceConfig;

    // Step 1 — arming check.
    if (!client.configured) {
      return { ok: false, code: NOT_CONFIGURED };
    }

    // Step 2 — build and execute the SERP request.
    const serpReq = buildSerpRequest(prompt, language);
    const serpResp = await client.fetch(serpReq);

    // Step 3 — handle NOT_CONFIGURED from client (key was revoked mid-run).
    if (!serpResp.ok) {
      if (serpResp.code === NOT_CONFIGURED) {
        return { ok: false, code: NOT_CONFIGURED };
      }
      // Step 4 — SERP API error (type narrowed: code !== NOT_CONFIGURED means SerpResponseError).
      const errResp = serpResp as SerpResponseError;
      return {
        ok: false,
        code: errResp.code,
        message: errResp.message,
        retryable: errResp.retryable,
      };
    }

    // Step 5 — parse the raw SERP response.
    const parseResult = parser.parse(serpResp.raw);

    if (!parseResult.ok) {
      if (parseResult.code === NO_ANSWER) {
        // Step 6 — No AI answer block present on this query (e.g. AIO absent).
        // Treated as NOT_CONFIGURED so the pipeline records 'not_configured' status
        // and abstains from judgment, without counting as an error.
        return { ok: false, code: NOT_CONFIGURED };
      }
      // Step 7 — Parser drift or schema error → non-retryable error.
      return {
        ok: false,
        code: parseResult.code,
        message: parseResult.message,
        retryable: false,
      };
    }

    // Step 8 — Successful parse.
    const { answer } = parseResult;

    // Compute SERP call cost via surfacePricing (§11).
    const usd = isSurfaceMeterEnabled(surfaceId) ? surfaceUsdPerCall(surfaceId) : 0;

    const usage: AdapterUsage = {
      // SERP surfaces are not token-based; use 0 for token counts.
      inputTokens: 0,
      outputTokens: 0,
      usd,
      cacheHit: false,
    };

    // Pack citations into meta (PROSE/CITATION SEPARATION).
    // answerText is ONLY prose; citations are in meta.citations for DB storage.
    const meta: Record<string, unknown> = {
      surfaceId,
      citations: answer.citations,
      rawInput: answer.rawInput,
      nativeReview: answer.nativeReview ?? false,
    };

    return {
      ok: true,
      answerText: answer.answerText,
      usage,
      meta,
    };
  }

  private async _generateScrape(
    prompt: string,
    language: string
  ): Promise<GenerateResult> {
    const { runner, parser, buildRpaRequest, surfaceId } = this.config as ScrapeSurfaceConfig;

    // Step 1 — arming check.
    if (!runner.configured) {
      return { ok: false, code: NOT_CONFIGURED };
    }

    // Step 2 — build and execute the RPA request.
    const rpaReq = buildRpaRequest(prompt, language);
    const rpaResp = await runner.run(rpaReq);

    // Step 3 — handle NOT_CONFIGURED from runner (runner was removed mid-run).
    if (!rpaResp.ok) {
      if (rpaResp.code === NOT_CONFIGURED) {
        return { ok: false, code: NOT_CONFIGURED };
      }
      // Step 4 — RPA runner error (type narrowed: code !== NOT_CONFIGURED means RpaResponseError).
      const errResp = rpaResp as RpaResponseError;
      return {
        ok: false,
        code: errResp.code,
        message: errResp.message,
        retryable: errResp.retryable,
      };
    }

    // Step 5 — parse the raw DOM/HTML response.
    const parseResult = parser.parse(rpaResp.raw);

    if (!parseResult.ok) {
      if (parseResult.code === NO_ANSWER) {
        // Step 6 — No AI answer block present (page drift or absence).
        return { ok: false, code: NOT_CONFIGURED };
      }
      // Step 7 — Parser drift or schema error → non-retryable error.
      return {
        ok: false,
        code: parseResult.code,
        message: parseResult.message,
        retryable: false,
      };
    }

    // Step 8 — Successful parse.
    const { answer } = parseResult;

    // Scrape surfaces: cost tracked externally (isMeterEnabled=false).
    const usd = isSurfaceMeterEnabled(surfaceId) ? surfaceUsdPerCall(surfaceId) : 0;

    const usage: AdapterUsage = {
      inputTokens: 0,
      outputTokens: 0,
      usd,
      cacheHit: false,
    };

    // Pack citations into meta (PROSE/CITATION SEPARATION).
    const meta: Record<string, unknown> = {
      surfaceId,
      citations: answer.citations,
      rawInput: answer.rawInput,
      nativeReview: answer.nativeReview ?? false,
    };

    return {
      ok: true,
      answerText: answer.answerText,
      usage,
      meta,
    };
  }
}

// ---------------------------------------------------------------------------
// Language extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract the language code from a promptVersion string encoded as "lang:<code>:<rest>".
 *
 * The plan builder (T13) may encode the work-unit language in promptVersion to
 * propagate it through GenerateRequest (which has no explicit language field).
 *
 * Convention: promptVersion = "lang:<ISO-639-1>:<originalVersion>"
 * Example:     promptVersion = "lang:ko:v1.2"  → returns "ko"
 *
 * If the promptVersion does not follow this convention, returns null and the
 * adapter falls back to "en".
 *
 * @param promptVersion  The promptVersion string from GenerateRequest.
 * @returns              ISO 639-1 language code, or null if not encoded.
 */
export function extractLanguageFromPromptVersion(
  promptVersion: string
): string | null {
  const prefix = "lang:";
  if (!promptVersion.startsWith(prefix)) {
    return null;
  }
  // "lang:<code>:<rest>" → split on ":" and take second segment
  const parts = promptVersion.split(":");
  // parts[0] = "lang", parts[1] = language code, parts[2..] = original version
  if (parts.length >= 2 && parts[1] && parts[1].length > 0) {
    return parts[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// makeSurfaceAdapter — factory helper
// ---------------------------------------------------------------------------

/**
 * Convenience factory for building a SurfaceAdapter from a config.
 * Mirrors the `makeStubAdapter` / `makeGeminiAdapter` pattern.
 *
 * @param config  The surface adapter configuration (serp or scrape variant).
 * @returns       A new SurfaceAdapter instance.
 */
export function makeSurfaceAdapter(config: SurfaceAdapterConfig): SurfaceAdapter {
  return new SurfaceAdapter(config);
}
