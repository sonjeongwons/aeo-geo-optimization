/**
 * Rule-based fallback judge — DESIGN.md §5.4 "extractMention pipeline" STEP 3.
 *
 * Deterministic, alias-normalized string/order matching using domain/rank.ts.
 * Used when the LLM judge fails (parse error, NOT_CONFIGURED, network error)
 * or when the judge's evidence cannot be verified.
 *
 * Contract (DESIGN §5.4):
 *   - Uses computeAllRanks from domain/rank.ts (brand_rank matches computeRank).
 *   - sentiment='neutral' always (never fabricated).
 *   - Real evidence window via evidence.ts locateEvidence.
 *   - provenance='fallback'.
 *
 * Pure (aside from imports) — no IO, no @google/genai.
 */

import {
  computeAllRanks,
  findFirstOffset,
  type RankedEntity,
} from "../domain/rank.js";
import type { JudgeVerdict } from "../domain/mention.schema.js";
import { locateEvidence } from "./evidence.js";
import { detectCitation } from "./citation.js";
import { detectRecommendation } from "./recommendation.js";

// ---------------------------------------------------------------------------
// RuleFallbackRequest
// ---------------------------------------------------------------------------

export interface RuleFallbackRequest {
  /** The raw answer text from the provider. */
  answerText: string | null;
  /** Canonical brand name. */
  brandName: string;
  /** All brand name variants (canonical + aliases). */
  brandAliases: string[];
  /** All tracked competitors with their aliases. */
  competitors: Array<{ name: string; aliases: string[] }>;
}

// ---------------------------------------------------------------------------
// RuleFallbackResult
// ---------------------------------------------------------------------------

export interface RuleFallbackResult {
  /** The extracted verdict (matches JudgeVerdict shape). */
  verdict: JudgeVerdict;
}

// ---------------------------------------------------------------------------
// ruleFallback
// ---------------------------------------------------------------------------

/**
 * Deterministic rule-based mention extraction.
 *
 * Steps:
 *   1. If answerText is null/empty → brand_mentioned=false, brand_rank=null.
 *   2. Build the full entity list (brand + competitors) as RankedEntity[].
 *   3. Call computeAllRanks to get 1-based ranks for all found entities.
 *   4. Determine brand_mentioned from whether any brand alias appears.
 *   5. If brand_mentioned, locate an evidence span using evidence.ts.
 *   6. For each competitor, record name + rank (null if absent).
 *   7. sentiment='neutral' always (never fabricated by rule fallback).
 */
export function ruleFallback(req: RuleFallbackRequest): RuleFallbackResult {
  const { answerText, brandName, brandAliases, competitors } = req;

  // Null / empty text → not mentioned.
  // Emit empty competitors_found (no text ⇒ no entities found) — matches the
  // Gemini judge contract which only emits competitors actually present.
  if (!answerText || answerText.trim() === "") {
    return {
      verdict: {
        brand_mentioned: false,
        brand_rank: null,
        sentiment: null,
        competitors_found: [],
        evidence: null,
        citation_present: false,
        citation_url: null,
        citation_quote: null,
      },
    };
  }

  // Build entity list: brand first, then competitors.
  const brandEntity: RankedEntity = {
    name: brandName,
    aliases: [brandName, ...brandAliases].filter((v, i, a) => a.indexOf(v) === i),
  };

  const competitorEntities: RankedEntity[] = competitors.map((c) => ({
    name: c.name,
    aliases: [c.name, ...c.aliases].filter((v, i, a) => a.indexOf(v) === i),
  }));

  const allEntities: RankedEntity[] = [brandEntity, ...competitorEntities];

  // Compute all ranks in a single pass via domain/rank.ts.
  const rankMap = computeAllRanks(answerText, allEntities);

  // Brand detection: check if brand or any alias appears.
  const allBrandAliases = brandEntity.aliases;
  const brandOffset = findFirstOffset(answerText, allBrandAliases);
  const brand_mentioned = brandOffset !== null;
  const brand_rank = rankMap.get(brandName) ?? null;

  // Evidence span.
  let evidence: JudgeVerdict["evidence"] = null;
  if (brand_mentioned) {
    const span = locateEvidence(answerText, allBrandAliases);
    if (span !== null) {
      evidence = {
        quote: span.quote,
        start: span.start,
        end: span.end,
      };
    }
    // If locateEvidence returns null despite brand being found (shouldn't happen),
    // we still have brand_mentioned=true but evidence=null.
    // This is handled by the evidenceRequiredGate (downgraded to abstain).
  }

  // Competitors — emit ONLY those with a non-null rank (i.e. actually found).
  // This matches the Gemini judge contract (competitors_found contains only
  // entities present in the answer).  rank===null means absent, and absent
  // competitors must NOT be counted toward SoV or Priority Gap.
  const competitors_found = competitors
    .map((c) => ({ name: c.name, rank: rankMap.get(c.name) ?? null }))
    .filter((c): c is { name: string; rank: number } => c.rank !== null);

  // Citation channel (MUST #2): a citation requires an actual link/attribution
  // carrying a brand alias AND the brand to be mentioned (citation ⊆ mention).
  const cite = brand_mentioned
    ? detectCitation(answerText, allBrandAliases)
    : { present: false, url: null, quote: null };

  // Recommendation channel (R1): an affirmative advice construct naming the brand
  // (recommendation ⊆ mention).
  const reco = brand_mentioned
    ? detectRecommendation(answerText, allBrandAliases)
    : { present: false, quote: null };

  return {
    verdict: {
      brand_mentioned,
      brand_rank: brand_mentioned ? brand_rank : null,
      sentiment: brand_mentioned ? "neutral" : null,
      competitors_found,
      evidence,
      citation_present: cite.present,
      citation_url: cite.url,
      citation_quote: cite.quote,
      recommendation_present: reco.present,
      recommendation_quote: reco.quote,
    },
  };
}
