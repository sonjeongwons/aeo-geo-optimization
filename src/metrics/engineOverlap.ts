/**
 * src/metrics/engineOverlap.ts — cross-engine cited-domain overlap metric (X25).
 *
 * Given per-response source signals (each tagged with `modelId` = the engine),
 * measures how much different engines cite the SAME third-party domains via both
 * Jaccard (set overlap) and cosine (frequency-vector overlap).
 *
 * Low overlap ⇒ pooling cited-domain targeting across engines is invalid; force
 * per-engine targeting. High overlap ⇒ a single cross-engine targeting list may
 * suffice (verify with per-engine breakdowns before acting).
 *
 * §7 honesty: the default threshold and minDomains below are DISCLOSED HEURISTIC
 * defaults, NOT empirically validated cut-offs. Real-world cross-engine citation
 * overlap can be low — some engine pairs exhibit high siloing — but this code makes
 * NO claim about specific measured rates on any particular dataset; callers must
 * evaluate thresholds against their own corpus.
 *
 * PURE — no IO, no pg, no network. The DB-backed wrapper feeds it per-response
 * grounding traces read from response_raw.provider_meta.
 */

import type { ResponseSourceSignal } from "./earnedSources.js";

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

/** Overlap metrics for one unordered pair of engines. */
export interface EnginePairOverlap {
  /** modelId of the first engine, sorted so engineA < engineB lexicographically. */
  engineA: string;
  /** modelId of the second engine. */
  engineB: string;
  /** |A∩B| / |A∪B| over each engine's cited-domain SET; 0 when union is empty. */
  jaccard: number;
  /**
   * Cosine similarity over per-domain CITED-RESPONSE-COUNT vectors aligned on the
   * union of domains. 0 when either vector is all-zero.
   */
  cosine: number;
  /** Number of domains in the intersection of the two cited-domain sets. */
  intersectionSize: number;
  /** Number of domains in the union of the two cited-domain sets. */
  unionSize: number;
  /** # distinct cited domains for engine A. */
  nDomainsA: number;
  /** # distinct cited domains for engine B. */
  nDomainsB: number;
  /**
   * True when jaccard >= threshold. Indicates pooling cited-domain targeting may be
   * safe for this pair (but verify with domain-level data before acting).
   */
  pooledSafe: boolean;
  /**
   * True when either engine has fewer than minDomains distinct cited domains.
   * Low-data pairs should not be used to draw targeting conclusions.
   */
  lowData: boolean;
}

/** Aggregate cross-engine overlap report. */
export interface EngineOverlapReport {
  /** Sorted list of distinct engine modelIds seen in the signals. */
  engines: string[];
  /** One EnginePairOverlap per unordered engine pair, in stable deterministic order. */
  pairs: EnginePairOverlap[];
  /** The Jaccard threshold used for the pooledSafe flag. */
  threshold: number;
  /** Mean of pairs' jaccard values; null when there are no pairs. */
  meanJaccard: number | null;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Compute cross-engine cited-domain overlap across all engine pairs.
 *
 * PURE. Domains are lowercased and deduped per the house convention.
 *
 * @param signals  one entry per response that had grounding/citation data
 * @param opts.threshold  Jaccard threshold for pooledSafe flag
 *   (HEURISTIC default = 0.2; NOT empirically validated — §7)
 * @param opts.minDomains  minimum distinct cited domains required for a non-lowData
 *   pair (HEURISTIC default = 3; NOT empirically validated — §7)
 */
export function computeEngineOverlap(
  signals: ResponseSourceSignal[],
  opts?: { threshold?: number; minDomains?: number },
): EngineOverlapReport {
  // DISCLOSED HEURISTIC defaults — NOT empirically validated (§7).
  const threshold = opts?.threshold ?? 0.2;
  const minDomains = opts?.minDomains ?? 3;

  // --- 1. Aggregate per-engine data -------------------------------------------
  // domainSets: engine → Set of distinct cited domains (lowercased)
  // countMaps:  engine → Map<domain, # responses that cited it>
  const domainSets = new Map<string, Set<string>>();
  const countMaps = new Map<string, Map<string, number>>();

  for (const signal of signals) {
    const engine = signal.modelId;
    if (!domainSets.has(engine)) {
      domainSets.set(engine, new Set());
      countMaps.set(engine, new Map());
    }
    const setA = domainSets.get(engine)!;
    const mapA = countMaps.get(engine)!;

    for (const raw of signal.citedDomains) {
      const d = raw.toLowerCase();
      setA.add(d);
      mapA.set(d, (mapA.get(d) ?? 0) + 1);
    }
  }

  // Engines sorted for stable deterministic output; engines with zero cited
  // domains still appear if they have signals.
  const engines = Array.from(domainSets.keys()).sort();

  // --- 2. Build pairs ----------------------------------------------------------
  const pairs: EnginePairOverlap[] = [];

  for (let i = 0; i < engines.length; i++) {
    for (let j = i + 1; j < engines.length; j++) {
      const engineA = engines[i]!;
      const engineB = engines[j]!;

      const setA = domainSets.get(engineA)!;
      const setB = domainSets.get(engineB)!;
      const mapA = countMaps.get(engineA)!;
      const mapB = countMaps.get(engineB)!;

      // Union and intersection
      const unionDomains = new Set([...setA, ...setB]);
      let intersectionSize = 0;
      for (const d of setA) {
        if (setB.has(d)) intersectionSize++;
      }
      const unionSize = unionDomains.size;

      // Jaccard over sets
      const jaccard = unionSize === 0 ? 0 : intersectionSize / unionSize;

      // Cosine over count vectors aligned on the union
      let dotProduct = 0;
      let normA = 0;
      let normB = 0;
      for (const d of unionDomains) {
        const a = mapA.get(d) ?? 0;
        const b = mapB.get(d) ?? 0;
        dotProduct += a * b;
        normA += a * a;
        normB += b * b;
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      const cosine = denom === 0 ? 0 : dotProduct / denom;

      const nDomainsA = setA.size;
      const nDomainsB = setB.size;

      pairs.push({
        engineA,
        engineB,
        jaccard,
        cosine,
        intersectionSize,
        unionSize,
        nDomainsA,
        nDomainsB,
        pooledSafe: jaccard >= threshold,
        lowData: nDomainsA < minDomains || nDomainsB < minDomains,
      });
    }
  }

  // --- 3. meanJaccard ----------------------------------------------------------
  const meanJaccard: number | null =
    pairs.length === 0
      ? null
      : pairs.reduce((sum, p) => sum + p.jaccard, 0) / pairs.length;

  return { engines, pairs, threshold, meanJaccard };
}
