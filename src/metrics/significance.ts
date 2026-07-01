/**
 * src/metrics/significance.ts — hi-end audit MUST #4.
 *
 * Baseline-vs-operating uplift significance for a binomial proportion (SMR or
 * citation share). Reporting "SMR rose from 8% to 14%" without a significance
 * test is indefensible: at small n that delta can be pure noise. This module
 * answers "is the change real?" with:
 *
 *   1. Fisher's exact test (two-sided) — exact, correct at the small n where
 *      AEO measurement lives (n often < 100). No normal approximation.
 *   2. Newcombe's hybrid-score 95% CI for the DIFFERENCE of two proportions —
 *      robust near 0/1 and at small n (where Wald intervals fail).
 *
 * PURE — no IO, no pg. Deterministic (no RNG; Fisher is exact, not bootstrap).
 */

// ---------------------------------------------------------------------------
// log-gamma (Lanczos approximation) — for exact hypergeometric probabilities
// ---------------------------------------------------------------------------

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Natural log of the gamma function (Lanczos). lgamma(n+1) = log(n!). */
export function lgamma(z: number): number {
  if (z < 0.5) {
    // Reflection formula for numerical stability on small/negative args.
    return (
      Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z)
    );
  }
  z -= 1;
  let x = LANCZOS_C[0]!;
  for (let i = 1; i < LANCZOS_G + 2; i++) {
    x += LANCZOS_C[i]! / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** log(n!) */
function lnFact(n: number): number {
  return lgamma(n + 1);
}

/**
 * Log-probability of a single 2x2 table under the hypergeometric distribution
 * with fixed margins. Table:
 *            success   failure   row total
 *   group1     a          b        a+b
 *   group2     c          d        c+d
 *   col tot   a+c        b+d         n
 */
function lnHyperProb(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  return (
    lnFact(a + b) + lnFact(c + d) + lnFact(a + c) + lnFact(b + d) -
    lnFact(a) - lnFact(b) - lnFact(c) - lnFact(d) - lnFact(n)
  );
}

// ---------------------------------------------------------------------------
// Fisher's exact test (two-sided)
// ---------------------------------------------------------------------------

/**
 * Two-sided Fisher's exact p-value for a 2x2 contingency table.
 *
 * Sums the probability of every table (with the SAME margins) whose probability
 * is <= the observed table's probability (the standard two-sided convention).
 *
 * Returns a p-value in [0,1]. Exact — valid for any n >= 0.
 */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  if (n === 0) return 1;

  const rowSuccess = a + c; // total successes (col1)
  const row1 = a + b; // group1 total
  const col2group1 = b; // unused directly; kept for clarity
  void col2group1;

  // For fixed margins, the table is determined by `a`. a ranges over
  // [max(0, row1 - (n - rowSuccess)), min(row1, rowSuccess)].
  const aMin = Math.max(0, row1 - (n - rowSuccess));
  const aMax = Math.min(row1, rowSuccess);

  const lnPObs = lnHyperProb(a, b, c, d);
  // Tolerance for "as extreme as" comparison in log space.
  const EPS = 1e-7;

  let pSum = 0;
  for (let ai = aMin; ai <= aMax; ai++) {
    const bi = row1 - ai;
    const ci = rowSuccess - ai;
    const di = n - ai - bi - ci;
    if (bi < 0 || ci < 0 || di < 0) continue;
    const lnP = lnHyperProb(ai, bi, ci, di);
    if (lnP <= lnPObs + EPS) {
      pSum += Math.exp(lnP);
    }
  }

  return Math.min(1, pSum);
}

// ---------------------------------------------------------------------------
// Newcombe hybrid-score CI for the difference of two proportions
// ---------------------------------------------------------------------------

/** Wilson score interval for a single proportion (z default 95%). */
function wilson(hits: number, n: number, z: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 0 };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/**
 * Newcombe (1998) method 10 — 95% CI for (p_operating − p_baseline) built from
 * the two single-proportion Wilson intervals. Robust at small n and near 0/1.
 *
 * Returns the CI for the DIFFERENCE operating − baseline.
 */
export function newcombeDiffCI(
  opHits: number,
  opN: number,
  baseHits: number,
  baseN: number,
  z = 1.96
): { lower: number; upper: number } {
  if (opN <= 0 || baseN <= 0) return { lower: 0, upper: 0 };
  const p1 = opHits / opN;
  const p2 = baseHits / baseN;
  const w1 = wilson(opHits, opN, z);
  const w2 = wilson(baseHits, baseN, z);
  // Newcombe method 10.
  const lower = p1 - p2 - Math.sqrt((p1 - w1.lower) ** 2 + (w2.upper - p2) ** 2);
  const upper = p1 - p2 + Math.sqrt((w1.upper - p1) ** 2 + (p2 - w2.lower) ** 2);
  return { lower: Math.max(-1, lower), upper: Math.min(1, upper) };
}

// ---------------------------------------------------------------------------
// Public: compareProportions
// ---------------------------------------------------------------------------

export interface ProportionComparison {
  baselineValue: number;
  operatingValue: number;
  /** operating − baseline (the absolute uplift in proportion). */
  delta: number;
  /** Two-sided Fisher's exact p-value for the uplift. */
  pValue: number;
  /** True when pValue < alpha (default 0.05). */
  significant: boolean;
  /** Significance threshold used. */
  alpha: number;
  /** 95% CI for the delta (Newcombe). When it excludes 0, the uplift is real. */
  deltaCi95: { lower: number; upper: number };
  /** True when either arm has n < 100 — the test runs but is under-powered. */
  lowPower: boolean;
  method: "fisher_exact_two_sided";
}

/**
 * Compare an operating proportion to a baseline proportion and decide whether
 * the uplift is statistically significant.
 *
 * @param operatingHits  successes in the operating run
 * @param operatingN     trials in the operating run (run.n_total)
 * @param baselineHits   successes in the baseline run
 * @param baselineN      trials in the baseline run
 * @param alpha          significance level (default 0.05)
 */
export function compareProportions(
  operatingHits: number,
  operatingN: number,
  baselineHits: number,
  baselineN: number,
  alpha = 0.05
): ProportionComparison {
  const baselineValue = baselineN > 0 ? baselineHits / baselineN : 0;
  const operatingValue = operatingN > 0 ? operatingHits / operatingN : 0;

  // 2x2 table: rows = {operating, baseline}, cols = {hit, miss}.
  const a = operatingHits;
  const b = operatingN - operatingHits;
  const c = baselineHits;
  const d = baselineN - baselineHits;

  const pValue = fisherExactTwoSided(a, b, c, d);
  const deltaCi95 = newcombeDiffCI(operatingHits, operatingN, baselineHits, baselineN);

  return {
    baselineValue,
    operatingValue,
    delta: operatingValue - baselineValue,
    pValue,
    significant: pValue < alpha,
    alpha,
    deltaCi95,
    lowPower: operatingN < 100 || baselineN < 100,
    method: "fisher_exact_two_sided",
  };
}
