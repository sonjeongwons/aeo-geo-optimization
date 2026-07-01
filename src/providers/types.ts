/**
 * Provider adapter contract — DESIGN.md §4 / "Provider adapter contract".
 *
 * NOT_CONFIGURED is a typed RETURNED VALUE, not an exception.
 * Adapters never throw for missing keys; they return a discriminated union.
 *
 * AdapterUsage carries the USD cost so §11 metering happens where tokens are known.
 * Modality + SurfaceCapability anticipate v1-b SERP/scrape surfaces.
 *
 * Pure types — no IO.
 */

import type { z } from "zod";
import type { JudgeVerdict } from "../domain/mention.schema.js";
import type { Modality, SurfaceCapability } from "../domain/types.js";

// Re-export for consumers of this module.
export type { Modality, SurfaceCapability };

// ---------------------------------------------------------------------------
// NOT_CONFIGURED — typed value, not an exception
// ---------------------------------------------------------------------------

export const NOT_CONFIGURED = "NOT_CONFIGURED" as const;
export type NotConfigured = typeof NOT_CONFIGURED;

// ---------------------------------------------------------------------------
// Token / cost usage
// ---------------------------------------------------------------------------

/**
 * Usage data returned with every adapter call so the cost ledger can record it.
 * usd = computed by the adapter using its own pricing knowledge.
 */
export interface AdapterUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD cost for this call. 0 for cache hits. */
  usd: number;
  /** True when the response was served from a provider-side cache (e.g. Gemini context cache). */
  cacheHit: boolean;
}

// ---------------------------------------------------------------------------
// GenerateResult discriminated union
// ---------------------------------------------------------------------------

export interface GenerateOk {
  ok: true;
  answerText: string;
  usage: AdapterUsage;
  /** Raw provider response metadata (persisted as provider_meta JSONB). */
  meta: Record<string, unknown>;
}

export interface GenerateNotConfigured {
  ok: false;
  code: NotConfigured;
}

export interface GenerateError {
  ok: false;
  /** RATE_LIMITED | TIMEOUT | PROVIDER_ERROR | etc. */
  code: string;
  message: string;
  /** Whether the pipeline may retry this call. */
  retryable: boolean;
  usage?: AdapterUsage;
}

export type GenerateResult =
  | GenerateOk
  | GenerateNotConfigured
  | GenerateError;

// ---------------------------------------------------------------------------
// JudgeResult discriminated union
// ---------------------------------------------------------------------------

export interface JudgeOk {
  ok: true;
  verdict: JudgeVerdict;
  raw: unknown;
  usage: AdapterUsage;
  /** Model ID actually used (may differ on escalation). */
  modelId: string;
}

export interface JudgeNotConfigured {
  ok: false;
  code: NotConfigured;
}

export interface JudgeParseFailed {
  ok: false;
  code: "PARSE_FAILED";
  raw: unknown;
  usage: AdapterUsage;
  modelId: string;
}

export interface JudgeError {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
  usage?: AdapterUsage;
}

export type JudgeResult =
  | JudgeOk
  | JudgeNotConfigured
  | JudgeParseFailed
  | JudgeError;

// ---------------------------------------------------------------------------
// GenerateStructured request / result  (T02 — forced-JSON structured output)
// ---------------------------------------------------------------------------

/**
 * Request for a structured-JSON Gemini call.
 * The caller supplies a Zod schema; the adapter enforces it via responseMimeType
 * + responseSchema and validates the returned JSON before returning.
 */
export interface GenerateStructuredRequest<T extends z.ZodTypeAny = z.ZodTypeAny> {
  modelId: string;
  prompt: string;
  systemInstruction?: string;
  temperature: number;
  /** Zod schema used both to derive responseSchema for Gemini and to safeParse the result. */
  schema: T;
}

export interface GenerateStructuredOk<T> {
  ok: true;
  data: T;
  usage: AdapterUsage;
}

export interface GenerateStructuredNotConfigured {
  ok: false;
  code: NotConfigured;
}

