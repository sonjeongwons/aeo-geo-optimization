/**
 * Evidence locator — DESIGN.md §5.4 "extractMention pipeline" STEP 2.
 *
 * Finds the span in `answerText` that verifies a brand mention using
 * alias-normalized, NFC-normalized matching (NOT strict verbatim).
 *
 * Called after the LLM judge returns a verdict that claims brand_mentioned=true
 * to verify that the claim is grounded in the actual answer text.
 *
 * Also used by ruleFallback.ts for evidence window extraction.
 *
 * Pure — no IO, no pg, no @google/genai.
 */

import { findFirstOffset, normalizeForMatch } from "../domain/rank.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocatedSpan {
  quote: string;
  /** Character offset (inclusive) in the ORIGINAL answer_text. */
  start: number;
  /** Character offset (exclusive) in the ORIGINAL answer_text. */
  end: number;
}

// ---------------------------------------------------------------------------
// locateEvidence
// ---------------------------------------------------------------------------

/**
 * Locate the first alias match for the brand in `answerText`.
 *
 * Strategy:
 *   1. For each alias (canonical name first, then alternates) — NFC-normalize
 *      + lower-case both alias and answer.
 *   2. Find the earliest match among all aliases.
 *   3. Map the normalized offset back to the ORIGINAL text by character
 *      scanning (handles length-preserving NFC; see NOTE below).
 *   4. Extract a window of `windowChars` characters centred on the match for
 *      the evidence quote (or the full match if the match is shorter).
 *
 * NOTE: NFC normalization is length-preserving for the vast majority of scripts
 * (combining characters collapse). We use a length-adjusted search to handle the
 * rare case where normalized lengths differ. When offset mapping is ambiguous
 * we fall back to returning the normalized match with the normalized offsets —
 * the caller only uses the quote and offsets for display/audit purposes.
 *
 * Returns null if no alias is found.
 */
export function locateEvidence(
  answerText: string,
  aliases: string[],
  windowChars = 120
): LocatedSpan | null {
  if (!answerText || aliases.length === 0) return null;

  const normalizedAnswer = normalizeForMatch(answerText);

  // Find the alias with the earliest normalized offset.
  let bestNormOffset: number | null = null;
  let bestNormalizedAlias = "";
  let bestOriginalAlias = "";

  for (const alias of aliases) {
    if (!alias) continue;
    const normAlias = normalizeForMatch(alias);
    if (!normAlias) continue;

    const idx = normalizedAnswer.indexOf(normAlias);
    if (idx !== -1) {
      if (bestNormOffset === null || idx < bestNormOffset) {
        bestNormOffset = idx;
        bestNormalizedAlias = normAlias;
        bestOriginalAlias = alias;
      }
    }
  }

  if (bestNormOffset === null) return null;

  // Map normalized offset back to original text.
  // NFC normalization is typically length-preserving, but to be safe we
  // search for the original alias (or a close window) in the original text.
  const origOffset = mapToOriginalOffset(
    answerText,
    normalizedAnswer,
    bestNormOffset,
    bestNormalizedAlias.length,
    bestOriginalAlias
  );

  if (origOffset === null) {
    // Fallback: use normalized offsets with normalized text excerpt.
    const normEnd = bestNormOffset + bestNormalizedAlias.length;
    const windowStart = Math.max(0, bestNormOffset - Math.floor(windowChars / 2));
    const windowEnd = Math.min(normalizedAnswer.length, normEnd + Math.floor(windowChars / 2));
    return {
      quote: normalizedAnswer.slice(windowStart, windowEnd),
      start: windowStart,
      end: windowEnd,
    };
  }

  const { start: matchStart, end: matchEnd } = origOffset;

  // Build evidence window centred on the match.
  const halfWin = Math.floor(windowChars / 2);
  const winStart = Math.max(0, matchStart - halfWin);
  const winEnd = Math.min(answerText.length, matchEnd + halfWin);
  const quote = answerText.slice(winStart, winEnd);

  return { quote, start: winStart, end: winEnd };
}

