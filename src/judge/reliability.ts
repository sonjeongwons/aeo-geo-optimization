/**
 * src/judge/reliability.ts — judge reliability instrumentation (SOTA sweep E).
 *
 * The engine's SMR is produced by a single Gemini self-judge; the measurement
 * disclosure already admits the self-bias. This module makes that bias
 * MEASURABLE rather than merely confessed:
 *
 *   1. cohenKappa — inter-judge agreement on brand_mentioned, ONCE a 2nd
 *      JUDGE_PROVIDER exists. Until then the harness reports "not_measurable",
 *      NEVER a fabricated κ (honesty: single-engine agreement is undefined).
 *   2. signedBiasScore — b = P(prefers brand) − P(prefers competitor) on
 *      constructed tie pairs; >0 means the judge leans toward the brand.
 *   3. positionSwapConsistency — fraction of items whose brand-vs-competitor
 *      ordering is STABLE when the presentation order is swapped (position bias).
 *   4. classifyAgreement — maps κ to a measurement-quality gate: WARN at
 *      κ < 0.5 (a DISCLOSED heuristic floor from the attribution-agreement
 *      literature, NOT a guarantee).
 *
 * 'Judging the Judges' (arXiv 2604.23178 — signed bias, κ; 2406.07791 —
 * position consistency via swap-and-rejudge). Krippendorff α ~0.5 floor
 * (encord.com). The extra judge calls the live harness makes MUST be
 * budget-ledgered (§11) by the caller — this module is PURE (stats only).
 */

// ---------------------------------------------------------------------------
// Cohen's kappa — inter-rater agreement on a binary label
// ---------------------------------------------------------------------------

export interface KappaResult {
  /** Cohen's κ in [-1,1], or null when undefined (n=0). */
  kappa: number | null;
  observedAgreement: number;
  expectedAgreement: number;
  n: number;
}

/**
 * Cohen's κ for two raters' binary labels (e.g. brand_mentioned by judge A vs B).
 * labelsA[i] and labelsB[i] are the two judges' verdicts on the same item i.
 *
 * PURE. Returns kappa=null when n=0. When the two raters agree on everything AND
 * there is no variance (pe=1), κ is defined as 1 if they fully agree else 0.
 */
export function cohenKappa(labelsA: boolean[], labelsB: boolean[]): KappaResult {
  const n = Math.min(labelsA.length, labelsB.length);
  if (n === 0) return { kappa: null, observedAgreement: 0, expectedAgreement: 0, n: 0 };

  let agree = 0;
  let a1 = 0; // A says true
  let b1 = 0; // B says true
  for (let i = 0; i < n; i++) {
    if (labelsA[i] === labelsB[i]) agree++;
    if (labelsA[i]) a1++;
    if (labelsB[i]) b1++;
  }

  const po = agree / n;
  const pA1 = a1 / n;
  const pB1 = b1 / n;
  const pe = pA1 * pB1 + (1 - pA1) * (1 - pB1);

  let kappa: number;
  if (pe >= 1) {
    kappa = po >= 1 ? 1 : 0; // no chance-variance; agreement is all-or-nothing
  } else {
    kappa = (po - pe) / (1 - pe);
  }
  return { kappa, observedAgreement: po, expectedAgreement: pe, n };
}

// ---------------------------------------------------------------------------
// Gwet's AC1 — prevalence-robust agreement (SOTA v2 R2)
// ---------------------------------------------------------------------------

export interface AgreementCoefficient {
  /** The coefficient in [-1,1], or null when undefined (n=0). */
  value: number | null;
  observedAgreement: number;
  chanceAgreement: number;
  n: number;
}

/**
 * Gwet's AC1 for two raters' binary labels — robust to the PREVALENCE PARADOX
 * that makes Cohen's κ collapse toward 0 (or go negative) when one class
 * dominates, even at very high observed agreement. Citation labels are highly
 * skewed (most answers have no brand citation), so κ is unstable there; AC1 is
 * the appropriate coefficient.
 *
 * Binary chance agreement: pe = 2·π̄·(1−π̄), π̄ = mean positive rate across both
 * raters. AC1 = (po − pe)/(1 − pe). PURE.
 */
export function gwetAC1(labelsA: boolean[], labelsB: boolean[]): AgreementCoefficient {
  const n = Math.min(labelsA.length, labelsB.length);
  if (n === 0) return { value: null, observedAgreement: 0, chanceAgreement: 0, n: 0 };

  let agree = 0;
  let a1 = 0;
  let b1 = 0;
  for (let i = 0; i < n; i++) {
    if (labelsA[i] === labelsB[i]) agree++;
    if (labelsA[i]) a1++;
    if (labelsB[i]) b1++;
  }
  const po = agree / n;
  const piBar = (a1 / n + b1 / n) / 2;
  const pe = 2 * piBar * (1 - piBar);
  const value = pe >= 1 ? (po >= 1 ? 1 : 0) : (po - pe) / (1 - pe);
  return { value, observedAgreement: po, chanceAgreement: pe, n };
}

// Deterministic PRNG (mulberry32) so bootstrap CIs are reproducible across runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap percentile CI for an agreement coefficient over paired labels.
 * Resamples the (a,b) PAIRS with replacement `B` times (default 1000), recomputes
 * the coefficient each time, and returns the [lower, upper] percentile interval.
 * Deterministic given `seed`. Returns nulls when n=0.
 *
 * @param compute  the coefficient function, e.g. gwetAC1 or cohenKappa-wrapped.
 */
