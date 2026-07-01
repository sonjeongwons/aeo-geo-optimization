/**
 * src/judge/judgeDebias.ts — Rogan-Gladen debiased visibility estimator (X11).
 *
 * The shipped Wilson CI (significance.ts), SMR (metrics/), and AC1/κ (reliability.ts)
 * modules all quantify SAMPLING or AGREEMENT uncertainty — but none corrects the
 * visibility POINT ESTIMATE for the judge's own Se/Sp error. A detector that misses
 * 20 % of real mentions and flags 5 % of non-mentions produces a systematically
 * biased observed positive rate. This module corrects that bias via the
 * Rogan-Gladen prevalence estimator, then propagates uncertainty from three
 * sources (observed sample size, Se uncertainty, Sp uncertainty) via the delta
 * method.
 *
 * DEFERRED DEPENDENCY: a `detector_calibration` table (columns: engine, prompt_hash,
 * se, sp, se_n, sp_n, calibrated_at) is required to populate se/sp/seN/spN from
 * ground-truth labelling. No migration is included here — create it when the
 * calibration pipeline is built. Until then callers may pass manually known values
 * or treat the result as indicative only (calibrated=false).
 *
 * References
 *   Rogan & Gladen (1978) AJE — prevalence bias correction arXiv:2601.05420
 *   LLM-as-judge sensitivity/specificity framing arXiv:2511.21140
 *   Measurement error in LLM evaluation arXiv:2502.10881
 *
 * PURE: no IO, no pg, no network — deterministic given the same inputs.
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface DebiasedRate {
  observedRate: number;
  /** Rogan-Gladen point estimate, clamped [0,1]; null when not identifiable. */
  correctedRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  /** (Se + Sp) > 1 — the detector is above chance and a correction is possible. */
  identifiable: boolean;
  /**
   * true only when identifiable AND nObs>=minN AND seN>=minCal AND spN>=minCal.
   * false whenever calibration sample sizes are unavailable or too small.
   */
  calibrated: boolean;
  /**
   * true when seN or spN was provided but below minCal — the Se/Sp point
   * estimates themselves carry high variance that is NOT yet captured in CI
   * (mirrors the lowPower flag pattern in significance.ts).
   */
  lowCalibration: boolean;
  /** Honest plain-English note; never claims a number this module did not compute. */
  note: string;
}

// ---------------------------------------------------------------------------
// Core Rogan-Gladen point estimator
// ---------------------------------------------------------------------------

/**
 * Rogan-Gladen corrected prevalence:
 *   p_true = (p_obs + Sp − 1) / (Se + Sp − 1)
 *
 * Returns null (not identifiable) when:
 *   - (Se + Sp) <= 1  (detector is non-informative or worse than chance)
 *   - se or sp is outside (0, 1]
 *   - pObs is outside [0, 1]
 *
 * Result is clamped to [0, 1].
 */
export function roganGladen(pObs: number, se: number, sp: number): number | null {
  if (
    !Number.isFinite(pObs) ||
    !Number.isFinite(se) ||
    !Number.isFinite(sp) ||
    pObs < 0 ||
    pObs > 1 ||
    se <= 0 ||
    se > 1 ||
    sp <= 0 ||
    sp > 1
  ) {
    return null;
  }
  const denom = se + sp - 1;
  if (denom <= 0) return null; // Se + Sp <= 1 — not identifiable
  const raw = (pObs + sp - 1) / denom;
  return Math.min(1, Math.max(0, raw));
}

// ---------------------------------------------------------------------------
// Full estimate with delta-method CI
// ---------------------------------------------------------------------------

export interface DebiasOpts {
  /** Calibration sample size used to measure Se (enables Var(Se) term). */
  seN?: number;
  /** Calibration sample size used to measure Sp (enables Var(Sp) term). */
  spN?: number;
  /** Normal quantile for CI width. Default 1.96 (95 %). */
  z?: number;
  /** Minimum observed sample size for calibrated=true. Default 30. */
  minN?: number;
  /** Minimum calibration items (seN and spN) for calibrated=true. Default 20. */
  minCal?: number;
}

/**
 * Full debiased visibility estimate with delta-method CI.
 *
 * @param pObs  Observed positive rate ∈ [0,1].
 * @param nObs  Number of observations pObs was computed from.
 * @param se    Detector sensitivity P(detect | truly positive) ∈ (0,1].
 * @param sp    Detector specificity P(not detect | truly negative) ∈ (0,1].
 * @param opts  Optional calibration sizes, z, minN, minCal.
 *
 * Delta-method variance:
 *   Var(p_true) ≈ [ Var(p_obs) + p_true² · Var(Se) + (1−p_true)² · Var(Sp) ]
 *                 / (Se + Sp − 1)²
 *
 * where
 *   Var(p_obs) = p_obs(1−p_obs) / nObs
 *   Var(Se)    = se(1−se) / seN   when seN provided, else 0 (se treated as known)
 *   Var(Sp)    = sp(1−sp) / spN   when spN provided, else 0 (sp treated as known)
 *
 * CI = correctedRate ± z · sqrt(Var), clamped to [0,1].
 */
/** Abramowitz-Stegun 7.1.26 erf approximation (|error| < 1.5e-7). PURE. */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
/** Two-sided normal confidence level for a z multiplier, as a percentage. */
function confidenceLevelPct(z: number): number {
  return Math.round((2 * normalCdf(z) - 1) * 1000) / 10;
}

