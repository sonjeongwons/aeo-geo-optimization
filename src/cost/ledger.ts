/**
 * src/cost/ledger.ts
 *
 * LLM call ledger — inserts one `llm_call` row per generation call and one
 * per judge call. Cache hits are recorded with usd=0, cache_hit=true.
 * NOT_CONFIGURED / abstain calls write usd=0.
 *
 * Design rules (DESIGN.md §11):
 * - Every generation AND judge call writes a row (even on failure/abstain).
 * - Cache hits: usd=0, cache_hit=true.
 * - NOT_CONFIGURED: usd=0, cache_hit=false (provider returned no tokens).
 * - Abstain: when the judge produces an abstain verdict, the judge call row
 *   was still made (tokens consumed) so usd is real; abstain is a JUDGMENT
 *   outcome, not a ledger skipping trigger.
 * - This module has NO direct DB import — it uses the `LedgerWritePort` seam
 *   so it is testable without a real database.
 *
 * The `ts` and `id` columns are set by the DB (DEFAULT now() / gen_random_uuid());
 * the caller only supplies the application-level fields.
 */

import type { LlmCallPurpose } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Port (seam) — implemented by src/db/repo.ts in production
// ---------------------------------------------------------------------------

/**
 * One row to be inserted into the `llm_call` hypertable.
 * Matches the DDL columns exactly; `ts` and `id` are DB-generated defaults.
 */
export interface LlmCallRow {
  customerId: string;
  runId: string;
  purpose: LlmCallPurpose;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  cacheHit: boolean;
  /** Link back to the response_raw row this call produced / judged. */
  responseRawId: string | null;
}

export interface LedgerWritePort {
  insertLlmCall(row: LlmCallRow): Promise<void>;
}

// ---------------------------------------------------------------------------
// Ledger entry builders
// ---------------------------------------------------------------------------

/** Input shape for recording a generation call. */
export interface GenerationCallInput {
  customerId: string;
  runId: string;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  cacheHit: boolean;
  responseRawId: string | null;
}

/** Input shape for recording a judge call. */
export interface JudgeCallInput {
  customerId: string;
  runId: string;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** Always false for judge calls (judges are never cache-hit — per-call). */
  cacheHit?: boolean;
  responseRawId: string | null;
}

/** Input shape for recording a NOT_CONFIGURED provider "call" (no tokens). */
export interface NotConfiguredCallInput {
  customerId: string;
  runId: string;
  purpose: LlmCallPurpose;
  provider: string;
  modelId: string;
  responseRawId: string | null;
}

/** Input shape for recording a cache-hit (cross-cycle dedup). */
export interface CacheHitInput {
  customerId: string;
  runId: string;
  purpose: LlmCallPurpose;
  provider: string;
  modelId: string;
  responseRawId: string | null;
}

// ---------------------------------------------------------------------------
// Ledger class
// ---------------------------------------------------------------------------

/**
 * Ledger: records all LLM call costs to the `llm_call` hypertable.
 *
 * Inject via dependency injection (DI seam) into the pipeline and any other
 * module that makes LLM calls. The production implementation passes a real
 * `LedgerWritePort`; tests inject a recording stub.
 */
export class Ledger {
  constructor(private readonly writer: LedgerWritePort) {}

  /**
   * Record one generation call.
   * Cache hits should use `recordCacheHit` instead; this method still accepts
   * cacheHit=true for convenience when the caller already has the flag.
   */
  async recordGeneration(input: GenerationCallInput): Promise<void> {
    await this.writer.insertLlmCall({
      customerId: input.customerId,
      runId: input.runId,
      purpose: "generation",
      provider: input.provider,
      modelId: input.modelId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      usd: input.usd,
      cacheHit: input.cacheHit,
      responseRawId: input.responseRawId,
    });
  }

  /**
   * Record one judge call.
   * Judge calls are never cache-hit (they are always fresh per-response).
   */
  async recordJudge(input: JudgeCallInput): Promise<void> {
    await this.writer.insertLlmCall({
      customerId: input.customerId,
      runId: input.runId,
      purpose: "judge",
      provider: input.provider,
      modelId: input.modelId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      usd: input.usd,
      cacheHit: input.cacheHit ?? false,
      responseRawId: input.responseRawId,
    });
  }

  /**
   * Record a NOT_CONFIGURED provider "call".
   * No tokens were exchanged; usd=0, cache_hit=false.
   * Still written so the ledger provides a complete audit trail of all
   * work-unit attempts including skipped ones.
   */
  async recordNotConfigured(input: NotConfiguredCallInput): Promise<void> {
    await this.writer.insertLlmCall({
      customerId: input.customerId,
      runId: input.runId,
      purpose: input.purpose,
      provider: input.provider,
      modelId: input.modelId,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      cacheHit: false,
      responseRawId: input.responseRawId,
    });
  }

  /**
   * Record a cross-cycle cache hit (request_hash dedup).
   * usd=0, cache_hit=true — the response was served from the cache so no
   * tokens were consumed.
   */
  async recordCacheHit(input: CacheHitInput): Promise<void> {
    await this.writer.insertLlmCall({
      customerId: input.customerId,
      runId: input.runId,
      purpose: input.purpose,
      provider: input.provider,
      modelId: input.modelId,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      cacheHit: true,
      responseRawId: input.responseRawId,
    });
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (functional alternative to the class)
// ---------------------------------------------------------------------------

/**
 * Build a generation LlmCallRow from adapter usage data.
 * Useful when the caller wants to build the row before writing it.
 */
export function buildGenerationRow(
  input: GenerationCallInput
): LlmCallRow {
  return {
    customerId: input.customerId,
    runId: input.runId,
    purpose: "generation",
    provider: input.provider,
    modelId: input.modelId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    usd: input.usd,
    cacheHit: input.cacheHit,
    responseRawId: input.responseRawId,
  };
}

/**
 * Build a judge LlmCallRow from judge usage data.
 */
export function buildJudgeRow(input: JudgeCallInput): LlmCallRow {
  return {
    customerId: input.customerId,
    runId: input.runId,
    purpose: "judge",
    provider: input.provider,
    modelId: input.modelId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    usd: input.usd,
    cacheHit: input.cacheHit ?? false,
    responseRawId: input.responseRawId,
  };
}