export function bootstrapAgreementCI(
  labelsA: boolean[],
  labelsB: boolean[],
  compute: (a: boolean[], b: boolean[]) => { value?: number | null; kappa?: number | null },
  opts: { B?: number; seed?: number; z?: number } = {},
): { lower: number; upper: number } | null {
  const n = Math.min(labelsA.length, labelsB.length);
  if (n === 0) return null;
  const B = opts.B ?? 1000;
  const rnd = mulberry32(opts.seed ?? 0x9e3779b9);
  const coeff = (r: { value?: number | null; kappa?: number | null }): number | null =>
    r.value !== undefined ? r.value ?? null : r.kappa ?? null;

  const samples: number[] = [];
  for (let b = 0; b < B; b++) {
    const ra: boolean[] = new Array(n);
    const rb: boolean[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rnd() * n);
      ra[i] = labelsA[idx]!;
      rb[i] = labelsB[idx]!;
    }
    const c = coeff(compute(ra, rb));
    if (c !== null && Number.isFinite(c)) samples.push(c);
  }
  if (samples.length === 0) return null;
  samples.sort((x, y) => x - y);
  const lo = samples[Math.floor(0.025 * (samples.length - 1))]!;
  const hi = samples[Math.ceil(0.975 * (samples.length - 1))]!;
  return { lower: lo, upper: hi };
}

// ---------------------------------------------------------------------------
// Signed bias score
// ---------------------------------------------------------------------------

/**
 * Signed bias b = (prefersBrand − prefersCompetitor) / total ∈ [-1,1].
 * On constructed TIE pairs (brand and a competitor that should be equivalent),
 * a fair judge yields b≈0; b>0 means the judge systematically favors the brand
 * (inflating SMR), b<0 means it favors competitors. Ties (no preference) are in
 * `total` but contribute 0 to the numerator.
 *
 * Returns null when total=0 (not measurable).
 */
export function signedBiasScore(
  prefersBrand: number,
  prefersCompetitor: number,
  total: number,
): number | null {
  if (total <= 0) return null;
  return (prefersBrand - prefersCompetitor) / total;
}

// ---------------------------------------------------------------------------
// Position-swap consistency
// ---------------------------------------------------------------------------

export interface SwapPair {
  /** Brand rank/ordering signal in the ORIGINAL presentation order. */
  original: number | null;
  /** Brand rank/ordering signal after swapping presentation order. */
  swapped: number | null;
}

/**
 * Fraction of items whose brand ordering is STABLE across a presentation-order
 * swap. A position-biased judge changes its ordering when the order changes;
 * a robust judge does not. Both-null (brand absent in both) counts as stable.
 *
 * Returns { consistencyRate, n, stable } — consistencyRate is null when n=0.
 */
export function positionSwapConsistency(pairs: SwapPair[]): {
  consistencyRate: number | null;
  stable: number;
  n: number;
} {
  const n = pairs.length;
  if (n === 0) return { consistencyRate: null, stable: 0, n: 0 };
  let stable = 0;
  for (const p of pairs) {
    if (p.original === p.swapped) stable++;
  }
  return { consistencyRate: stable / n, stable, n };
}

// ---------------------------------------------------------------------------
// Agreement classification → measurement-quality gate
// ---------------------------------------------------------------------------

export type AgreementStatus = "ok" | "warn" | "not_measurable";

export interface AgreementClassification {
  status: AgreementStatus;
  kappa: number | null;
  /** Disclosed heuristic floor (not a guarantee). */
  threshold: number;
  note: string;
}

/**
 * Map an inter-judge κ to a measurement-quality status.
 *
 * - kappa === null (single-engine / no 2nd judge / n below floor) → not_measurable,
 *   and we say so plainly rather than inventing a number.
 * - kappa < threshold (default 0.5) → warn.
 * - else → ok.
 *
 * @param kappa  inter-judge κ, or null when a second judge is unavailable.
 * @param minN   minimum overlapping judgments to consider κ meaningful.
 * @param n      number of overlapping judgments κ was computed on.
 */
export function classifyAgreement(
  kappa: number | null,
  n: number,
  minN = 30,
  threshold = 0.5,
): AgreementClassification {
  if (kappa === null || n < minN) {
    return {
      status: "not_measurable",
      kappa: null,
      threshold,
      note:
        kappa === null
          ? "Inter-judge agreement is not yet measurable — only one judge engine is configured. Add a second JUDGE_PROVIDER to measure κ."
          : `Inter-judge agreement not yet reliable — only ${n} overlapping judgments (need ≥${minN}).`,
    };
  }
  if (kappa < threshold) {
    return {
      status: "warn",
      kappa,
      threshold,
      note: `Low inter-judge agreement (κ=${kappa.toFixed(2)} < ${threshold}, a disclosed heuristic floor) — interpret SMR with extra caution; the judges disagree on whether the brand is mentioned.`,
    };
  }
  return {
    status: "ok",
    kappa,
    threshold,
    note: `Inter-judge agreement is acceptable (κ=${kappa.toFixed(2)} ≥ ${threshold}).`,
  };
}
