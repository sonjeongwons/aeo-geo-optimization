/**
 * extractMention — DESIGN.md §5.4 "extractMention pipeline".
 *
 * Orchestrates the four-step judge pipeline for one (response_raw, brand):
 *
 *   STEP 1  LLM-as-judge via gemini (FORCED JSON, temp 0; escalate to pro on PARSE_FAILED).
 *   STEP 2  Evidence verification — alias/NFC-normalized locating of the brand span.
 *           brand_mentioned=true but no locatable span → ungrounded → fall through.
 *   STEP 3  Rule fallback (deterministic NFC+lower+diacritic-fold; rank via domain/rank.ts).
 *   STEP 4  Abstain (counts in N_total, never as a hit; provenance='abstain').
 *
 * Re-judging appends a new row (caller persists); metrics read current_judgment (latest).
 *
 * DESIGN §7: evidenceRequiredGate is the GUARDRAIL layer applied AFTER extractMention
 * returns. extractMention itself follows the same logic internally (Step 2 → fall through
 * when ungrounded), providing defense-in-depth.
 *
 * Returns an ExtractMentionResult — no throws on bad judge output.
 */

import type { ProviderAdapter, AdapterUsage } from "../providers/types.js";
import type { JudgeVerdict } from "../domain/mention.schema.js";
import type { Provenance } from "../domain/types.js";
import { callLlmJudge, isJudgeConfigured } from "./llmJudge.js";
import { locateEvidenceForVerification } from "./evidence.js";
import { ruleFallback } from "./ruleFallback.js";
import { detectCitation } from "./citation.js";
import { detectRecommendation } from "./recommendation.js";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface ExtractMentionRequest {
  /** Raw answer text from the provider. Null means the generation failed. */
  answerText: string | null;
  /** Canonical brand name. */
  brandName: string;
  /** All brand aliases (canonical name should be included). */
  brandAliases: string[];
  /** All tracked competitors with their aliases. */
  competitors: Array<{ name: string; aliases: string[] }>;
  /**
   * The judge adapter. Typically the Gemini adapter.
   * If the adapter is NOT_CONFIGURED or a stub, we skip directly to rule fallback.
   */
  judgeAdapter: ProviderAdapter;
  /**
   * Preferred model for judging (cheap model, e.g. "gemini-2.5-flash-lite").
   * Optional; defaults to llmJudge.DEFAULT_JUDGE_MODEL.
   */
  preferredJudgeModelId?: string;
  /**
   * Escalation model (pro, e.g. "gemini-2.5-pro").
   * Optional; defaults to llmJudge.ESCALATION_JUDGE_MODEL.
   */
  escalationJudgeModelId?: string;
}

/**
 * Everything the pipeline needs to insert mention_judgment + llm_call(judge).
 * Carries judge_raw, judge_model, usage, and provenance so the repo/ledger
 * layer can record them without needing to understand the judge internals.
 */
export interface ExtractMentionResult {
  verdict: JudgeVerdict;
  provenance: Provenance;
  /** The raw JSON returned by the LLM judge (null when provenance='fallback'|'abstain'). */
  judgeRaw: unknown | null;
  /**
   * Model ID actually used for judging.
   * The cheap model on success, the pro model on escalation.
   * Non-null whenever a judge LLM call was actually attempted (even on parse failure).
   * Null only when no LLM call was made (judge not configured / answerText empty /
   * pure rule fallback with zero LLM calls).
   */
  judgeModelId: string | null;
  /**
   * Usage for the judge call.
   * Non-null whenever a judge LLM call was actually attempted (even on parse failure),
   * so the cost ledger can record real spend regardless of whether parsing succeeded.
   * Null only when no LLM call was made.
   */
  judgeUsage: AdapterUsage | null;
}

// ---------------------------------------------------------------------------
// extractMention
// ---------------------------------------------------------------------------

