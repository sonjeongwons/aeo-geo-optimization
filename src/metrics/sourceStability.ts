/**
 * src/metrics/sourceStability.ts — source-set STABILITY (Jaccard + RBO) and
 * CONCENTRATION (Gini) over repeated answer-engine runs.
 *
 * Motivation: single-shot AI-search visibility is unreliable. The same
 * (prompt, engine) pair often returns different cited-domain sets on successive
 * calls. This module quantifies how stable that citation set is (Jaccard,
 * RBO) and how concentrated citations are across domains (Gini). Stability
 * metrics are ORTHOGONAL to the shipped binary-mention-rate Wilson CI from
 * earnedSources.ts — they measure a different failure mode (run-to-run
 * variance vs. point-in-time reach).
 *
 * References:
 *   - Webber et al. 2010, "A Similarity Measure for Indefinite Rankings"
 *     (RBO, base/non-extrapolated form)
 *   - arXiv 2604.07585 — LLM citation instability in AI search
 *   - arXiv 2603.08924 — measurement framework for AEO/GEO signals
 *
 * PURE — no IO, no pg, no network. Deterministic. §0 compliant.
 * §7: never fabricate a number when undefined — returns null + volatile=false
 * when nRuns < 2.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Lowercase + deduplicate an array of domain strings. Order of first
 *  occurrence is preserved. */
function normalizeSet(domains: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of domains) {
    const low = d.toLowerCase();
    if (!seen.has(low)) {
      seen.add(low);
      out.push(low);
    }
  }
  return out;
}

/** Lowercase + deduplicate keeping first occurrence (for ranked lists). */
function normalizeRanked(list: string[]): string[] {
  return normalizeSet(list); // same logic — first-occurrence dedup
}

// ---------------------------------------------------------------------------
// Jaccard
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity over two domain SETS (lowercased + deduped internally).
 * Returns 1 when both inputs are empty (vacuously identical).
 */
export function jaccardSet(a: string[], b: string[]): number {
  const setA = new Set(normalizeSet(a));
  const setB = new Set(normalizeSet(b));

  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const d of setA) {
    if (setB.has(d)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// ---------------------------------------------------------------------------
// RBO (Rank-Biased Overlap) — Webber et al. 2010, base/non-extrapolated form
// ---------------------------------------------------------------------------

/**
 * Base Rank-Biased Overlap over two ORDERED domain lists (Webber et al. 2010,
 * non-extrapolated form), normalised to [0, 1]:
 *
 *   raw  = (1 − p) × Σ_{d=1..k} p^(d−1) × (|top_d(A) ∩ top_d(B)| / d)
 *   max  = (1 − p) × Σ_{d=1..k} p^(d−1)          (all positions agree)
 *   RBO  = raw / max
 *
 *   where k = max(|A|, |B|) after internal first-occurrence dedup + lowercase.
 *
 * The normalisation makes RBO = 1 for identical finite lists and preserves
 * all rank-sensitivity properties: p controls top-heaviness (higher p →
 * deeper positions matter more). Default p = 0.9 — DISCLOSED HEURISTIC, NOT
 * validated on this data per §7.
 *
 * Returns 1 when both lists are empty, 0 when exactly one is empty.
 */
export function rbo(listA: string[], listB: string[], p = 0.9): number {
  if (p <= 0 || p >= 1) throw new RangeError(`rbo: p must be in (0,1), got ${p}`);

  const a = normalizeRanked(listA);
  const b = normalizeRanked(listB);

  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const k = Math.max(a.length, b.length);
  let raw = 0;
  let maxScore = 0;
  const prefixA = new Set<string>();
  const prefixB = new Set<string>();

  for (let d = 1; d <= k; d++) {
    if (d - 1 < a.length) prefixA.add(a[d - 1] as string);
    if (d - 1 < b.length) prefixB.add(b[d - 1] as string);

    let overlap = 0;
    for (const x of prefixA) {
      if (prefixB.has(x)) overlap++;
    }

    const weight = Math.pow(p, d - 1);
    raw += weight * (overlap / d);
    maxScore += weight;
  }

  // maxScore = Σ_{d=1..k} p^(d-1) = (1 − p^k)/(1 − p) > 0 for finite k (v7 Z11:
  // earlier comment wrongly said "1 − p^k"). The common (1 − p) factor cancels
  // between raw and maxScore, so it is omitted from both; raw/maxScore normalises
  // RBO to 1 for identical finite lists.
  return maxScore === 0 ? 0 : raw / maxScore;
}

// ---------------------------------------------------------------------------
// Gini coefficient
// ---------------------------------------------------------------------------

/**
 * Gini coefficient of a non-negative frequency vector (concentration of
 * citations across domains).
 *
 *   G = Σ_i Σ_j |x_i − x_j| / (2 × n² × mean)
 *
 * Returns null when counts is empty, all values are zero, or any value is
 * negative/non-finite (the input is not a valid non-negative frequency vector,
 * so no concentration can be inferred). §7: never fabricate a value for an
 * undefined distribution (v7 Z9 added the negative/non-finite guard).
 */
export function gini(counts: number[]): number | null {
  if (counts.length === 0) return null;
  for (const v of counts) {
    if (!Number.isFinite(v) || v < 0) return null;
  }

  const n = counts.length;
  const sum = counts.reduce((acc, v) => acc + v, 0);
  if (sum === 0) return null;

  const mean = sum / n;

  let absDevSum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      absDevSum += Math.abs((counts[i] as number) - (counts[j] as number));
    }
  }

  return absDevSum / (2 * n * n * mean);
}

