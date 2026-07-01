/**
 * src/judge/judgeReliability.ts — X12: certify the LLM judge against a human GOLD label set.
 *
 * PURPOSE
 * -------
 * The shipped inter-judge module (reliability.ts) measures agreement between TWO judge
 * engines on the same items. THIS module measures agreement between the SINGLE Gemini
 * judge's labels and a HUMAN GOLD label set, per task (e.g. "sentiment",
 * "recommendation_polarity", "claim_adjudication"). We treat gold as one rater and the
 * judge as the other, then run Gwet's AC1 between them.
 *
 * WHY AC1 AND NOT COHEN'S κ
 * -------------------------
 * Gold label sets for classification tasks are typically highly skewed — most items carry
 * the same label. Cohen's κ collapses toward 0 (or goes negative) under prevalence skew
 * even at very high observed agreement (the "prevalence paradox"). Gwet's AC1 uses a
 * prevalence-robust chance-agreement term (pe = 2·π̄·(1−π̄)) that stays well-calibrated
 * at high or low base rates, making it the appropriate coefficient wherever label
 * imbalance is expected. The `prevalence` field (gold positive rate) is surfaced in the
 * result precisely so consumers can see whether they are in a skewed regime.
 *
 * PREREQUISITE — HUMAN GOLD SET
 * ------------------------------
 * Certification requires a manually-curated, per-task human gold label set. Without it
 * `certifyJudge` returns status "not_measurable". The same prerequisite applies to the
 * shipped inter-judge AC1 (reliability.ts). The gold labels must be assembled offline and
 * passed in by the caller; this module is PURE (no IO, no network, no DB).
 *
 * PERSISTENCE DEFERRED
 * --------------------
 * Writing results to a `judge_reliability(task, ac1, n, prevalence, computed_at)` table
 * is deferred. The migration and DB write belong in the pipeline layer, not here.
 *
 * PURE — no IO, no pg, no network, deterministic.
 */

import { gwetAC1 } from "./reliability.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type JudgeTrustStatus = "ok" | "low_trust" | "not_measurable";

export interface JudgeReliability {
  /** Task identifier (e.g. "sentiment", "claim_adjudication"). */
  task: string;
  /**
   * Gwet's AC1 between judge labels and gold labels; null when not measurable
   * (n === 0 or n < minN). Even when n >= 1 but < minN, ac1 is still computed
   * and returned here for informational purposes — but status remains
   * "not_measurable" until n >= minN.
   *
   * Note: ac1 is set to null only when n === 0 (undefined). For 1 <= n < minN
   * we do compute it but keep status "not_measurable".
   */
  ac1: number | null;
  /** Number of paired (judge, gold) items actually used (min of both array lengths). */
  n: number;
  /**
   * Gold positive rate (mean of the first n gold booleans). Null when n === 0.
   * Surfaced because AC1 is prevalence-robust — this lets consumers confirm whether
   * they are in a skewed-label regime where Cohen's κ would be unstable.
   */
  prevalence: number | null;
  /**
   * Disclosed heuristic floor for AC1. Default 0.6, borrowed from the
   * agreement-coefficient literature (Gwet 2008; Krippendorff α floor ~0.5–0.8
   * depending on application). NOT validated on this specific data set or task.
   */
  threshold: number;
  status: JudgeTrustStatus;
  /** Honest plain-English note; never invents a number when not measurable. */
  note: string;
}

// ---------------------------------------------------------------------------
// certifyJudge
// ---------------------------------------------------------------------------

/**
 * Certify a single judge task against a human gold label set.
 *
 * @param task         Human-readable task name (used as an identifier in the result).
 * @param judgeLabels  Boolean labels emitted by the Gemini judge, one per item.
 * @param goldLabels   Boolean labels from the human gold set, one per item.
 * @param opts.minN    Minimum n before certification is considered reliable. Default 30.
 * @param opts.threshold
 *                     Disclosed AC1 floor below which the judge is low-trust. Default 0.6.
 *                     Borrowed from agreement-coefficient literature; not validated here.
 */
export function certifyJudge(
  task: string,
  judgeLabels: boolean[],
  goldLabels: boolean[],
  opts?: { minN?: number; threshold?: number },
): JudgeReliability {
  const minN = opts?.minN ?? 30;
  const threshold = opts?.threshold ?? 0.6;

  const n = Math.min(judgeLabels.length, goldLabels.length);

  // Prevalence: gold positive rate over the first n items.
  const prevalence: number | null =
    n === 0
      ? null
      : goldLabels.slice(0, n).filter(Boolean).length / n;

  // AC1: defined for n >= 1; null only when n === 0.
  const ac1: number | null =
    n === 0
      ? null
      : gwetAC1(judgeLabels.slice(0, n), goldLabels.slice(0, n)).value;

  // Status and note.
  if (n < minN) {
    const note =
      n === 0
        ? `No paired judge/gold items exist for task "${task}". A manually-curated human gold set (≥${minN} items) is required before the judge can be certified.`
        : `Too few paired items for task "${task}": ${n} available, ${minN} required. No certification can be issued until the human gold set reaches the minimum size.`;
    // Return the COMPUTED ac1 (null only at n===0, the coefficient for 1<=n<minN)
    // to honor the JSDoc contract + symmetry with prevalence (sweep v6 Y4).
    return { task, ac1, n, prevalence, threshold, status: "not_measurable", note };
  }

  // n >= minN: ac1 is non-null here (n >= 1 by implication).
  const ac1Value = ac1 as number;

  if (ac1Value < threshold) {
    return {
      task,
      ac1: ac1Value,
      n,
      prevalence,
      threshold,
      status: "low_trust",
      note: `Judge task "${task}" has low agreement with the human gold set (AC1=${ac1Value.toFixed(2)} < ${threshold}, a disclosed heuristic floor from the agreement-coefficient literature). Downstream consumers should treat this judge task as low-trust and avoid using its labels for automated decisions without human review.`,
    };
  }

  return {
    task,
    ac1: ac1Value,
    n,
    prevalence,
    threshold,
    status: "ok",
    note: `Judge task "${task}" meets the certification threshold (AC1=${ac1Value.toFixed(2)} ≥ ${threshold}).`,
  };
}

// ---------------------------------------------------------------------------
// certifyJudges
// ---------------------------------------------------------------------------

/**
 * Certify multiple judge tasks in one call. Preserves input order.
 *
 * @param sets  Array of { task, judgeLabels, goldLabels } objects.
 * @param opts  Shared options forwarded to certifyJudge for every task.
 */
export function certifyJudges(
  sets: Array<{ task: string; judgeLabels: boolean[]; goldLabels: boolean[] }>,
  opts?: { minN?: number; threshold?: number },
): JudgeReliability[] {
  return sets.map(({ task, judgeLabels, goldLabels }) =>
    certifyJudge(task, judgeLabels, goldLabels, opts),
  );
}