export interface GenerateStructuredError {
  ok: false;
  /** PARSE_FAILED | RATE_LIMITED | TIMEOUT | PROVIDER_ERROR */
  code: string;
  message?: string;
  retryable?: boolean;
  raw?: unknown;
  usage?: AdapterUsage;
}

export type GenerateStructuredResult<T> =
  | GenerateStructuredOk<T>
  | GenerateStructuredNotConfigured
  | GenerateStructuredError;

// ---------------------------------------------------------------------------
// Generate request
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  prompt: string;
  modelId: string;
  temperature: number;
  /** Prompt version tag for the request_hash. */
  promptVersion: string;
  /**
   * ISO 639-1 language code for the work-unit (e.g. "en", "ko", "ja").
   *
   * Used by SERP/scrape surface adapters to pass the correct locale to the
   * SERP API or RPA runner (via buildSerpRequest / buildRpaRequest).
   * Chat adapters ignore this field — they receive language in the prompt body.
   *
   * Optional for backward compatibility with existing callers and tests that
   * do not supply language (they get the adapter's default, typically "en").
   */
  language?: string;
  /**
   * When true, chat adapters that support web grounding (Gemini Google Search)
   * enable the search tool and return the retrieval trace on meta.grounding
   * (SOTA v3). Off by default — grounding bills the Search tool and changes WHAT
   * is measured (a grounded vs ungrounded model). Adapters without grounding
   * ignore this flag.
   */
  grounded?: boolean;
}

// ---------------------------------------------------------------------------
// Judge request
// ---------------------------------------------------------------------------

export interface JudgeRequest {
  /** The answer text to judge. */
  answerText: string;
  /** The brand canonical name. */
  brandName: string;
  /** All brand aliases (canonical name + aliases). */
  brandAliases: string[];
  /** All tracked competitors with their aliases. */
  competitors: Array<{ name: string; aliases: string[] }>;
  /**
   * Preferred judge model ID (e.g. "gemini-2.5-flash-lite").
   * The adapter may escalate to a more powerful model on parse failure.
   */
  preferredModelId: string;
  /** Escalation model ID (e.g. "gemini-2.5-pro"). Used on PARSE_FAILED. */
  escalationModelId?: string;
}

// ---------------------------------------------------------------------------
// ProviderAdapter interface
// ---------------------------------------------------------------------------

/**
 * The ONE seam that v1-b SERP/scrape surfaces slot into.
 *
 * - generate(): produce a free-text answer for a prompt.
 * - judge(): optional; only providers that support forced-JSON implement it.
 *            Returns NOT_CONFIGURED if unsupported.
 * - modality: "chat" (normal LLM), "serp" (search/grounding), "scrape".
 * - capabilities: what this adapter can do.
 * - status: "ready" (key present), "stub" (no implementation), "not_configured" (key absent).
 */
export interface ProviderAdapter {
  readonly provider: string;
  readonly modality: Modality;
  readonly capabilities: SurfaceCapability[];
  readonly status: "ready" | "stub" | "not_configured";

  generate(req: GenerateRequest): Promise<GenerateResult>;

  /**
   * LLM-as-judge. Returns NOT_CONFIGURED if this adapter doesn't support judging.
   * The orchestration layer (extractMention) calls this and falls back to rule-based.
   */
  judge(req: JudgeRequest): Promise<JudgeResult>;

  /**
   * Structured-JSON generation (T02 / Phase 1 seam).
   * Forces Gemini responseMimeType:'application/json' + responseSchema, then
   * validates the parsed result against the caller-supplied Zod schema.
   * Returns NOT_CONFIGURED when the API key is absent.
   * Optional: only GeminiAdapter implements it; stubs may omit.
   */
  generateStructured?<T extends z.ZodTypeAny>(
    req: GenerateStructuredRequest<T>
  ): Promise<GenerateStructuredResult<z.infer<T>>>;
}

// ---------------------------------------------------------------------------
// Registry readiness
// ---------------------------------------------------------------------------

export type ProviderStatus = "ready" | "stub" | "not_configured";

export interface ProviderReadiness {
  provider: string;
  status: ProviderStatus;
  modality: Modality;
}
