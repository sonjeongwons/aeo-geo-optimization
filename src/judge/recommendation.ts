/**
 * src/judge/recommendation.ts — deterministic RECOMMENDATION detection (SOTA v2 R1).
 *
 * Three tiers of brand presence in an AI answer, each a strict subset of the last:
 *   MENTION  ⊇ CITATION ⊇ RECOMMENDATION
 * A MENTION is the brand named; a CITATION is the brand as a linked source; a
 * RECOMMENDATION is the answer affirmatively ADVISING the brand (a "best/top/
 * recommended" list item, or a recommend-verb whose object is the brand). The
 * commercial gap is large: a brand can be cited as a source yet NOT recommended
 * (industry write-ups put the omitted-from-recommendation share near two-thirds).
 * So the engine measures recommendation as its own conservative channel.
 *
 * CONSERVATIVE BY DEFAULT (same discipline as citation.ts): only fire on
 * UNAMBIGUOUS positive constructs, and SUPPRESS on a preceding negation/hedge or
 * a contrastive scope ("but/however/though"). When in doubt, do NOT count it —
 * over-counting overstates the very metric being sold. recommendationShare is a
 * deterministic LOWER BOUND, not a precise semantic judgment.
 *
 * PURE — no IO, no pg, no @google/genai.
 */

import { normalizeForMatch } from "../domain/rank.js";

export interface RecommendationDetection {
  present: boolean;
  /** The span that constitutes the recommendation (list item / sentence). Null if none. */
  quote: string | null;
  /** Which construct fired: 'list' | 'verb' | null. */
  kind: "list" | "verb" | null;
}

const NONE: RecommendationDetection = { present: false, quote: null, kind: null };

// Recommend-verbs whose object can be the brand (affirmative advice).
const RECO_VERBS = [
  "recommend",
  "recommended",
  "suggest",
  "i'd suggest",
  "we suggest",
  "go with",
  "opt for",
  "your best bet",
  "the best choice",
  "top pick",
  "our pick",
  "best option",
  "ideal choice",
  "great choice",
  "worth choosing",
  "a strong choice",
];

// List-header cues that make following items recommendations.
const LIST_HEADERS = [
  "best",
  "top",
  "recommended",
  "leading options",
  "our picks",
  "top picks",
  "great options",
  "best options",
  "top choices",
];

// Negation / hedge cues that SUPPRESS a recommendation if they scope the brand.
// Straight-apostrophe forms suffice: normalizeForMatch folds curly → ASCII '
// before this regex runs (SOTA v5 self-audit X6). Apostrophe-less forms cover
// model output that drops the apostrophe entirely.
const NEGATION = /\b(?:not|never|avoid|isn't|isnt|wouldn't|wouldnt|would not|don't|dont|do not|can't|cant|cannot|no longer|instead of|rather than|unlike|except)\b/;
const CONTRAST = /\b(?:but|however|though|although|whereas|that said|on the other hand)\b/;

/** Find `needle` in `hay` delimited by non-[a-z0-9] chars (or string edges). */
function boundedIncludes(hay: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : hay[i - 1]!;
    const after = i + needle.length >= hay.length ? "" : hay[i + needle.length]!;
    if ((before === "" || !/[a-z0-9]/.test(before)) && (after === "" || !/[a-z0-9]/.test(after))) return true;
    from = i + 1;
  }
}

/**
 * True when haystack contains any normalized brand alias as a BOUNDED token
 * (not a substring of a larger word) — fixes over-firing on e.g. an alias buried
 * inside another word (SOTA v4 self-audit bug fix).
 */
function hasAlias(haystack: string, aliases: string[]): boolean {
  if (!haystack) return false;
  const norm = normalizeForMatch(haystack);
  return aliases.some((a) => boundedIncludes(norm, a));
}

/** Remove quoted spans so a recommendation INSIDE a quotation does not count. */
function stripQuoted(s: string): string {
  return s
    .replace(/"[^"]*"/g, " ")
    // Straight single quotes: only strip a span whose delimiters sit on word
    // boundaries, so CONTRACTION/possessive apostrophes ("I'd … it's") are NOT
    // treated as a quoted span — that over-match erased the brand+verb and
    // produced false-negative recommendations (sweep v6 Y2).
    .replace(/(^|[^A-Za-z0-9])'([^']*)'(?=[^A-Za-z0-9]|$)/g, "$1 ")
    .replace(/[“”][^“”]*[“”]/g, " ")
    .replace(/[‘’][^‘’]*[‘’]/g, " ")
    .replace(/「[^」]*」/g, " ");
}

