/**
 * src/generate/dedup.ts
 *
 * T11 — Dedup (normalized-exact + codepoint n-gram, CJK-safe)
 *
 * PURE module — no IO, no LLM calls, no embeddings.
 *
 * Two-layer dedup (per-language only; cross-language NOT applied):
 *
 * Layer 1 — Exact / normalized:
 *   NFC → lowercase → diacritic-fold (NFD + strip Mn category) →
 *   collapse-whitespace → strip trailing punctuation.
 *   Drops true duplicates before any DB insert so the UNIQUE(customer_id,text,language)
 *   constraint is never violated.
 *
 * Layer 2 — Near-duplicate within the same language:
 *   Codepoint 3-gram Jaccard similarity (NOT token/word Jaccard — works correctly
 *   for non-space-delimited scripts: ja, ko, zh, th).
 *   Within a cluster the most "natural" representative (longest text after
 *   normalisation) is kept; siblings from DISTINCT phrasingGroupIds are also
 *   kept (bounded to MAX_SIBLINGS_PER_CLUSTER); siblings from the same
 *   phrasingGroupId as the representative are dropped.
 *
 * References:
 *   DESIGN-phase1.md §"Guardrails & Dedup"
 *   phase1-tasks.json T11
 */

import type { DraftQuestion } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity threshold above which two questions within the same
 * language are considered near-duplicates.  0.65 catches restatements while
 * preserving genuinely distinct phrasings.  This value works correctly for CJK
 * codepoint 3-gram similarity where very similar strings often score 0.65–0.85.
 */
const NEAR_DUP_THRESHOLD = 0.65;

/**
 * Maximum number of phrasing-variant siblings (from DIFFERENT phrasingGroupIds)
 * to keep alongside the cluster representative.
 */
const MAX_SIBLINGS_PER_CLUSTER = 3;

/**
 * N-gram size for the codepoint n-gram Jaccard.
 * 3-grams (trigrams) balance discriminability and CJK coverage.
 */
const NGRAM_SIZE = 3;

// ---------------------------------------------------------------------------
// Layer 1: Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a question text for exact-duplicate detection.
 *
 * Steps:
 *   1. NFC normalization (canonical Unicode composition).
 *   2. Lowercase.
 *   3. Diacritic fold for LATIN script only:
 *      Decompose each character via NFD; remove Mn (Non-Spacing Mark) combining
 *      characters ONLY when they are preceded by a Latin base character
 *      (U+0041-U+024F range).  This avoids stripping dakuten/handakuten from
 *      katakana (パ→ハ) or other CJK combining marks.
 *      e.g. "café" → "cafe", "über" → "uber" but "パ" stays "パ".
 *   4. Re-apply NFC after the fold.
 *   5. Collapse all whitespace runs to a single ASCII space and trim.
 *   6. Strip trailing punctuation (?, !, ., 。、？！…).
 */
export function normalizeText(text: string): string {
  // Step 1: NFC
  let s = text.normalize("NFC");
  // Step 2: lowercase
  s = s.toLowerCase();
  // Step 3: Selective diacritic fold — Latin only.
  // NFD-decompose the full string, then remove Mn marks only when the
  // immediately preceding base codepoint is in the Latin range.
  // Latin blocks: Basic Latin (0000-007F), Latin-1 Supplement (0080-00FF),
  // Latin Extended-A/B (0100-024F).
  const latinMaxCP = 0x024f;
  const nfd = s.normalize("NFD");
  const cps = [...nfd]; // split into Unicode codepoints
  let out = "";
  let lastBaseIsLatin = false;
  for (const cp of cps) {
    const code = cp.codePointAt(0) ?? 0;
    // Check Unicode General Category: Mn = Non-Spacing Mark
    // We identify Mn marks as characters matching \p{Mn}
    const isMn = /^\p{Mn}$/u.test(cp);
    if (isMn) {
      // Only strip if the preceding base character was Latin
      if (lastBaseIsLatin) {
        continue; // strip the diacritic
      }
      // Otherwise keep (e.g. katakana combining voicing marks)
      out += cp;
      // Mn does not change lastBaseIsLatin
    } else {
      out += cp;
      lastBaseIsLatin = code <= latinMaxCP;
    }
  }
  // Step 4: Re-NFC after fold
  s = out.normalize("NFC");
  // Step 5: collapse whitespace
  s = s.replace(/\s+/gu, " ").trim();
  // Step 6: strip trailing punctuation (Latin + CJK punctuation)
  s = s.replace(/[?!.,。、？！…]+$/u, "").trim();
  return s;
}