/**
 * Run the full four-step mention extraction pipeline.
 *
 * Never throws. All failure modes result in a graceful fallback or abstain.
 */
export async function extractMention(
  req: ExtractMentionRequest
): Promise<ExtractMentionResult> {
  const {
    answerText,
    brandName,
    brandAliases,
    competitors,
    judgeAdapter,
    preferredJudgeModelId,
    escalationJudgeModelId,
  } = req;

  // Canonical alias list (deduped, canonical name included).
  const allBrandAliases = [brandName, ...brandAliases].filter(
    (v, i, a) => a.indexOf(v) === i
  );

  // ------------------------------------------------------------------
  // If answerText is null/empty, skip straight to abstain.
  // The generation failed; there is nothing to judge.
  // ------------------------------------------------------------------
  if (!answerText || answerText.trim() === "") {
    return _abstain();
  }

  // ------------------------------------------------------------------
  // STEP 1 — LLM-as-judge
  // ------------------------------------------------------------------
  // Track usage/modelId from any attempted judge call so spend is always
  // propagated to the caller even when parsing fails (§11 budget ledger).
  let failedJudgeUsage: AdapterUsage | null = null;
  let failedJudgeModelId: string | null = null;

  if (isJudgeConfigured(judgeAdapter)) {
    const judgeResult = await callLlmJudge(judgeAdapter, {
      answerText,
      brandName,
      brandAliases: allBrandAliases,
      competitors,
      ...(preferredJudgeModelId !== undefined ? { preferredModelId: preferredJudgeModelId } : {}),
      ...(escalationJudgeModelId !== undefined ? { escalationModelId: escalationJudgeModelId } : {}),
    });

    if (judgeResult.ok) {
      const verdict = judgeResult.verdict;
      const usage = judgeResult.usage;
      const judgeModelId = judgeResult.modelId;
      const judgeRaw = judgeResult.raw;

      // STEP 2 — Evidence verification
      if (verdict.brand_mentioned) {
        const verifiedSpan = locateEvidenceForVerification(
          answerText,
          allBrandAliases,
          verdict.evidence?.quote ?? null,
          verdict.evidence?.start ?? null,
          verdict.evidence?.end ?? null
        );

        if (verifiedSpan !== null) {
          // Citation verification/recovery (MUST #2): a citation is deterministically
          // checkable (an actual link/attribution), so don't trust the LLM's
          // self-report alone — OR it with a deterministic scan. This both RECOVERS
          // citations the model missed and keeps citation_url/quote grounded.
          const detCite = detectCitation(answerText, allBrandAliases);
          const citationPresent = (verdict.citation_present ?? false) || detCite.present;
          // Recommendation channel (R1): OR the LLM self-report with a
          // deterministic scan (recovers recommendations the model missed).
          const detReco = detectRecommendation(answerText, allBrandAliases);
          const recommendationPresent = (verdict.recommendation_present ?? false) || detReco.present;

          // Evidence verified — return judge verdict with verified span.
          const verifiedVerdict: JudgeVerdict = {
            ...verdict,
            evidence: {
              quote: verifiedSpan.quote,
              start: verifiedSpan.start,
              end: verifiedSpan.end,
            },
            citation_present: citationPresent,
            citation_url: verdict.citation_url ?? detCite.url,
            citation_quote: verdict.citation_quote ?? detCite.quote,
            recommendation_present: recommendationPresent,
            recommendation_quote: verdict.recommendation_quote ?? detReco.quote,
          };
          return {
            verdict: verifiedVerdict,
            provenance: "judge",
            judgeRaw,
            judgeModelId,
            judgeUsage: usage,
          };
        }

        // brand_mentioned=true but no locatable span — ungrounded.
        // Fall through to rule fallback (STEP 3).
        // The evidenceRequiredGate (STEP upstream in pipeline) will also catch this,
        // but we already fall through here for defense-in-depth.
        //
        // Preserve usage so the failed/ungrounded judge call is still ledgered.
        failedJudgeUsage = usage;
        failedJudgeModelId = judgeModelId;
      } else {
        // brand_mentioned=false: no evidence needed; verdict is valid as-is.
        return {
          verdict,
          provenance: "judge",
          judgeRaw,
          judgeModelId,
          judgeUsage: usage,
        };
      }
    } else {
      // judgeResult.ok === false:
      //   - NOT_CONFIGURED: no key → no real call was made; skip usage capture
      //   - PARSE_FAILED: even after escalation → real call(s) made; capture spend
      //   - RATE_LIMITED / TIMEOUT / PROVIDER_ERROR → may have partial spend; capture
      // Capture usage from any result variant that carries it (PARSE_FAILED, some errors).
      if (judgeResult.code !== "NOT_CONFIGURED") {
        const errWithUsage = judgeResult as { usage?: AdapterUsage; modelId?: string };
        if (errWithUsage.usage !== undefined) {
          failedJudgeUsage = errWithUsage.usage;
        }
        if (errWithUsage.modelId !== undefined) {
          failedJudgeModelId = errWithUsage.modelId;
        }
      }
      // Fall through to STEP 3 in all error cases.
    }
  }
  // Judge not configured (stub / no key) → fall through to STEP 3.

  // ------------------------------------------------------------------
  // STEP 3 — Rule fallback
  // ------------------------------------------------------------------
  const fbResult = ruleFallback({
    answerText,
    brandName,
    brandAliases: allBrandAliases,
    competitors,
  });

  const fbVerdict = fbResult.verdict;

  // If fallback finds brand but cannot locate evidence, fall through to STEP 4.
  if (fbVerdict.brand_mentioned && fbVerdict.evidence === null) {
    // Still propagate any real judge spend captured above (§11: every LLM call is ledgered).
    return _abstain(failedJudgeUsage, failedJudgeModelId);
  }

  // Propagate any real judge spend captured above (§11: every LLM call is ledgered).
  return {
    verdict: fbVerdict,
    provenance: "fallback",
    judgeRaw: null,
    judgeModelId: failedJudgeModelId,
    judgeUsage: failedJudgeUsage,
  };
}

