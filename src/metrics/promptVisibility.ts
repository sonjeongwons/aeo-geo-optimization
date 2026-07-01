/**
 * src/metrics/promptVisibility.ts — PURE tallies for SOTA sweep proposals C + D.
 *
 * Kept DB-free (imports only the pure metrics.types layer) so the tally logic —
 * per-cell rates, the citation⊆mention filter, Wilson CIs, lowPower thresholds —
 * is unit-testable without loading pg. aggregate.ts wraps these with the DB reads
 * (countWorkUnitsBySlice + fetchJudgments) and re-exports them.
 */

import { wilsonInterval } from "../domain/metrics.types.js";
import type { CitationByModel, PerPromptVisibility } from "../domain/metrics.types.js";
import { partialPool } from "./pooling.js";

/**
 * Minimal structural view of a judgment row used by the pure tally helpers.
 * (Subset of CurrentJudgmentRow — keeps the helpers DB-free + unit-testable.)
 */
export interface TallyJudgment {
  model_id: string;
  language: string;
  question_id: string;
  brand_mentioned: boolean;
  citation_present?: boolean | null;
  guardrail_status: string;
  response_raw_id: string;
}

export interface WorkUnitSlice {
  model_id: string;
  language: string;
  question_id: string;
  count: number;
}

/**
 * PURE tally for proposal D — per-engine citation share.
 *
 * citationHits(model) counts citation_present ∧ brand_mentioned ∧ pass; the
 * denominator is the frozen work_unit count for the model (same as the SMR
 * byModel slice). Wilson CI + lowPower (sliceTotal < 100) per engine.
 */
export function tallyCitationShareByModel(
  wuSlices: WorkUnitSlice[],
  judgments: TallyJudgment[],
): CitationByModel[] {
  const modelDenomMap = new Map<string, number>();
  for (const s of wuSlices) {
    modelDenomMap.set(s.model_id, (modelDenomMap.get(s.model_id) ?? 0) + s.count);
  }

  const hitsMap = new Map<string, { hits: number; evidenceRefs: Set<string> }>();
  for (const modelId of modelDenomMap.keys()) {
    hitsMap.set(modelId, { hits: 0, evidenceRefs: new Set() });
  }
  for (const j of judgments) {
    const isCitation =
      j.citation_present === true &&
      j.brand_mentioned &&
      j.guardrail_status === "pass";
    if (!isCitation) continue;
    if (!hitsMap.has(j.model_id)) hitsMap.set(j.model_id, { hits: 0, evidenceRefs: new Set() });
    const e = hitsMap.get(j.model_id)!;
    e.hits++;
    e.evidenceRefs.add(j.response_raw_id);
  }

  return Array.from(modelDenomMap.entries()).map(([modelId, sliceTotal]) => {
    const e = hitsMap.get(modelId) ?? { hits: 0, evidenceRefs: new Set<string>() };
    return {
      modelId,
      citationShare: sliceTotal > 0 ? e.hits / sliceTotal : 0,
      citationHits: e.hits,
      sliceTotal,
      ci95: wilsonInterval(e.hits, sliceTotal),
      lowPower: sliceTotal < 100,
      evidenceRefs: Array.from(e.evidenceRefs),
    };
  });
}

/**
 * PURE tally for proposal C — per-prompt mention rate with Wilson CI.
 *
 * One row per (question, model, language) cell. nSamples = frozen work_unit
 * count; brandHits = gate-passed mentions in the cell. lowPower flags
 * nSamples < 30. The interval is strictly NOISIER than the run-level SMR CI.
 */
export function tallyPerPromptVisibility(
  wuSlices: WorkUnitSlice[],
  judgments: TallyJudgment[],
): PerPromptVisibility[] {
  const key = (q: string, m: string, l: string) => `${q} ${m} ${l}`;
  const hitMap = new Map<string, { hits: number; evidenceRefs: Set<string> }>();
  for (const j of judgments) {
    if (!(j.brand_mentioned && j.guardrail_status === "pass")) continue;
    const k = key(j.question_id, j.model_id, j.language);
    if (!hitMap.has(k)) hitMap.set(k, { hits: 0, evidenceRefs: new Set() });
    const e = hitMap.get(k)!;
    e.hits++;
    e.evidenceRefs.add(j.response_raw_id);
  }

  // Grand mean across all cells (run-level mention rate) to shrink toward (R3).
  let grandHits = 0;
  let grandN = 0;
  for (const s of wuSlices) {
    const e = hitMap.get(key(s.question_id, s.model_id, s.language));
    grandHits += e?.hits ?? 0;
    grandN += s.count;
  }
  const grandRate = grandN > 0 ? grandHits / grandN : 0;

  return wuSlices.map((s) => {
    const k = key(s.question_id, s.model_id, s.language);
    const e = hitMap.get(k) ?? { hits: 0, evidenceRefs: new Set<string>() };
    const nSamples = s.count;
    // Partial pooling (R3) — separate labeled fields; raw rate + lowPower stay
    // keyed off the raw cell n.
    const pooled = partialPool(e.hits, nSamples, grandRate);
    return {
      questionId: s.question_id,
      modelId: s.model_id,
      language: s.language,
      mentionRate: nSamples > 0 ? e.hits / nSamples : 0,
      brandHits: e.hits,
      nSamples,
      ci95: wilsonInterval(e.hits, nSamples),
      lowPower: nSamples < 30,
      evidenceRefs: Array.from(e.evidenceRefs),
      pooledRate: pooled.pooledRate,
      pooledCi95: pooled.pooledCi95,
    };
  });
}