export function debiasedVisibility(
  pObs: number,
  nObs: number,
  se: number,
  sp: number,
  opts?: DebiasOpts,
): DebiasedRate {
  const z = opts?.z ?? 1.96;
  const minN = opts?.minN ?? 30;
  const minCal = opts?.minCal ?? 20;
  const seN = opts?.seN;
  const spN = opts?.spN;

  const identifiable = Number.isFinite(se) && Number.isFinite(sp) && se > 0 && se <= 1 && sp > 0 && sp <= 1 && se + sp > 1;

  // lowCalibration: true when seN or spN was supplied but below minCal
  const seNProvided = seN !== undefined;
  const spNProvided = spN !== undefined;
  const lowCalibration =
    (seNProvided && seN! < minCal) || (spNProvided && spN! < minCal);

  if (!identifiable) {
    const notePlain =
      `Detector is non-informative (Se=${se}, Sp=${sp}): Se + Sp ≤ 1. ` +
      `The Rogan-Gladen correction is undefined — no debiased rate can be computed. ` +
      `Populate the detector_calibration table with ground-truth labels to obtain valid Se/Sp.`;
    return {
      observedRate: pObs,
      correctedRate: null,
      ciLow: null,
      ciHigh: null,
      identifiable: false,
      calibrated: false,
      lowCalibration,
      note: notePlain,
    };
  }

  const correctedRate = roganGladen(pObs, se, sp)!; // non-null when identifiable

  // Z3 (v7): with zero observations the delta-method variance collapses to a
  // zero-width CI from no data, which would fabricate certainty. Surface the
  // point estimate but report the CI as undefined (null), mirroring the
  // non-identifiable branch's null-CI contract.
  if (!(nObs > 0)) {
    return {
      observedRate: pObs,
      correctedRate,
      ciLow: null,
      ciHigh: null,
      identifiable: true,
      calibrated: false,
      lowCalibration,
      note:
        `Rogan-Gladen point estimate computed (${correctedRate.toFixed(4)}) but the CI is ` +
        `undefined: no observations (nObs=${nObs}). Provide observed data to obtain an interval.`,
    };
  }

  // Delta-method variance. Z4 (v7): the Wald variance p_obs(1−p_obs)/n is exactly
  // 0 at the boundary rates p_obs ∈ {0,1}, yielding a zero-width CI from real
  // data. Use the Agresti-Coull adjusted rate (matching the codebase's deliberate
  // preference for Wilson/score over Wald) so the variance stays positive at the
  // boundary. successes are recovered as round(p_obs·n) for the adjustment.
  const denom = se + sp - 1;
  const acN = nObs + 4;
  const acP = (pObs * nObs + 2) / acN;
  const varPobs = (acP * (1 - acP)) / acN;
  const varSe = seNProvided && seN! > 0 ? (se * (1 - se)) / seN! : 0;
  const varSp = spNProvided && spN! > 0 ? (sp * (1 - sp)) / spN! : 0;

  const varPtrue =
    (varPobs + correctedRate ** 2 * varSe + (1 - correctedRate) ** 2 * varSp) /
    denom ** 2;

  const halfWidth = z * Math.sqrt(varPtrue);
  const ciLow = Math.min(1, Math.max(0, correctedRate - halfWidth));
  const ciHigh = Math.min(1, Math.max(0, correctedRate + halfWidth));

  // calibrated: all three size requirements met
  const nOk = nObs >= minN;
  const seCalOk = seNProvided && seN! >= minCal;
  const spCalOk = spNProvided && spN! >= minCal;
  const calibrated = identifiable && nOk && seCalOk && spCalOk;

  // Build honest note
  const noteParts: string[] = [];
  if (!nOk) {
    noteParts.push(
      `observed sample too small (n=${nObs} < ${minN}) for a calibrated estimate`,
    );
  }
  if (!seCalOk) {
    noteParts.push(
      seNProvided
        ? `sensitivity calibration sample too small (seN=${seN!} < ${minCal})`
        : `sensitivity calibration sample size not provided (seN unknown)`,
    );
  }
  if (!spCalOk) {
    noteParts.push(
      spNProvided
        ? `specificity calibration sample too small (spN=${spN!} < ${minCal})`
        : `specificity calibration sample size not provided (spN unknown)`,
    );
  }

  let note: string;
  if (calibrated) {
    // Z6 (v7): derive the CI level from the caller-supplied z instead of
    // hardcoding "95 %", which mislabeled non-default z (e.g. z=2.576 ≈ 99%).
    const levelPct = confidenceLevelPct(z);
    note =
      `Rogan-Gladen debiased rate ${correctedRate.toFixed(4)} ` +
      `(${levelPct} % CI [${ciLow.toFixed(4)}, ${ciHigh.toFixed(4)}]). ` +
      `All sample-size requirements met (nObs=${nObs}, seN=${seN!}, spN=${spN!}).`;
  } else {
    note =
      `Rogan-Gladen point estimate computed (${correctedRate.toFixed(4)}) but NOT fully calibrated: ` +
      noteParts.join("; ") +
      ". Treat as indicative only until the detector_calibration table is populated.";
  }

  return {
    observedRate: pObs,
    correctedRate,
    ciLow,
    ciHigh,
    identifiable: true,
    calibrated,
    lowCalibration,
    note,
  };
}