// ---------------------------------------------------------------------------
// STEP 4 — Abstain
// ---------------------------------------------------------------------------

function _abstain(
  judgeUsage: AdapterUsage | null = null,
  judgeModelId: string | null = null
): ExtractMentionResult {
  // Abstain: brand_mentioned=false, no sentiment, no evidence.
  // Counted in N_total but NOT as a hit.
  // judgeUsage/judgeModelId are non-null when a judge call was attempted before
  // landing here, ensuring spend is ledgered even on abstain (§11).
  const abstainVerdict: JudgeVerdict = {
    brand_mentioned: false,
    brand_rank: null,
    sentiment: null,
    competitors_found: [],
    evidence: null,
  };

  return {
    verdict: abstainVerdict,
    provenance: "abstain",
    judgeRaw: null,
    judgeModelId,
    judgeUsage,
  };
}

// ---------------------------------------------------------------------------
// extractMentionForStoredResponse
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper that takes the response_status into account.
 *
 * When the generation status is 'not_configured' | 'error' | 'cached' (with
 * no answer text), we skip the full pipeline and return abstain immediately.
 * This prevents unnecessary LLM judge calls for failed responses.
 *
 * @param responseStatus  The status from response_raw.
 * @param answerText      The answer text (null if generation failed).
 * @param rest            The remaining ExtractMentionRequest fields.
 */
export async function extractMentionForStoredResponse(
  responseStatus: "ok" | "not_configured" | "error" | "cached",
  req: ExtractMentionRequest
): Promise<ExtractMentionResult> {
  // For non-ok responses with no answer text, abstain immediately.
  if (responseStatus !== "ok" && !req.answerText) {
    return _abstain();
  }
  return extractMention(req);
}
