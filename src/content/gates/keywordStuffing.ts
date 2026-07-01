/**
 * src/content/gates/keywordStuffing.ts
 *
 * X22(b) (SOTA sweep v5) — keywordStuffingGate: a deterministic NEGATIVE-CONTROL
 * content gate. Keyword stuffing (unnatural over-repetition of a term to game
 * ranking) is a spam signal that answer engines penalize and that violates the
 * §7 "no manipulation" discipline. This gate BLOCKs owned-net drafts whose prose
 * concentrates a single significant term far above natural density.
 *
 * CONSERVATIVE BY DESIGN — false positives cut yield, so the gate fires only on
 * EGREGIOUS concentration, never on merely dense technical copy:
 *   - judged only on prose with >= MIN_SIGNIFICANT_TOKENS significant tokens
 *     (short FAQ answers can't trip it);
 *   - a term must BOTH occur >= MIN_OCCURRENCES times AND exceed MAX_DENSITY of
 *     the significant-token stream — so 8 repeats in 1,000 tokens (0.8%) is fine,
 *     but 8 repeats in 120 tokens (6.7%) is stuffing;
 *   - stopwords, short tokens (< 4 chars), and pure-numeric tokens are excluded;
 *   - the thresholds are DISCLOSED HEURISTICS (not empirically calibrated on EMORA
 *     data); they are deliberately lax to avoid penalizing legitimate copy.
 *
 * NB: the brand name legitimately recurs in owned content, but stuffing the brand
 * name IS itself a spam pattern, so it is not specially exempted — the lax
 * threshold is what protects normal brand repetition from being flagged.
 *
 * PURE: no I/O, no LLM, no network. Deterministic. Block-only on a match.
 *
 * Node 22 ESM NodeNext — relative imports use the .js extension.
 */

import type {
  ContentAsset,
  ContentGateContext,
  ContentGateResult,
} from "../types.js";

// Disclosed heuristic thresholds (not empirically calibrated — see header).
const MIN_SIGNIFICANT_TOKENS = 50;
const MIN_OCCURRENCES = 8;
const MAX_DENSITY = 0.05; // a single term may not exceed 5% of significant tokens

/**
 * Small high-frequency stopword set. Stopwords are excluded from stuffing
 * detection because their natural density is high and varies by language; we
 * only judge content-bearing terms.
 */
const STOPWORDS = new Set([
  "this", "that", "these", "those", "with", "from", "your", "their", "they",
  "them", "have", "has", "had", "will", "would", "shall", "should", "could",
  "and", "the", "for", "are", "but", "not", "you", "can", "all", "any", "our",
  "its", "it's", "into", "than", "then", "there", "here", "when", "what",
  "which", "while", "also", "more", "most", "such", "some", "each", "other",
  "about", "over", "under", "between", "because", "been", "being", "were",
  "was", "does", "did", "doing", "done", "how", "why", "who", "whom", "whose",
]);

/** Extract scannable prose from the asset body. Returns "" for jsonld. */
function extractProse(asset: ContentAsset): string {
  const body = asset.body;
  switch (body.content_type) {
    case "definition":
      return body.text;
    case "answer_block":
      return body.text;
    case "faq":
      return body.rows.map((r) => `${r.q} ${r.a}`).join(" ");
    case "comparison": {
      const rows = body.rows
        .map((r) => `${r.entity} ${r.cells.map((c) => c.value).join(" ")}`)
        .join(" ");
      return `${body.columns.join(" ")} ${rows}`;
    }
    case "case_study":
      return [body.situation, body.action, body.result].join(" ");
    case "jsonld":
      return "";
  }
}

/** CJK script runs (Han / Hiragana / Katakana / Hangul) — no whitespace to split. */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * Tokenize into significant terms. Latin/digit words must be >=4 chars and not a
 * stopword/number. CJK has no word delimiters, so each CJK run is turned into
 * overlapping CHARACTER BIGRAMS — over-repeating a CJK term (e.g. a brand) then
 * shows up as a high-frequency bigram, letting the density check fire on KR/JP
 * content too (sweep v6 Y3). PURE.
 */
function significantTokens(prose: string): string[] {
  const latin = (prose.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(
    (t) => t.length >= 4 && !STOPWORDS.has(t) && !/^[0-9]+$/.test(t),
  );
  const cjk: string[] = [];
  for (const run of prose.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      cjk.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) cjk.push(run.slice(i, i + 2));
  }
  return [...latin, ...cjk];
}

export interface StuffingFinding {
  term: string;
  count: number;
  density: number; // count / total significant tokens
}

/**
 * Find the most-concentrated significant term, if it crosses BOTH thresholds.
 * PURE. Returns null when the prose is too short to judge or nothing is egregious.
 */
export function findKeywordStuffing(prose: string): StuffingFinding | null {
  const tokens = significantTokens(prose);
  const total = tokens.length;
  if (total < MIN_SIGNIFICANT_TOKENS) return null;

  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);

  let worst: StuffingFinding | null = null;
  for (const [term, count] of counts) {
    if (count < MIN_OCCURRENCES) continue;
    const density = count / total;
    if (density <= MAX_DENSITY) continue;
    if (worst === null || density > worst.density) {
      worst = { term, count, density };
    }
  }
  return worst;
}

export const keywordStuffingGate = {
  name: "keywordStuffingGate",
  phase: "content" as const,

  apply(ctx: ContentGateContext): ContentGateResult {
    const finding = findKeywordStuffing(extractProse(ctx.asset));
    if (finding === null) {
      return { action: "pass", gate: "keywordStuffingGate" };
    }
    const pct = (finding.density * 100).toFixed(1);
    return {
      action: "block",
      gate: "keywordStuffingGate",
      reason:
        `keyword stuffing — term "${finding.term}" repeats ${finding.count}× ` +
        `(${pct}% of significant tokens, over the ${(MAX_DENSITY * 100).toFixed(0)}% floor); ` +
        `rewrite for natural density.`,
    };
  },
} satisfies {
  name: string;
  phase: "content";
  apply(ctx: ContentGateContext): ContentGateResult;
};
