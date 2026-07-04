/**
 * src/content/gates/geoReadiness.ts — GEO-readiness ADVISORY signal (SOTA sweep H).
 *
 * Scores pre-deploy "content-readiness / indexing hygiene" pillars that exist on
 * the ContentAsset itself (GEO-16 framework, arXiv 2509.10762 — structure, FAQ
 * shape, claim/source binding density, JSON-LD presence correlate with citation
 * odds). It produces a 0–1 score per asset.
 *
 * IMPORTANT — this is ADVISORY, NOT a deploy block:
 *   • It ALWAYS returns "pass". The score + any missing pillars are recorded in
 *     the gate_report reason for ops/dashboard visibility only. Enforcement
 *     (routing low-readiness assets to needs_human) is DEFERRED until the
 *     threshold is calibrated on real EMORA data — the external G≥0.70 cutoff is
 *     borrowed from a paper, not validated here, and hard-blocking on an
 *     uncalibrated threshold would overstate certainty and needlessly cut yield.
 *   • §7 honesty: this is an internal indexing-hygiene indicator. It is NOT a
 *     predicted citation outcome and carries NO citation-lift number. It does
 *     NOT score semantic HTML / freshness / slug (those don't exist pre-deploy —
 *     they're stamped by the Phase-3 deploy renderer).
 *
 * PURE: no I/O, no LLM, no network.
 */

import type {
  ContentAsset,
  ContentGateContext,
  ContentGateResult,
} from "../types.js";
import { getCharBand, ANSWER_BLOCK_MAX_WORDS } from "../wordCount.js";

export interface ReadinessPillar {
  key: string;
  ok: boolean;
}

export interface GeoReadinessScore {
  /** Fraction of applicable pillars met, in [0,1]. */
  score: number;
  pillars: ReadinessPillar[];
  /** Keys of the pillars not met. */
  missing: string[];
  /**
   * Disclosed heuristic floor below which an asset WOULD be flagged for human
   * review once enforcement is enabled. NOT currently enforced.
   */
  advisoryThreshold: number;
}

const ADVISORY_THRESHOLD = 0.5;

/**
 * Answer-block self-contained length FLOOR (length_units). Below this a passage
 * is too thin to be a liftable answer. This is a LENIENT advisory floor (looser
 * than the enforced §6 band's lower bound); the UPPER bound is derived per-script
 * from the SAME band wordCount.ts enforces (getCharBand for CJK, else the word
 * band) so a valid answer_block the pipeline forced into that band NEVER fails
 * this advisory pillar (W6.3 — the old hardcoded 320 contradicted the ko band
 * of up to 501 chars).
 */
const ANSWER_MIN_UNITS = 40;

/** Per-script upper length bound, matching the enforced wordCount band. */
function answerMaxUnits(language: string): number {
  const band = getCharBand(language);
  return band ? band.maxChars : ANSWER_BLOCK_MAX_WORDS;
}

/**
 * Score the GEO-readiness pillars present on a pre-deploy ContentAsset.
 * PURE. Score = met pillars / applicable pillars (1 when no pillars apply).
 */
export function scoreGeoReadiness(asset: ContentAsset): GeoReadinessScore {
  const body = asset.body;
  const pillars: ReadinessPillar[] = [];

  switch (body.content_type) {
    case "definition": {
      pillars.push({ key: "has_meaning_key", ok: !!body.meaning_key && body.meaning_key.trim().length > 0 });
      pillars.push({ key: "definition_text_present", ok: body.text.trim().length >= 40 });
      break;
    }
    case "answer_block": {
      pillars.push({
        key: "answer_length_band",
        ok: body.length_units >= ANSWER_MIN_UNITS && body.length_units <= answerMaxUnits(asset.language),
      });
      pillars.push({
        key: "evidence_binding",
        ok: body.source_ids.length > 0 || body.numeric_claim_ids.length > 0,
      });
      break;
    }
    case "faq": {
      pillars.push({ key: "faq_row_band", ok: body.rows.length >= 3 && body.rows.length <= 8 });
      pillars.push({
        key: "faq_answer_binding",
        ok: body.rows.some((r) => r.answer_claim_ids.length > 0),
      });
      break;
    }
    case "comparison": {
      pillars.push({ key: "comparison_columns", ok: body.columns.length >= 2 });
      pillars.push({ key: "comparison_rows", ok: body.rows.length >= 1 });
      pillars.push({
        key: "comparison_cell_evidence",
        ok: body.rows.some((row) => row.cells.some((c) => c.claim_id != null)),
      });
      break;
    }
    case "case_study": {
      pillars.push({
        key: "case_study_complete",
        ok:
          body.situation.trim().length > 0 &&
          body.action.trim().length > 0 &&
          body.result.trim().length > 0,
      });
      pillars.push({ key: "case_study_metric", ok: body.metrics.length > 0 });
      break;
    }
    case "jsonld": {
      pillars.push({ key: "jsonld_schema_type", ok: !!body.schema_type });
      break;
    }
    default:
      break;
  }

  const total = pillars.length;
  const met = pillars.filter((p) => p.ok).length;
  const score = total > 0 ? met / total : 1;
  const missing = pillars.filter((p) => !p.ok).map((p) => p.key);

  return { score, pillars, missing, advisoryThreshold: ADVISORY_THRESHOLD };
}

export const geoReadinessGate = {
  name: "geoReadinessGate",
  phase: "content" as const,

  apply(ctx: ContentGateContext): ContentGateResult {
    const r = scoreGeoReadiness(ctx.asset);
    // ADVISORY: always pass; surface the readiness score + deficits in the
    // gate_report reason. (Enforcement deferred until calibration.)
    const pct = Math.round(r.score * 100);
    const reason =
      r.missing.length > 0
        ? `content-readiness ${pct}% (indexing hygiene, advisory) — missing: ${r.missing.join(", ")}`
        : `content-readiness ${pct}% (indexing hygiene, advisory)`;
    return { action: "pass", gate: "geoReadinessGate", reason };
  },
};
