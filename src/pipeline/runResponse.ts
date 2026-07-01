/**
 * src/pipeline/runResponse.ts
 *
 * runResponse — executes ONE work-unit for the AEO/GEO pipeline.
 *
 * DESIGN.md T13 / "SAMPLE+JUDGE (per work-unit, 1 DB tx)" step-by-step:
 *
 *   1. RESUME CHECK  — if work_unit.status='done', return immediately.
 *   2. budget.assertWithinCap  — fail-closed USD gate (§11).
 *   3. cache.check             — cross-cycle dedup (intra-cycle NEVER collapsed).
 *   4. provider.generate()     — real LLM call; NOT_CONFIGURED typed value handled.
 *   5. insertResponseRaw       — persist the raw answer (or error/cached status).
 *   6. ledger.recordGeneration — write llm_call(generation) row.
 *   7. extractMentionForStoredResponse — judge pipeline §5.4.
 *   8. runGates('measurement') — evidenceRequiredGate etc. (§7).
 *   9. insertJudgment          — persist mention_judgment row (APPEND-ONLY).
 *  10. ledger.recordJudge      — write llm_call(judge) row (if a call was made).
 *  11. markWorkUnitDone        — idempotent status update.
 *
 * "1 DB tx" in the DESIGN means logical atomicity via idempotent keys and
 * work_unit.done idempotency, NOT a single SQL transaction (hypertable inserts
 * cannot share a transaction with other DDL in TimescaleDB).
 *
 * Throws:
 *   RetryableJobError — for RATE_LIMITED / TIMEOUT (caller re-throws to pg-boss)
 *   BudgetExceededError / CostDataMissingError — propagate; caller sets over_budget
 *   Other errors — propagate; worker marks the work-unit 'error' and dead-letters
 */

import pino from "pino";
import Bottleneck from "bottleneck";
import type { ProviderAdapter, GenerateResult } from "../providers/types.js";
import { shouldGround } from "../providers/groundingPolicy.js";
import type { ResponseRunPayload } from "../scheduler/jobs.js";
import { RetryableJobError } from "../scheduler/jobs.js";
import { extractMentionForStoredResponse } from "../judge/extractMention.js";
import {
  assertWithinCapOrNew,
  type CostReadPort,
} from "../cost/budget.js";
import { Ledger } from "../cost/ledger.js";
import {
  createResponseCache,
  type CacheQueryFns,
  type ResponseCache,
} from "../cost/cache.js";
import {
  runGates,
  type Gate,
  type GateContext,
} from "../guardrails/gate.js";
import * as repo from "../db/repo.js";
import type { Budget } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = pino({ name: "pipeline.runResponse" });

// ---------------------------------------------------------------------------
// RunResponseDeps — dependency injection seam
// ---------------------------------------------------------------------------

/**
 * All external dependencies needed by runResponse.
 *
 * The production caller (worker handler via runCycle.ts) wires these from
 * global singletons created at startup.  Tests inject lightweight doubles.
 */
export interface RunResponseDeps {
  /** The provider adapter for this work-unit's modelId. */
  adapter: ProviderAdapter;

  /**
   * The Gemini adapter used as the LLM judge (§5.4).
   * Usually a Gemini adapter regardless of which provider generated the response,
   * since only Gemini supports forced-JSON responseSchema judging in Phase 0.
   */
  judgeAdapter: ProviderAdapter;

  /** Customer budget caps (read from DB at cycle start, passed through). */
  budget: Budget;

  /**
   * True when this is the very first call of a fresh customer with no prior
   * spend history.  assertWithinCapOrNew treats null CAGG data as $0 rather
   * than failing closed (since the CAGG cannot have data before the first call).
   */
  isNewCustomer?: boolean;

  /**
   * Cost read port (seam for the budget assertion).
   * Production: backed by a wrapper over repo.sumCostSince.
   */
  costReader: CostReadPort;

  /** Ledger for writing llm_call rows (generation + judge). */
  ledger: Ledger;

  /**
   * DB cache query functions (for cross-cycle dedup).
   * Used when responseCache is not provided.
   */
  cacheFns: CacheQueryFns;

  /**
   * Optional pre-built ResponseCache instance.
   *
   * When runCycle fans out work-units sequentially it SHOULD pass a shared
   * ResponseCache so the seenInRun set spans all work-units in the run, which
   * is what enforces intra-cycle sample non-collapse (DESIGN §5.3 / §11).
   *
   * If absent, a new per-call cache is created (relying on the fact that
   * cross-cycle DB cache entries cannot exist for the current run's hashes
   * until AFTER the first call for each hash completes — which is always true
   * for a fresh run).
   */
  responseCache?: ResponseCache;

