/**
 * src/metrics/retrievability.ts
 *
 * Retrievability — a PRE-PUBLISH LEADING INDICATOR (deep-exploration top lever).
 *
 * Whether an answer engine cites a passage starts with whether its retriever
 * even SURFACES that passage for the target query. We approximate that with
 * embedding cosine(target-query, passage): a high max-cosine means the passage
 * is a strong retrieval candidate; a low score predicts the passage will never
 * be seen (so it can't be cited) — measurable BEFORE we spend a publish cycle
 * and wait weeks for Share-of-Model-Recall to (not) move.
 *
 * This module is PURE (vector math only). Producing the embeddings is delegated
 * to an injectable EmbeddingAdapter (Gemini text-embedding-004, etc.) so the
 * scorer is testable without a network call and stays OFF until an adapter is
 * wired — same gating discipline as indexNow.ts.
 *
 * §7: this is an INTERNAL indexing-hygiene indicator, NOT a predicted citation
 * outcome and NOT a claim. Thresholds are heuristic/uncalibrated (advisory),
 * mirroring geoReadiness — never surface a retrievability number to a customer
 * as a guarantee.
 *
 * Node 22 ESM NodeNext.
 */

/** L2 norm of a vector. */
function norm(v: readonly number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 for a
 * zero vector or a length mismatch (fail-safe, never throws / NaN).
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot / denom;
}

/** Advisory retrievability band (uncalibrated — heuristic, like geoReadiness). */
export type RetrievabilityBand = "strong" | "moderate" | "weak";

export interface RetrievabilityScore {
  /** Best cosine across all passages — the passage most likely to be retrieved. */
  maxCosine: number;
  /** Mean of the top-K passage cosines (robustness to a single lucky passage). */
  meanTopK: number;
  /** Advisory band derived from maxCosine. */
  band: RetrievabilityBand;
  /** Number of passages scored. */
  nPassages: number;
}

const STRONG_AT = 0.8;
const MODERATE_AT = 0.62;

function bandOf(maxCosine: number): RetrievabilityBand {
  if (maxCosine >= STRONG_AT) return "strong";
  if (maxCosine >= MODERATE_AT) return "moderate";
  return "weak";
}

/**
 * Score how retrievable a set of passages is for one target-query embedding.
 * PURE. `passageEmbeddings` are the per-passage vectors (e.g. one per FAQ answer
 * / answer_block chunk); `queryEmbedding` is the target user query's vector.
 *
 * @param queryEmbedding     Target query vector.
 * @param passageEmbeddings  One vector per candidate passage.
 * @param topK               How many top passages to average for meanTopK (default 3).
 */
export function retrievabilityScore(
  queryEmbedding: readonly number[],
  passageEmbeddings: ReadonlyArray<readonly number[]>,
  topK = 3,
): RetrievabilityScore {
  if (passageEmbeddings.length === 0) {
    return { maxCosine: 0, meanTopK: 0, band: "weak", nPassages: 0 };
  }
  const cosines = passageEmbeddings
    .map((p) => cosineSimilarity(queryEmbedding, p))
    .sort((a, b) => b - a);
  const maxCosine = cosines[0]!;
  const k = Math.max(1, Math.min(topK, cosines.length));
  const meanTopK = cosines.slice(0, k).reduce((s, c) => s + c, 0) / k;
  return { maxCosine, meanTopK, band: bandOf(maxCosine), nPassages: cosines.length };
}

/**
 * Aggregate retrievability of an asset across MULTIPLE target queries (the
 * fan-out sub-queries the asset should answer). Returns the per-query scores +
 * the fraction that are at least `moderate` — a compact "does this asset cover
 * its intended query space" signal. PURE.
 */
export interface AssetRetrievability {
  perQuery: RetrievabilityScore[];
  /** Fraction of target queries with band !== 'weak'. */
  coverage: number;
  /** Mean maxCosine across target queries. */
  meanMax: number;
}

export function assetRetrievability(
  queryEmbeddings: ReadonlyArray<readonly number[]>,
  passageEmbeddings: ReadonlyArray<readonly number[]>,
  topK = 3,
): AssetRetrievability {
  const perQuery = queryEmbeddings.map((q) => retrievabilityScore(q, passageEmbeddings, topK));
  if (perQuery.length === 0) return { perQuery, coverage: 0, meanMax: 0 };
  const covered = perQuery.filter((s) => s.band !== "weak").length;
  const meanMax = perQuery.reduce((s, r) => s + r.maxCosine, 0) / perQuery.length;
  return { perQuery, coverage: covered / perQuery.length, meanMax };
}

/**
 * Injectable embedding provider (Gemini text-embedding-004, etc.). The scorer
 * stays OFF (no network) until a real adapter is supplied — wire this the same
 * way claimVerificationGate injects its Gemini adapter. Left as an interface
 * here so retrievability can be scored in tests with a stub.
 */
export interface EmbeddingAdapter {
  /** Embed a batch of texts → one vector each (same order). */
  embed(texts: string[]): Promise<number[][]>;
}
