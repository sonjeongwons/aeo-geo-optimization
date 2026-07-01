/**
 * src/metrics/confidenceSequence.ts — Feature X30 (queued V2): anytime-valid
 * confidence sequences (CS) for AEO/GEO A/B monitoring under repeated peeking.
 *
 * PURPOSE
 * -------
 * The fixed-n Fisher + Newcombe intervals in significance.ts are designed for a
 * single look at final data. They give INVALID coverage guarantees when a user
 * peeks at accumulating data before collection is complete (optional stopping).
 * This module is a COMPLEMENT, not a replacement: use significance.ts for
 * planned single-look analyses; use this module when customers need to watch
 * rolling citation-share or visibility data and want an honest "can I stop yet?"
 * signal at any point in time.
 *
 * A confidence sequence (CS) satisfies the ANYTIME-VALID coverage guarantee:
 *
 *   P( ∀n ≥ 1 : θ ∈ CS(n) ) ≥ 1 − α
 *
 * i.e., the true parameter is inside the interval at every sample size
 * simultaneously, not just at one pre-specified n ("time-uniform").
 *
 * RADIUS FORMULA (honest union-bound construction)
 * ------------------------------------------------
 * We spend the global error budget α across looks with a SUMMABLE per-look
 * allocation, so the union bound over all looks is genuinely ≤ α. Allocate
 *
 *   α_n = 6α / (π² n²)        ⇒  Σ_{n≥1} α_n = α   (since Σ 1/n² = π²/6).
 *
 * At each look apply the two-sided Hoeffding bound P(|p̂ − p| ≥ h) ≤ 2e^{−2nh²}
 * with budget α_n, i.e. 2e^{−2nh(n)²} = α_n, giving
 *
 *   h(n) = sqrt( log( 2 / α_n ) / (2n) ) = sqrt( log( π² n² / (3α) ) / (2n) ).
 *
 * Then P(∃n : |p̂_n − p| ≥ h(n)) ≤ Σ_n α_n = α, so { p̂_n ± h(n) } is a valid
 * time-uniform confidence sequence. (This is the simple Bonferroni-over-looks /
 * peeling construction — conservative relative to the tighter Hoeffding-mixture
 * or empirical-Bernstein CS, but a single closed form requiring no accumulated
 * state, and it is HONESTLY anytime-valid. An EARLIER version of this module used
 * h(n)=sqrt(log((n+1)/α)/(2n)), whose per-look budget 2α/(n+1) sums divergently —
 * that radius is NOT anytime-valid and was corrected here, SOTA sweep v7 Z1.)
 *
 * Reference for time-uniform / anytime-valid inference and the union-bound CS:
 *   Howard, Ramdas, McAuliffe & Sekhon (2021), "Time-uniform, nonparametric,
 *   nonasymptotic confidence sequences," Ann. Statist. 49(2); survey arXiv:2302.10108.
 *
 * COMBINATION RULE FOR TWO ARMS (honest)
 * --------------------------------------
 * For the difference pA − pB of two independent arms we split the budget α/2 per
 * arm and combine the half-widths ADDITIVELY (triangle inequality):
 *
 *   h_diff = h(nA; α/2) + h(nB; α/2).
 *
 * If each arm's CS holds ∀n with prob ≥ 1−α/2, both hold simultaneously with
 * prob ≥ 1−α (union over the two arms), and then |(p̂A−p̂B)−(pA−pB)| ≤ hA + hB.
 * (The root-sum-of-squares rule used in the earlier version is narrower than the
 * triangle bound and is NOT justified by this worst-case union-bound CS, so it
 * would UNDER-cover; corrected to the additive rule, SOTA sweep v7 Z1.)
 *
 * DEFERRED STATE NOTE
 * -------------------
 * A tighter, adaptive CS (empirical-Bernstein / Robbins stitched) needs running
 * sums of squared deviations; persisting that across API calls would require a
 * `seq_test_state` table. DEFERRED — the current formula is self-contained in the
 * snapshot (successes, n) already on the run rows.
 *
 * PURE — no IO, no pg, deterministic.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function assertAlpha(alpha: number): void {
  if (!(alpha > 0 && alpha < 1)) {
    throw new RangeError(`alpha must be in (0,1), got ${alpha}`);
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Union-bound time-uniform Hoeffding CS half-width for a [0,1]-bounded mean:
 *
 *   h(n) = sqrt( log( π² n² / (3α) ) / (2n) ).
 *
 * Returns Infinity for n ≤ 0. Assumes alpha ∈ (0,1) (validated by the caller).
 */