// ---------------------------------------------------------------------------
// SourceStability aggregate
// ---------------------------------------------------------------------------

export interface SourceStability {
  nRuns: number;
  /** Mean Jaccard over all C(nRuns,2) unordered run pairs. null when nRuns<2. */
  meanPairwiseJaccard: number | null;
  /** Mean RBO over all C(nRuns,2) unordered run pairs. null when nRuns<2. */
  meanPairwiseRbo: number | null;
  /** True iff meanPairwiseJaccard is non-null AND below jaccardThreshold. */
  volatile: boolean;
  /**
   * Disclosed heuristic threshold for volatility classification.
   * Default 0.5 — NOT validated on this data (§7).
   */
  jaccardThreshold: number;
  /** The RBO persistence parameter used. Default 0.9 (§7 disclosed heuristic). */
  p: number;
}

/**
 * Compute source-set stability across N repeated runs of the same
 * (prompt, engine) pair.
 *
 * @param runs   Each element is the ordered cited-domain list returned by the
 *               engine for one run. Lists are lowercased + first-occurrence
 *               deduped internally before comparison.
 * @param opts   Optional overrides for p and jaccardThreshold.
 */
export function computeSourceStability(
  runs: string[][],
  opts?: { p?: number; jaccardThreshold?: number },
): SourceStability {
  // DISCLOSED HEURISTICS — NOT validated on this data (§7).
  const p = opts?.p ?? 0.9;
  const jaccardThreshold = opts?.jaccardThreshold ?? 0.5;

  const nRuns = runs.length;

  if (nRuns < 2) {
    return {
      nRuns,
      meanPairwiseJaccard: null,
      meanPairwiseRbo: null,
      volatile: false,
      jaccardThreshold,
      p,
    };
  }

  let jaccardSum = 0;
  let rboSum = 0;
  let pairs = 0;

  for (let i = 0; i < nRuns; i++) {
    for (let j = i + 1; j < nRuns; j++) {
      jaccardSum += jaccardSet(runs[i] as string[], runs[j] as string[]);
      rboSum += rbo(runs[i] as string[], runs[j] as string[], p);
      pairs++;
    }
  }

  // pairs >= 1 here since nRuns >= 2
  const meanPairwiseJaccard = jaccardSum / pairs;
  const meanPairwiseRbo = rboSum / pairs;

  return {
    nRuns,
    meanPairwiseJaccard,
    meanPairwiseRbo,
    volatile: meanPairwiseJaccard < jaccardThreshold,
    jaccardThreshold,
    p,
  };
}
