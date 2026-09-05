/**
 * LLM judge orchestration — DESIGN.md §5.4 "extractMention pipeline" STEP 1.
 *
 * Calls the provider's judge() method, Zod-validates the result, and escalates
 * to gemini-2.5-pro once on PARSE_FAILED.
 *
 * Escalation model IDs are constants here (not config) because they are woven
 * into the judge prompt via RANK_RULE_DOCSTRING in gemini.ts — changing them
 * is a code change. DESIGN §5.4 / §11 cost: "escalate to gemini-2.5-pro ONLY
 * on parse failure".
 *
 * No IO beyond the provider call; no pg imports.
 */

import type { ProviderAdapter, JudgeRequest, JudgeResult } from "../providers/types.js";
import { NOT_CONFIGURED } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Constants (DESIGN §5.4 model IDs)
// ---------------------------------------------------------------------------

/**
 * Default cheap judge model. Was "gemini-2.5-flash-lite" — Google deprecated
 * that pinned id for NEW Google Cloud projects/accounts (404 "no longer
 * available to new users"), which broke judging for any newly-added
 * GEMINI_API_KEYS rotation key. Switched to the "-latest" alias so this
 * tracks whatever the current lite-tier model is instead of pinning a
 * dated id that can be deprecated out from under new keys again.
 */
export const DEFAULT_JUDGE_MODEL = "gemini-flash-lite-latest";

/** Escalation judge model — used only on PARSE_FAILED. */
export const ESCALATION_JUDGE_MODEL = "gemini-2.5-pro";

// ---------------------------------------------------------------------------
// LlmJudgeRequest
// ---------------------------------------------------------------------------

export interface LlmJudgeRequest {
  /** The raw answer text to judge. */
  answerText: string;
  /** Canonical brand name. */
  brandName: string;
  /** All brand aliases (canonical name is included). */
  brandAliases: string[];
  /** All tracked competitors with their aliases. */
  competitors: Array<{ name: string; aliases: string[] }>;
  /**
   * Preferred model for judging. Defaults to DEFAULT_JUDGE_MODEL.
   * The adapter may internally choose a different model on escalation.
   */
  preferredModelId?: string;
  /**
   * Escalation model. Defaults to ESCALATION_JUDGE_MODEL.
   * The adapter tries this model once on PARSE_FAILED.
   */
  escalationModelId?: string;
}

// ---------------------------------------------------------------------------
// callLlmJudge
// ---------------------------------------------------------------------------

/**
 * Call the LLM judge via the provider adapter.
 *
 * DESIGN §5.4 STEP 1:
 *   - Call gemini.judge (FORCED JSON via responseSchema, temp 0).
 *   - Escalate to gemini-2.5-pro ONCE on PARSE_FAILED.
 *   - The adapter handles Zod validation internally; returns JudgeOk on success.
 *
 * This function does NOT throw. It returns the raw JudgeResult so the caller
 * (extractMention) can decide how to handle each failure mode.
 *
 * @param adapter  The provider adapter (must implement judge()).
 * @param req      The judge request parameters.
 * @returns        The raw JudgeResult from the adapter.
 */
export async function callLlmJudge(
  adapter: ProviderAdapter,
  req: LlmJudgeRequest
): Promise<JudgeResult> {
  const preferredModelId = req.preferredModelId ?? DEFAULT_JUDGE_MODEL;
  const escalationModelId = req.escalationModelId ?? ESCALATION_JUDGE_MODEL;

  const judgeRequest: JudgeRequest = {
    answerText: req.answerText,
    brandName: req.brandName,
    brandAliases: req.brandAliases,
    competitors: req.competitors,
    preferredModelId,
    escalationModelId,
  };

  // Delegate escalation logic to the adapter (GeminiAdapter handles PARSE_FAILED
  // → escalation internally per DESIGN §5.4). We pass both model IDs so the
  // adapter has everything it needs.
  return adapter.judge(judgeRequest);
}

// ---------------------------------------------------------------------------
// isJudgeConfigured
// ---------------------------------------------------------------------------

/**
 * Check whether the adapter can perform judging (not a stub / not missing key).
 */
export function isJudgeConfigured(adapter: ProviderAdapter): boolean {
  return (
    adapter.status === "ready" &&
    adapter.capabilities.includes("judge")
  );
}

// ---------------------------------------------------------------------------
// isNotConfigured
// ---------------------------------------------------------------------------

/**
 * Type guard: true when the result is NOT_CONFIGURED (no API key).
 */
export function isNotConfiguredResult(result: JudgeResult): boolean {
  return !result.ok && result.code === NOT_CONFIGURED;
}

// ---------------------------------------------------------------------------
// isParseFailed
// ---------------------------------------------------------------------------

/**
 * Type guard: true when the LLM returned something we couldn't parse.
 */
export function isParseFailedResult(result: JudgeResult): boolean {
  return !result.ok && "code" in result && result.code === "PARSE_FAILED";
}