function hoeffdingHalfWidth(n: number, alpha: number): number {
  if (n <= 0) return Infinity;
  return Math.sqrt(Math.log((Math.PI * Math.PI * n * n) / (3 * alpha)) / (2 * n));
}

// ---------------------------------------------------------------------------
// Single-proportion anytime-valid CS
// ---------------------------------------------------------------------------

/** An anytime-valid confidence interval for a single proportion. */
export interface CSInterval {
  /** Observed sample proportion (successes / n), clamped to [0,1]; 0 when n = 0. */
  pointEstimate: number;
  /** Lower bound of the CS, clamped to [0, 1]. */
  lower: number;
  /** Upper bound of the CS, clamped to [0, 1]. */
  upper: number;
  /** Number of observations. */
  n: number;
  /** One-sided half-width of the CS before clamping. Infinity when n = 0. */
  halfWidth: number;
}

/**
 * Anytime-valid confidence sequence for a single proportion, clamped to [0,1].
 * When n = 0 the interval spans [0,1] and `halfWidth` is Infinity.
 *
 * @param successes  Number of successes observed (integer ≥ 0).
 * @param n          Total trials (integer ≥ 0).
 * @param alpha      Type-I error level in (0,1); default 0.05.
 */
export function proportionCS(successes: number, n: number, alpha = 0.05): CSInterval {
  assertAlpha(alpha);
  const pointEstimate = n > 0 ? clamp01(successes / n) : 0;
  const halfWidth = hoeffdingHalfWidth(n, alpha);

  if (!isFinite(halfWidth)) {
    return { pointEstimate: 0, lower: 0, upper: 1, n, halfWidth: Infinity };
  }
  return {
    pointEstimate,
    lower: Math.max(0, pointEstimate - halfWidth),
    upper: Math.min(1, pointEstimate + halfWidth),
    n,
    halfWidth,
  };
}

// ---------------------------------------------------------------------------
// Two-proportion difference anytime-valid CS
// ---------------------------------------------------------------------------

/** An anytime-valid confidence interval for the difference of two proportions. */
export interface DiffCS {
  /** Point estimate pA − pB (each proportion clamped to [0,1] first). */
  diff: number;
  /** Lower bound of the CS for the difference, clamped to [−1, 1]. */
  lower: number;
  /** Upper bound of the CS for the difference, clamped to [−1, 1]. */
  upper: number;
  /** Sample size for arm A. */
  nA: number;
  /** Sample size for arm B. */
  nB: number;
  /**
   * True when the CS contains 0 — insufficient evidence that the arms differ.
   * False only when the interval lies entirely above or below 0 (the earliest
   * valid stopping criterion under the anytime-valid guarantee).
   */
  crossedZero: boolean;
  /** Type-I error level used (split α/2 across the two arms internally). */
  alpha: number;
}

/**
 * Anytime-valid confidence sequence for the difference of two independent
 * proportions (pA − pB). Splits α/2 per arm and combines the half-widths
 * additively (triangle inequality) for an honest 1−α joint guarantee. Clamped to
 * [−1, 1]. When either arm has n = 0 the interval spans [−1, 1] and crossedZero
 * is true.
 *
 * @param alpha  Type-I error level in (0,1); default 0.05.
 */
export function proportionDiffCS(
  successesA: number,
  nA: number,
  successesB: number,
  nB: number,
  alpha = 0.05,
): DiffCS {
  assertAlpha(alpha);
  const pA = nA > 0 ? clamp01(successesA / nA) : 0;
  const pB = nB > 0 ? clamp01(successesB / nB) : 0;
  const diff = pA - pB;

  // Split the budget α/2 per arm so the union over both arms is ≤ α.
  const armAlpha = alpha / 2;
  const hA = hoeffdingHalfWidth(nA, armAlpha);
  const hB = hoeffdingHalfWidth(nB, armAlpha);

  if (!isFinite(hA) || !isFinite(hB)) {
    return { diff, lower: -1, upper: 1, nA, nB, crossedZero: true, alpha };
  }

  // Additive (triangle-inequality) combination — honestly anytime-valid.
  const combinedHalfWidth = hA + hB;
  const lower = Math.max(-1, diff - combinedHalfWidth);
  const upper = Math.min(1, diff + combinedHalfWidth);
  return { diff, lower, upper, nA, nB, crossedZero: lower <= 0 && upper >= 0, alpha };
}