  /**
   * Ordered list of measurement-phase gates (injected, not hard-imported).
   * Typically: [evidenceRequiredGate] (see guardrails/).
   */
  gates: readonly Gate[];

  /** Brand info for alias-normalized judgment. */
  brand: {
    name: string;
    aliases: string[];
  };

  /** Tracked competitors for judgment + SoV. */
  competitors: Array<{ name: string; aliases: string[] }>;

  /**
   * Per-provider Bottleneck limiters.
   * If absent, calls are made without rate limiting.
   */
  limiters?: Map<string, Bottleneck>;
}

// ---------------------------------------------------------------------------
// runResponse — main export
// ---------------------------------------------------------------------------

/**
 * Execute one work-unit.
 *
 * Returns when the work-unit has been persisted and marked done.
 * Throws on retryable errors (RetryableJobError) or budget violations.
 */
export async function runResponse(
  payload: ResponseRunPayload,
  deps: RunResponseDeps
): Promise<void> {
  const {
    runId,
    customerId,
    questionId,
    modelId,
    language,
    sampleIdx,
    requestHash,
    prompt,
    promptVersion,
    temperature,
  } = payload;

  const {
    adapter,
    judgeAdapter,
    budget,
    isNewCustomer = false,
    costReader,
    ledger,
    cacheFns,
    gates,
    brand,
    competitors,
    limiters,
  } = deps;

  // ------------------------------------------------------------------
  // STEP 1 — RESUME CHECK: skip already-done work units (idempotent resume).
  // ------------------------------------------------------------------
  const existingUnits = await repo.findWorkUnits(runId);
  const thisUnit = existingUnits.find(
    (u) =>
      u.question_id === questionId &&
      u.model_id === modelId &&
      u.language === language &&
      u.sample_idx === sampleIdx
  );

  if (thisUnit?.status === "done") {
    log.debug(
      { runId, questionId, modelId, language, sampleIdx },
      "runResponse: work unit already done — skipping (idempotent resume)"
    );
    return;
  }

  // ------------------------------------------------------------------
  // STEP 2 — Budget gate (fail-CLOSED §11).
  // ------------------------------------------------------------------
  try {
    await assertWithinCapOrNew({ customerId, budget, costReader, isNewCustomer });
  } catch (err) {
    log.warn(
      { runId, questionId, modelId, language, sampleIdx, err },
      "runResponse: budget gate blocked — marking work unit error"
    );
    await repo.markWorkUnitError(runId, questionId, modelId, language, sampleIdx);
    throw err; // Caller (runCycle) catches BudgetExceededError → sets over_budget
  }

  // ------------------------------------------------------------------
  // STEP 3 — Cross-cycle cache check.
  //
  // Intra-cycle non-collapse is guaranteed by the ResponseCache.seenInRun set.
  // When a shared ResponseCache is passed (recommended for sequential fan-out),
  // the first call for a given requestHash marks it as seen; all subsequent
  // same-run calls for the same hash return a miss — ensuring N real calls.
  // ------------------------------------------------------------------
  const responseCache =
    deps.responseCache ?? createResponseCache(cacheFns);

  // Cost-controlled grounding decision, computed HERE (before the cache) because
  // grounded work-units are EXCLUDED from the cross-cycle cache (v11 Z3/Z4):
  //   - A grounded and ungrounded answer to the same prompt share a request_hash
  //     (the hash omits `grounded`), but they are DIFFERENT responses — different
  //     content + a grounding trace only the grounded one carries.
  //   - response_cache stores ONLY answerText (no provider_meta), so a cache hit
  //     would serve a grounded unit an answer with NO grounding trace, dropping it
  //     from the earned-source corpus and corrupting the grounded subsample.
  // So a grounded unit always makes a fresh real call and never reads/writes cache.
  // Keyed WITHOUT modelId so every engine grounds the same subset. Non-Gemini
  // adapters ignore the flag.
  const grounded = shouldGround(`${questionId}:${language}:${sampleIdx}`);
  const cacheResult = grounded ? null : await responseCache.check(requestHash, runId);

  // Mutable state accumulated by generation step.
  let answerText: string | null = null;
  let responseStatus: "ok" | "not_configured" | "error" | "cached" = "ok";
  let providerMeta: Record<string, unknown> | null = null;
  let genInputTokens = 0;
  let genOutputTokens = 0;
  let genUsd = 0;
  let genCacheHit = false;

  if (cacheResult?.hit) {
    // Cross-cycle cache hit — serve the cached answer.
    answerText = cacheResult.answerText;
    responseStatus = "cached";
    genCacheHit = true;

    log.debug(
      { runId, questionId, requestHash, sampleIdx },
      "runResponse: cross-cycle cache hit"
    );
  } else {
    // ------------------------------------------------------------------
    // STEP 4 — provider.generate()
    // ------------------------------------------------------------------
    let generateResult: GenerateResult;

    // `grounded` was decided above (before the cache), so grounded units bypass
    // the cross-cycle cache and always make a fresh real call (v11 Z3/Z4).
    const limiter = limiters?.get(adapter.provider.toLowerCase());
    if (limiter) {
      generateResult = await limiter.schedule(() =>
        adapter.generate({ prompt, modelId, temperature, promptVersion, language, grounded })
      );
    } else {
      generateResult = await adapter.generate({ prompt, modelId, temperature, promptVersion, language, grounded });
    }

    if (!generateResult.ok) {
      if (generateResult.code === "NOT_CONFIGURED") {
        // Planner should have excluded unconfigured providers, but handle defensively.
        log.warn(
          { runId, questionId, modelId },
          "runResponse: provider NOT_CONFIGURED — persisting and marking error"
        );
        responseStatus = "not_configured";
        answerText = null;
      } else {
        // Generation error (RATE_LIMITED / TIMEOUT / PROVIDER_ERROR).
        const errResult = generateResult as { code: string; message: string; retryable: boolean; usage?: { inputTokens: number; outputTokens: number; usd: number } };
        responseStatus = "error";
        answerText = null;

        log.warn(
          { runId, questionId, modelId, code: errResult.code, retryable: errResult.retryable },
          "runResponse: generation error"
        );

        // Persist the error response and llm_call before (potentially) retrying.
        const rawRow = await repo.insertResponseRaw({
          runId,
          customerId,
          questionId,
          modelId,
          language,
          sampleIdx,
          temperature,
          requestHash,
          promptVersion,
          answerText: null,
          providerMeta: { error: errResult.code, message: errResult.message },
          status: "error",
        });

        await ledger.recordGeneration({
          customerId,
          runId,
          provider: adapter.provider,
          modelId,
          inputTokens: errResult.usage?.inputTokens ?? 0,
          outputTokens: errResult.usage?.outputTokens ?? 0,
          usd: errResult.usage?.usd ?? 0,
          cacheHit: false,
          responseRawId: rawRow.id,
        });

        await repo.markWorkUnitError(runId, questionId, modelId, language, sampleIdx);

        if (errResult.retryable) {
          const retryCode =
            errResult.code === "RATE_LIMITED"
              ? "RATE_LIMITED"
              : errResult.code === "TIMEOUT"
              ? "TIMEOUT"
              : "TRANSIENT";
          throw new RetryableJobError(
            retryCode,
            `Generation failed with retryable code: ${errResult.code}`
          );
        }

        // Non-retryable error — work-unit is already marked error; return cleanly.
        return;
      }
    } else {
      // Successful generation.
      answerText = generateResult.answerText;
      responseStatus = "ok";
      providerMeta = generateResult.meta;
      genInputTokens = generateResult.usage.inputTokens;
      genOutputTokens = generateResult.usage.outputTokens;
      genUsd = generateResult.usage.usd;
      genCacheHit = generateResult.usage.cacheHit;

      // Store in cross-cycle cache for future dedup (DESIGN §11 caching) — but
      // NEVER cache a grounded response: the cache drops provider_meta (grounding
      // trace), so a later hit would look ungrounded (v11 Z3/Z4).
      if (!grounded) {
        await responseCache.store(requestHash, answerText);
      }
    }
  }

  // ------------------------------------------------------------------
  // STEP 5 — insertResponseRaw
  // (For the retryable/not_configured paths above, this is done before
  //  the early return/throw.  For ok/cached/not_configured-defensive paths,
  //  we continue here.)
  //
  // Note: the error-retryable path already returned/threw above.
  // The not_configured defensive path falls through here.
  // ------------------------------------------------------------------
  const rawRow = await repo.insertResponseRaw({
    runId,
    customerId,
    questionId,
    modelId,
    language,
    sampleIdx,
    temperature,
    requestHash,
    promptVersion,
    answerText,
    providerMeta,
    status: responseStatus,
  });

  const responseRawId = rawRow.id;

  // ------------------------------------------------------------------
  // STEP 6 — llm_call(generation)
  // ------------------------------------------------------------------
  if (responseStatus === "cached") {
    await ledger.recordCacheHit({
      customerId,
      runId,
      purpose: "generation",
      provider: adapter.provider,
      modelId,
      responseRawId,
    });
  } else if (responseStatus === "not_configured") {
    await ledger.recordNotConfigured({
      customerId,
      runId,
      purpose: "generation",
      provider: adapter.provider,
      modelId,
      responseRawId,
    });
  } else {
    // status === "ok" (or "error" that didn't early-return — shouldn't happen but guard).
    await ledger.recordGeneration({
      customerId,
      runId,
      provider: adapter.provider,
      modelId,
      inputTokens: genInputTokens,
      outputTokens: genOutputTokens,
      usd: genUsd,
      cacheHit: genCacheHit,
      responseRawId,
    });
  }

  // ------------------------------------------------------------------
  // STEP 7 — extractMentionForStoredResponse (§5.4 judge pipeline).
  //
  // For not_configured responses with no answerText, extractMention returns
  // abstain immediately (skipping unnecessary judge calls).
  // ------------------------------------------------------------------
  const mentionResult = await extractMentionForStoredResponse(responseStatus, {
    answerText,
    brandName: brand.name,
    brandAliases: brand.aliases,
    competitors,
    judgeAdapter,
  });

  const { verdict, provenance, judgeRaw, judgeModelId, judgeUsage } = mentionResult;

  // ------------------------------------------------------------------
  // STEP 8 — runGates('measurement') — evidenceRequiredGate etc. (§7).
  // ------------------------------------------------------------------
  const mutableVerdict: GateContext["verdict"] = {
    brand_mentioned: verdict.brand_mentioned,
    brand_rank: verdict.brand_rank,
    sentiment: verdict.sentiment,
    competitors_found: verdict.competitors_found,
    evidence: verdict.evidence ?? null,
    provenance,
    guardrail_status: "pass",
  };

  const gateCtx: GateContext = {
    verdict: mutableVerdict,
    answerText,
    brandAliases: [brand.name, ...brand.aliases],
    runId,
    responseRawId,
  };

  const finalVerdict = runGates([...gates], "measurement", gateCtx);

  // ------------------------------------------------------------------
  // STEP 9 — insertJudgment (APPEND-ONLY; latest-judgment-wins via view).
  // ------------------------------------------------------------------
  await repo.insertJudgment({
    responseRawId,
    runId,
    customerId,
    questionId,
    modelId,
    language,
    responseStatus,
    brandMentioned: finalVerdict.brand_mentioned,
    brandRank: finalVerdict.brand_rank,
    sentiment: finalVerdict.sentiment,
    competitorsFound: finalVerdict.competitors_found,
    evidenceQuote: finalVerdict.evidence?.quote ?? null,
    evidenceStart: finalVerdict.evidence?.start ?? null,
    evidenceEnd: finalVerdict.evidence?.end ?? null,
    // Citation channel (MUST #2) — sourced from the raw verdict (gates downgrade
    // mention/evidence, never citation; the citation_hits view still requires a
    // gate-passed mention so a downgraded row never counts as a citation).
    citationPresent: verdict.citation_present ?? false,
    citationUrl: verdict.citation_url ?? null,
    citationQuote: verdict.citation_quote ?? null,
    // Recommendation channel (R1) — same rationale (recommendation_hits view
    // requires a gate-passed mention, so a downgraded row never counts).
    recommendationPresent: verdict.recommendation_present ?? false,
    recommendationQuote: verdict.recommendation_quote ?? null,
    provenance: finalVerdict.provenance,
    judgeModel: judgeModelId,
    judgeRaw,
    guardrailStatus: finalVerdict.guardrail_status,
  });

  // ------------------------------------------------------------------
  // STEP 10 — llm_call(judge) — record whenever a judge LLM call was attempted.
  //
  // judgeUsage is non-null whenever extractMention actually called the judge LLM
  // (even if parsing failed and provenance ended up as 'fallback' or 'abstain').
  // DESIGN §11: "every generation AND judge call writes a row" — skip only when
  // judgeUsage is null, which means no LLM call was made at all (judge not
  // configured / answerText empty / pure rule fallback with zero LLM calls).
  // ------------------------------------------------------------------
  if (judgeUsage !== null) {
    await ledger.recordJudge({
      customerId,
      runId,
      provider: judgeAdapter.provider,
      modelId: judgeModelId ?? judgeAdapter.provider, // modelId is non-null whenever usage is non-null
      inputTokens: judgeUsage.inputTokens,
      outputTokens: judgeUsage.outputTokens,
      usd: judgeUsage.usd,
      cacheHit: judgeUsage.cacheHit,
      responseRawId,
    });
  }

  // ------------------------------------------------------------------
  // STEP 11 — markWorkUnitDone (idempotent).
  // ------------------------------------------------------------------
  await repo.markWorkUnitDone(
    runId,
    questionId,
    modelId,
    language,
    sampleIdx,
    responseRawId
  );

  log.info(
    {
      runId,
      questionId,
      modelId,
      language,
      sampleIdx,
      responseStatus,
      provenance: finalVerdict.provenance,
      brandMentioned: finalVerdict.brand_mentioned,
      guardrailStatus: finalVerdict.guardrail_status,
    },
    "runResponse: work unit complete"
  );
}
