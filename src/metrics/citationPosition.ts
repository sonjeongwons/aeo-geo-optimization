/**
 * src/metrics/citationPosition.ts — Feature X16 (extractor ONLY): first-citation
 * RANK of a target domain within an answer's ordered citation list.
 *
 * SCOPE — deliberately the SAFE half of X16. The v5 critic warned that the
 * position-corrected odds-ratio (IRLS) model is unstable: ~86% of answers carry
 * exactly ONE cited URL, so `position` is degenerate and a Wald OR would be a
 * confident-looking but unreliable number. We therefore ship ONLY the §0-safe,
 * standalone EXTRACTOR (where in the citation order a domain appears, and how
 * many distinct sources were cited) and DO NOT surface any position-adjusted
 * visibility OR. The extractor is the prerequisite that lets a future, properly
 * guarded (Firth/penalized) model decide whether enough 2+-citation answers even
 * exist — but that model is out of scope here.
 *
 * §0: operates ONLY on the engine-returned, already-resolved cited domains (in
 * textual order). It never fetches a URL. PURE — no IO, no pg.
 *
 * Ref: arXiv 2605.25517 (first-citation extraction in competitive GEO).
 */

export interface CitationPosition {
  targetDomain: string;
  /** 1-indexed rank of the target among DISTINCT cited domains (first-occurrence order); null when not cited. */
  rank: number | null;
  /** Number of DISTINCT cited domains in the answer. */
  nCited: number;
}

/** Lowercase + trim a domain for comparison. */
function norm(d: string): string {
  return d.trim().toLowerCase();
}

/**
 * Find the 1-indexed rank of `targetDomain` among the DISTINCT cited domains,
 * ordered by first textual occurrence. `orderedCitedDomains` is the answer's
 * cited registrable domains IN ORDER (resolve redirect wrappers upstream via
 * groundingGap.domainForChunk before calling). PURE.
 */
export function firstCitationRank(
  orderedCitedDomains: readonly string[],
  targetDomain: string,
): CitationPosition {
  const target = norm(targetDomain);
  const seen: string[] = [];
  const seenSet = new Set<string>();
  for (const raw of orderedCitedDomains) {
    const d = norm(raw);
    if (!d || seenSet.has(d)) continue;
    seenSet.add(d);
    seen.push(d);
  }
  const idx = target ? seen.indexOf(target) : -1;
  return {
    targetDomain: target,
    rank: idx >= 0 ? idx + 1 : null,
    nCited: seen.length,
  };
}

export interface CitationRankAggregate {
  /** Answers considered. */
  nAnswers: number;
  /** Answers where the target was cited (rank != null). */
  citedAnswers: number;
  /** citedAnswers / nAnswers; 0 when nAnswers=0. (Reported SEPARATELY — ranks are NOT imputed for uncited answers.) */
  citedShare: number;
  /** Median rank among CITED answers only; null when none cited. */
  medianRank: number | null;
  /** 75th-percentile rank among CITED answers only; null when none cited. */
  p75Rank: number | null;
  /** Mean number of distinct cited sources per answer; null when nAnswers=0. */
  meanNCited: number | null;
}

/** Nearest-rank percentile over a sorted ascending array; null when empty. */
function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Aggregate per-answer citation positions. HONEST: rank percentiles are computed
 * ONLY over answers where the target was actually cited; `citedShare` is reported
 * separately rather than imputing a rank for uncited answers. PURE.
 */
export function aggregateCitationRanks(
  positions: readonly CitationPosition[],
): CitationRankAggregate {
  const nAnswers = positions.length;
  const ranks = positions
    .map((p) => p.rank)
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  const citedAnswers = ranks.length;
  const meanNCited =
    nAnswers > 0 ? positions.reduce((s, p) => s + p.nCited, 0) / nAnswers : null;
  return {
    nAnswers,
    citedAnswers,
    citedShare: nAnswers > 0 ? citedAnswers / nAnswers : 0,
    medianRank: percentile(ranks, 0.5),
    p75Rank: percentile(ranks, 0.75),
    meanNCited,
  };
}