// ---------------------------------------------------------------------------
// locateEvidenceForVerification
// ---------------------------------------------------------------------------

/**
 * Verify that the judge-provided evidence span is grounded in the actual
 * answer text, OR find a better-grounded span.
 *
 * DESIGN §5.4 STEP 2: "alias/NFC-normalized matching (NOT strict verbatim)".
 *
 * Algorithm:
 *   - First try to verify the judge-supplied quote via alias matching.
 *   - If judge quote is unverifiable, locate independently from aliases.
 *   - If neither locates a span, return null (triggers abstain path).
 *
 * @param answerText  The raw answer text from the provider.
 * @param aliases     All brand name/alias variants (canonical + aliases), NFC-normalized by caller ok.
 * @param judgeQuote  The quote the judge returned (may be null).
 * @param judgeStart  The start offset the judge returned (may be null).
 * @param judgeEnd    The end offset the judge returned (may be null).
 */
export function locateEvidenceForVerification(
  answerText: string,
  aliases: string[],
  judgeQuote: string | null,
  judgeStart: number | null,
  judgeEnd: number | null
): LocatedSpan | null {
  if (!answerText) return null;

  // Step A: verify the judge-provided span.
  if (
    judgeQuote !== null &&
    judgeStart !== null &&
    judgeEnd !== null &&
    judgeStart >= 0 &&
    judgeEnd > judgeStart &&
    judgeEnd <= answerText.length
  ) {
    // Check the judge's span contains an alias match (normalized).
    const spanText = answerText.slice(judgeStart, judgeEnd);
    const spanOffset = findFirstOffset(spanText, aliases);
    if (spanOffset !== null) {
      // Span is verified — return the judge's span.
      return { quote: judgeQuote, start: judgeStart, end: judgeEnd };
    }
    // The exact slice doesn't match; try alias-normalized search on the full text.
  }

  // Step B: locate independently using aliases.
  return locateEvidence(answerText, aliases);
}

// ---------------------------------------------------------------------------
// Internal: map normalized offset to original text offset
// ---------------------------------------------------------------------------

/**
 * Try to find the match position in the original (unnormalized) text.
 *
 * Returns {start, end} in original text coordinates, or null if not mappable.
 */
function mapToOriginalOffset(
  originalText: string,
  normalizedText: string,
  normOffset: number,
  normLength: number,
  originalAlias: string
): { start: number; end: number } | null {
  // Fast path: if NFC doesn't change lengths (very common), offsets are identical.
  if (originalText.length === normalizedText.length) {
    return { start: normOffset, end: normOffset + normLength };
  }

  // Slow path: scan the original text for the original alias (case-insensitive).
  const lowerOriginal = originalText.toLowerCase();
  const lowerAlias = originalAlias.toLowerCase();

  const idx = lowerOriginal.indexOf(lowerAlias);
  if (idx !== -1) {
    return { start: idx, end: idx + originalAlias.length };
  }

  // Try all aliases by NFC+lower matching within the original text.
  // Use normalized coordinates as approximation.
  const ratio = originalText.length / normalizedText.length;
  const approxStart = Math.round(normOffset * ratio);
  const approxEnd = Math.round((normOffset + normLength) * ratio);

  if (approxEnd <= originalText.length) {
    return { start: approxStart, end: approxEnd };
  }

  return null;
}

// ---------------------------------------------------------------------------
// hasLocatableEvidence
// ---------------------------------------------------------------------------

/**
 * Quick boolean check: does `answerText` contain any alias for the brand?
 * Used by guardrail gate to determine if a brand_mentioned=true verdict is grounded.
 */
export function hasLocatableEvidence(
  answerText: string | null | undefined,
  aliases: string[]
): boolean {
  if (!answerText) return false;
  return findFirstOffset(answerText, aliases) !== null;
}