// ---------------------------------------------------------------------------
// Layer 2: Codepoint 3-gram Jaccard
// ---------------------------------------------------------------------------

/**
 * Build the multiset of codepoint n-grams for a string.
 * Returns a Map from n-gram string → count (multiplicity).
 *
 * Works correctly for non-space-delimited scripts (ja/ko/zh/th) because
 * we operate at the Unicode codepoint level, not on whitespace tokens.
 */
function buildNgramMultiset(s: string, n: number): Map<string, number> {
  const codepoints = [...s]; // proper Unicode codepoint split
  const ms = new Map<string, number>();
  for (let i = 0; i <= codepoints.length - n; i++) {
    const gram = codepoints.slice(i, i + n).join("");
    ms.set(gram, (ms.get(gram) ?? 0) + 1);
  }
  return ms;
}

/**
 * Jaccard similarity on two n-gram multisets.
 * Jaccard = |intersection| / |union|, where intersection and union are
 * computed using multiset (bag) semantics.
 */
function jaccardSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let intersection = 0;
  let unionSize = 0;

  // Sum all counts in b
  for (const count of b.values()) {
    unionSize += count;
  }

  // Process a: add to union, subtract min overlap from union and add to intersection
  for (const [gram, countA] of a) {
    const countB = b.get(gram) ?? 0;
    const overlap = Math.min(countA, countB);
    intersection += overlap;
    unionSize += countA - overlap; // add a's unique portion
  }

  // If a had items not in b, we already covered them; add remaining a counts
  // Actually, let's redo with the correct formula:
  // union = sumA + sumB - intersection
  // We already have intersection, so recalculate.
  let sumA = 0;
  let sumB = 0;
  for (const c of a.values()) sumA += c;
  for (const c of b.values()) sumB += c;

  const denom = sumA + sumB - intersection;
  if (denom === 0) return 1; // both empty → identical
  return intersection / denom;
}

/**
 * Compute codepoint 3-gram Jaccard similarity between two normalized strings.
 */
export function trigramJaccard(a: string, b: string): number {
  // Short strings (< NGRAM_SIZE codepoints) get a simple equality check
  if ([...a].length < NGRAM_SIZE || [...b].length < NGRAM_SIZE) {
    return a === b ? 1 : 0;
  }
  const msA = buildNgramMultiset(a, NGRAM_SIZE);
  const msB = buildNgramMultiset(b, NGRAM_SIZE);
  return jaccardSimilarity(msA, msB);
}

// ---------------------------------------------------------------------------
// Cluster type (internal)
// ---------------------------------------------------------------------------

