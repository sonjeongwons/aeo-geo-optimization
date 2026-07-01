/**
 * Google AI Mode — SERP parser (W2).
 *
 * Google AI Mode is a DISTINCT answer surface from AI Overviews: independent
 * research reports a low cited-URL overlap (~<14%) between the two, so they must
 * be measured as SEPARATE surfaceIds and NEVER re-pooled. This parser tags its
 * output with surfaceId "googleAiMode" so every downstream metric (citation
 * share, PAWC, earned-source) keys the two engines apart.
 *
 * FORWARD-COMPATIBILITY: the official AI Mode SERP API response shape is not yet
 * published. We assume the AI Mode block (`ai_mode` / `aiMode`) shares the proven
 * AI Overview text_blocks/references shape and DELEGATE to the already-tested
 * `aiOverviewParser` after remapping the field — DRY, and the assumption is
 * revisited when the surface is armed. If AI Mode's real shape differs, only this
 * remap changes.
 *
 * Contract (mirrors aiOverviewParser): NEVER throws; NO_ANSWER when no AI Mode
 * block is present; prose-only answerText with citations kept separate.
 *
 * Pure module — no pg, no @google/genai, no network.
 */

import { aiOverviewParser } from "./aiOverviewParser.js";
import { NO_ANSWER } from "../../types.js";
import type { ParseResult, SurfaceParser } from "../../types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class AiModeParser implements SurfaceParser<unknown> {
  readonly surfaceId = "googleAiMode" as const;

  parse(raw: unknown): ParseResult {
    if (!isRecord(raw)) {
      return {
        ok: false,
        code: "SCHEMA_ERROR",
        message: "aiModeParser: raw input is not a JSON object",
        rawFragment: raw,
      };
    }

    const aiMode = raw["ai_mode"] ?? raw["aiMode"];
    if (aiMode === undefined) {
      return {
        ok: false,
        code: NO_ANSWER,
        reason: "No AI Mode block in SERP API response (query did not trigger AI Mode)",
      };
    }

    // Remap ai_mode → ai_overview and delegate to the proven parser, then re-tag
    // the surfaceId + restore the ORIGINAL raw input on the answer.
    const result = aiOverviewParser.parse({ ai_overview: aiMode });
    if (result.ok) {
      return {
        ok: true,
        answer: { ...result.answer, surfaceId: this.surfaceId, rawInput: raw },
      };
    }
    return result;
  }
}

/** Shared parser instance — stateless, safe to reuse across calls. */
export const aiModeParser = new AiModeParser();
