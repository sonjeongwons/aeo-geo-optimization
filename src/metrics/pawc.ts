/**
 * src/metrics/pawc.ts — "early-position word share" (Position-Adjusted Word
 * Count), from the GEO KDD'24 paper (arXiv 2311.09735, GEO-optim/GEO).
 *
 * SOTA sweep proposal (guardrail-cleared, adopt-with-modification): a single,
 * interpretable scalar in [0,1] capturing not just WHETHER the brand is named
 * but HOW MUCH of the answer — weighted toward the START — is brand text. Words
 * earlier in the answer get more weight (w(i) = 1/(1+i)); the brand's weighted
 * word share is normalized by the total weighted word mass.
 *
 * HONESTY (§7): this is a descriptive measure of word ALLOCATION + POSITION in
 * the answer text only. It is NOT a causal measure of how the brand "influenced"
 * the model, and it is NOT a citation. It complements inverse-rank Visibility;
 * it does not replace it. The composite "Influence Score" from a separate (and
 * likely-fabricated) source was deliberately NOT adopted — only this
 * paper-backed scalar, relabeled non-causally.
 *
 * PURE — no IO, no pg. Reuses the judge pipeline's alias normalization so a
 * brand "mention" here means the same thing it means everywhere else.
 */

import { normalizeForMatch } from "../domain/rank.js";

/** A token with its character span in the ORIGINAL (un-normalized) text. */
interface Token {
  start: number;
  end: number;
}

/** Tokenize on Unicode word boundaries, returning char spans. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // \p{L}\p{N} runs = words (covers Latin, Hangul, CJK-as-runs, digits).
  const re = /[\p{L}\p{N}]+/gu;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    tokens.push({ start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/**
 * Find all character ranges where a brand alias occurs in `text`.
 *
 * Matching is alias-normalized (NFC + lowercase + diacritic-fold) but offsets
 * are mapped back to the ORIGINAL text. Because normalizeForMatch is
 * length-preserving for the scripts we target (it lowercases and strips
 * combining marks after NFD/NFC round-trip without changing base-character
 * count for typical brand names), we normalize per-window for robustness and
 * fall back to original-offset alignment.
 */
function aliasRanges(text: string, normalizedAliases: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const normText = normalizeForMatch(text);
  // normalizeForMatch can change length (diacritics). When lengths match (the
  // common case for ASCII/Hangul brand names) offsets align 1:1. When they
  // differ we still detect presence but clamp the range to the alias length at
  // the found index, which is a safe approximation for a weighting scalar.
  const aligned = normText.length === text.length;
  for (const alias of normalizedAliases) {
    if (!alias) continue;
    let from = 0;
    for (;;) {
      const idx = normText.indexOf(alias, from);
      if (idx === -1) break;
      const start = aligned ? idx : Math.min(idx, text.length - 1);
      const end = aligned ? idx + alias.length : Math.min(idx + alias.length, text.length);
      ranges.push({ start, end });
      from = idx + alias.length;
    }
  }
  return ranges;
}

/** True when token [s,e) overlaps any alias range. */
function tokenIsBrand(tok: Token, ranges: Array<{ start: number; end: number }>): boolean {
  for (const r of ranges) {
    if (tok.start < r.end && r.start < tok.end) return true;
  }
  return false;
}

/**
 * Compute the early-position word share (PAWC) of the brand in an answer.
 *
 * @param answerText   Raw answer text (null/empty → 0).
 * @param brandAliases Brand canonical name + aliases (un-normalized).
 * @returns scalar in [0,1]; 0 when no brand words, →higher when the brand
 *          appears more and earlier. Position weight w(i)=1/(1+i), i = 0-based
 *          token index.
 */
export function computePawc(
  answerText: string | null | undefined,
  brandAliases: string[],
): number {
  if (!answerText || answerText.trim() === "") return 0;

  const tokens = tokenize(answerText);
  if (tokens.length === 0) return 0;

  const aliases = brandAliases.map((a) => normalizeForMatch(a)).filter((a) => a.length > 0);
  if (aliases.length === 0) return 0;

  const ranges = aliasRanges(answerText, aliases);
  if (ranges.length === 0) return 0;

  let brandWeight = 0;
  let totalWeight = 0;
  for (let i = 0; i < tokens.length; i++) {
    const w = 1 / (1 + i);
    totalWeight += w;
    if (tokenIsBrand(tokens[i]!, ranges)) brandWeight += w;
  }

  if (totalWeight <= 0) return 0;
  const pawc = brandWeight / totalWeight;
  // Numerical clamp to [0,1].
  return pawc < 0 ? 0 : pawc > 1 ? 1 : pawc;
}