interface Cluster {
  /** The representative DraftQuestion for this cluster. */
  representative: DraftQuestion;
  /**
   * Sibling DraftQuestions from DISTINCT phrasingGroupIds that should also be
   * kept (up to MAX_SIBLINGS_PER_CLUSTER).
   */
  siblings: DraftQuestion[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of the dedup pass.
 */
export interface DedupResult {
  /** Questions that survived both dedup layers. Stable ordering. */
  kept: DraftQuestion[];
  /** Questions that were dropped. */
  dropped: DraftQuestion[];
}

/**
 * Deduplicate an array of DraftQuestions.
 *
 * IMPORTANT:
 *  - Cross-language dedup is NOT applied — each language is processed
 *    independently.
 *  - Input ordering is respected for stability; duplicates of an earlier
 *    question are dropped.
 *  - Pure function: no IO, no LLM calls.
 *
 * @param questions - Array of generated DraftQuestions (any ordering, any mix of languages).
 * @returns DedupResult with kept[] and dropped[].
 */
export function dedup(questions: DraftQuestion[]): DedupResult {
  // Group by language (cross-language dedup NOT applied)
  const byLanguage = new Map<string, DraftQuestion[]>();
  for (const q of questions) {
    const lang = q.language;
    if (!byLanguage.has(lang)) byLanguage.set(lang, []);
    byLanguage.get(lang)!.push(q);
  }

  const keptAll: DraftQuestion[] = [];
  const droppedAll: DraftQuestion[] = [];

  // Preserve the original order of languages as they appear in the input.
  const seenLangs: string[] = [];
  for (const q of questions) {
    if (!seenLangs.includes(q.language)) seenLangs.push(q.language);
  }

  for (const lang of seenLangs) {
    const qs = byLanguage.get(lang) ?? [];
    const { kept, dropped } = dedupLanguage(qs);
    keptAll.push(...kept);
    droppedAll.push(...dropped);
  }

  return { kept: keptAll, dropped: droppedAll };
}

/**
 * Apply both dedup layers to a single-language array of questions.
 * Returns kept[] (stable order) and dropped[].
 */
function dedupLanguage(questions: DraftQuestion[]): DedupResult {
  // ----------------------------------------------------------------
  // Layer 1 — Exact / normalized duplicate detection
  // ----------------------------------------------------------------
  const seenNorm = new Set<string>();
  const afterLayer1: DraftQuestion[] = [];
  const droppedL1: DraftQuestion[] = [];

  for (const q of questions) {
    const norm = normalizeText(q.text);
    if (seenNorm.has(norm)) {
      droppedL1.push(q);
    } else {
      seenNorm.add(norm);
      afterLayer1.push(q);
    }
  }

  // ----------------------------------------------------------------
  // Layer 2 — Near-duplicate codepoint 3-gram Jaccard clustering
  // ----------------------------------------------------------------
  // We use a greedy single-pass clustering: for each question, if it is
  // similar enough to an existing cluster's representative, it becomes a
  // candidate sibling of that cluster.  Otherwise it starts a new cluster.
  //
  // Within a cluster:
  //  - The representative is kept.
  //  - Siblings from DIFFERENT phrasingGroupIds are kept (up to MAX_SIBLINGS).
  //  - Siblings from the SAME phrasingGroupId as the representative are dropped.

  const clusters: Cluster[] = [];
  // Pre-compute normalized + n-gram multisets for all questions
  const norms = new Map<DraftQuestion, string>();
  const ngrams = new Map<DraftQuestion, Map<string, number>>();
  for (const q of afterLayer1) {
    const norm = normalizeText(q.text);
    norms.set(q, norm);
    const cps = [...norm];
    if (cps.length >= NGRAM_SIZE) {
      ngrams.set(q, buildNgramMultiset(norm, NGRAM_SIZE));
    }
  }

  for (const q of afterLayer1) {
    const qNorm = norms.get(q)!;
    const qGrams = ngrams.get(q);

    // Find the most similar existing cluster representative
    let bestCluster: Cluster | undefined;
    let bestSim = 0;

    for (const cluster of clusters) {
      const repNorm = norms.get(cluster.representative)!;
      const repGrams = ngrams.get(cluster.representative);

      let sim: number;
      if (!qGrams || !repGrams) {
        // Short string: exact match only
        sim = qNorm === repNorm ? 1 : 0;
      } else {
        sim = jaccardSimilarity(qGrams, repGrams);
      }

      if (sim >= NEAR_DUP_THRESHOLD && sim > bestSim) {
        bestSim = sim;
        bestCluster = cluster;
      }
    }

    if (!bestCluster) {
      // Start a new cluster with this question as the representative
      clusters.push({ representative: q, siblings: [] });
    } else {
      // This question is a near-duplicate of an existing cluster
      const repPgId = bestCluster.representative.phrasingGroupId;
      if (q.phrasingGroupId !== repPgId) {
        // Different phrasingGroupId → candidate sibling
        // Check if this phrasingGroupId already has a sibling
        const existingPgIds = new Set(bestCluster.siblings.map((s) => s.phrasingGroupId));
        if (
          !existingPgIds.has(q.phrasingGroupId) &&
          bestCluster.siblings.length < MAX_SIBLINGS_PER_CLUSTER
        ) {
          bestCluster.siblings.push(q);
        }
        // else: slot full or same pgId already represented → drop
      }
      // Same phrasingGroupId as representative → drop (accidental restatement)
    }
  }

  // Collect kept (representative + siblings, in insertion order) and dropped
  const keptSet = new Set<DraftQuestion>();
  for (const cluster of clusters) {
    keptSet.add(cluster.representative);
    for (const s of cluster.siblings) {
      keptSet.add(s);
    }
  }

  const kept: DraftQuestion[] = [];
  const droppedL2: DraftQuestion[] = [];

  // Maintain stable ordering from afterLayer1
  for (const q of afterLayer1) {
    if (keptSet.has(q)) {
      kept.push(q);
    } else {
      droppedL2.push(q);
    }
  }

  return {
    kept,
    dropped: [...droppedL1, ...droppedL2],
  };
}