// Self-promo attribution verbs — when the BRAND is the subject ("EMORA markets
// itself as the best…"), it's the brand promoting itself, not a recommendation.
const SELF_ATTR = /(markets?|claims?|positions?|describes?|bills?|advertises?|promotes?|calls?|brands?)\s+(itself|themselves|it)\b/;

/**
 * Split into list lines + sentences for scoping. Splits on newlines first (so
 * markdown/numbered list items stay intact), then on sentence punctuation ONLY
 * when it follows a LETTER — so a list marker like "1." or "2)" is NOT split off
 * from its content.
 */
function segments(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    for (const part of t.split(/(?<=[\p{L}][.!?])\s+/u)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Detect whether the answer affirmatively RECOMMENDS the brand.
 * Requires the brand to be mentioned (recommendation ⊆ mention).
 *
 * @param answerText   Raw answer text (null/empty → none).
 * @param brandAliases Brand canonical name + aliases (un-normalized).
 */
export function detectRecommendation(
  answerText: string | null | undefined,
  brandAliases: string[],
): RecommendationDetection {
  if (!answerText || answerText.trim() === "") return NONE;
  const aliases = brandAliases.map((a) => normalizeForMatch(a)).filter((a) => a.length > 0);
  if (aliases.length === 0) return NONE;
  if (!hasAlias(answerText, aliases)) return NONE; // recommendation ⊆ mention

  const segs = segments(answerText);

  // --- (1) Markdown / numbered list items under a "best/top/recommended" framing ---
  // A list item naming the brand counts when the document framing is recommendational.
  const docNorm = normalizeForMatch(answerText);
  // Bounded match: short headers ("best","top","recommended") must be standalone
  // words, not substrings of "asbestos","laptop","desktop","topic" (SOTA v5
  // self-audit X2). Spaces are boundaries, so multi-word headers still match.
  const listFramed = LIST_HEADERS.some((h) => boundedIncludes(docNorm, normalizeForMatch(h)));
  if (listFramed) {
    for (const seg of segs) {
      const isListItem = /^(?:[-*•]|\d+[.)]|#{1,3}\s)/.test(seg) || /^(?:best|top|recommended)\b/i.test(seg);
      if (!isListItem) continue;
      const clean = stripQuoted(seg); // a recommendation inside a quote doesn't count
      if (!hasAlias(clean, aliases)) continue;
      const segNorm = normalizeForMatch(clean);
      if (NEGATION.test(segNorm)) continue; // suppressed
      if (SELF_ATTR.test(segNorm)) continue; // brand promoting itself
      return { present: true, quote: seg.slice(0, 200), kind: "list" };
    }
  }

  // --- (2) Affirmative recommend-verb whose object/subject is the brand ---
  for (const seg of segs) {
    const clean = stripQuoted(seg);
    if (!hasAlias(clean, aliases)) continue;
    const segNorm = normalizeForMatch(clean);
    // Bounded verb match — RECO_VERBS must not match as substrings of larger words.
    const verbHit = RECO_VERBS.find((v) => boundedIncludes(segNorm, normalizeForMatch(v)));
    if (!verbHit) continue;
    // Brand promoting ITSELF is not a recommendation ("EMORA markets itself as…").
    if (SELF_ATTR.test(segNorm)) continue;
    if (NEGATION.test(segNorm)) {
      // Suppress only when the negation precedes the brand alias (scopes it).
      const negIdx = segNorm.search(NEGATION);
      const aliasIdx = Math.min(...aliases.map((a) => { const i = segNorm.indexOf(a); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }));
      if (negIdx >= 0 && negIdx < aliasIdx) continue; // "not … EMORA" → suppressed
    }
    // Honor the contrastive pivot (was dormant): suppress when a contrast pivot
    // is FOLLOWED by a negation that flips the brand to the negative side
    // ("EMORA is the top pick, but it's not good").
    if (CONTRAST.test(segNorm)) {
      const cIdx = segNorm.search(CONTRAST);
      const tail = segNorm.slice(cIdx);
      if (NEGATION.test(tail)) continue;
    }
    return { present: true, quote: seg.slice(0, 200), kind: "verb" };
  }

  return NONE;
}
