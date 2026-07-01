/**
 * src/metrics/pooling.ts — hierarchical partial-pooling for noisy per-cell rates
 * (SOTA v2 R3).
 *
 * A per-prompt cell at N=3–5 has a hugely noisy raw rate (1/3 = 33% on one
 * sample). Partial pooling shrinks each cell's rate toward the run-level mean by
 * an amount proportional to how little direct evidence the cell has — a
 * Beta(prior) / empirical-Bayes pseudo-count: a cell with many samples barely
 * moves; a 1/3 cell shrinks a lot. The pooled estimate is a BETTER point estimate
 * of the cell's true rate than the raw fraction.
 *
 * HONESTY (§7): the pooled value is reported as a SEPARATE, explicitly-labeled
 * field — it NEVER overwrites the raw rate or the raw Wilson CI, and `lowPower`
 * keeps keying off the RAW cell n (a shrunk estimate is still backed by only N=3
 * of direct evidence). A pooled number must never be mistaken for a directly
 * measured one.
 *
 * PURE — no IO, no pg.
 */

import { wilsonInterval } from "../domain/metrics.types.js";

/**
 * Effective prior strength (pseudo-observations) pulling a cell toward the run
 * mean. STRENGTH pseudo-samples of the grand rate are added to each cell. At the
 * usual N=3–5 this gives the run mean meaningful weight without erasing a strong
 * cell signal; a 30-sample cell barely moves.
 */
export const DEFAULT_POOL_STRENGTH = 5;

export interface PooledEstimate {
  /** Raw cell rate, unchanged. */
  rawRate: number;
  /** Partially-pooled (shrunk-toward-grand-mean) rate. */
  pooledRate: number;
  /** 95% Wilson interval on the pseudo-augmented counts (wider acknowledgement of prior). */
  pooledCi95: { lower: number; upper: number };
  /** Pseudo-count strength used. */
  strength: number;
}

/**
 * Partially pool a cell proportion toward a grand mean via a Beta pseudo-count.
 *
 *   pooledRate = (hits + strength·grandRate) / (n + strength)
 *
 * The pooled value lies between the raw cell rate and the grand rate. The
 * accompanying CI is a Wilson interval over the pseudo-augmented counts, which is
 * a pragmatic (slightly conservative) credible band — never tighter than the
 * raw cell would justify on its own n.
 *
 * @param hits       cell successes
 * @param n          cell trials
 * @param grandRate  the run-level (pooled-across-cells) rate to shrink toward
 * @param strength   prior pseudo-count (default 5)
 */
export function partialPool(
  hits: number,
  n: number,
  grandRate: number,
  strength: number = DEFAULT_POOL_STRENGTH,
): PooledEstimate {
  const rawRate = n > 0 ? hits / n : 0;
  const g = Math.min(1, Math.max(0, grandRate));
  const denom = n + strength;
  const pooledRate = denom > 0 ? (hits + strength * g) / denom : g;
  // Pseudo-augmented counts for the CI: add `strength` prior observations split
  // by the grand rate. Round to keep wilsonInterval's integer contract sane.
  const pseudoHits = hits + strength * g;
  const pseudoN = n + strength;
  const pooledCi95 = wilsonInterval(pseudoHits, pseudoN);
  return { rawRate, pooledRate, pooledCi95, strength };
}
