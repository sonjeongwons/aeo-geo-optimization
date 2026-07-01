/**
 * src/content/wordCount.ts
 *
 * T05 — Per-script word-count policy (134-167 band).
 *
 * PURE module — no IO, no LLM calls, deterministic.
 *
 * The §6 134-167-WORD bound is mapped to a PER-SCRIPT length band BEFORE any
 * zod refine. For space-delimited scripts (Latin/Cyrillic/etc.): whitespace-
 * token count in [134, 167]. For non-space-delimited scripts (ja/ko/zh/th): a
 * CHARACTER band derived from the English-word band via a per-script ratio
 * table.
 *
 * Per-script ratios (chars per word):
 *   ja  — 1.6–2.4 chars/word  (Japanese kanji/kana mixed, avg ~2.0)
 *   zh  — 1.6–2.0 chars/word  (Chinese, avg ~1.8)
 *   ko  — 2.0–3.0 chars/word  (Korean syllable blocks, avg ~2.5)
 *   th  — 2.0–3.0 chars/word  (Thai, similar syllable density, avg ~2.5)
 *
 * Character band formula:
 *   min_chars = floor(MIN_WORDS * ratio_low)
 *   max_chars = ceil(MAX_WORDS * ratio_high)
 *
 * References:
 *   DESIGN-phase2.md §"Variant Pipeline" / "STAGE C"
 *   SPEC.md §6
 *   phase2-tasks.json T05
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lower bound of the §6 word count band (inclusive). */
const MIN_WORDS = 134;

/** Upper bound of the §6 word count band (inclusive). */
const MAX_WORDS = 167;

/**
 * Per-script character ratio range [low, high] chars-per-word.
 * Used to derive the character-band equivalents for non-space-delimited scripts.
 */
const SCRIPT_CHAR_RATIOS: Record<string, { low: number; high: number }> = {
  ja: { low: 1.6, high: 2.4 },
  zh: { low: 1.6, high: 2.0 },
  ko: { low: 2.0, high: 3.0 },
  th: { low: 2.0, high: 3.0 },
};

/**
 * Scripts that use character counting instead of whitespace-token counting.
 * BCP-47 primary language subtags.
 */
const CHAR_COUNT_SCRIPTS = new Set(["ja", "zh", "ko", "th"]);

// ---------------------------------------------------------------------------
// Script detection helpers
// ---------------------------------------------------------------------------

/**
 * Extract the primary language subtag from a BCP-47 tag (e.g. 'zh-TW' → 'zh').
 */
function primarySubtag(language: string): string {
  return (language.split("-")[0] ?? language).toLowerCase();
}

/**
 * Returns true if the given BCP-47 language tag uses character counting.
 */
function usesCharacterCounting(language: string): boolean {
  return CHAR_COUNT_SCRIPTS.has(primarySubtag(language));
}

// ---------------------------------------------------------------------------
// Character band for a given script
// ---------------------------------------------------------------------------

export interface CharBand {
  /** Inclusive lower bound (character count). */
  minChars: number;
  /** Inclusive upper bound (character count). */
  maxChars: number;
}

/**
 * Compute the character-count band for a non-space-delimited script.
 * Returns null if the language uses word counting (space-delimited).
 *
 * @param language - BCP-47 language tag.
 */
export function getCharBand(language: string): CharBand | null {
  const sub = primarySubtag(language);
  const ratio = SCRIPT_CHAR_RATIOS[sub];
  if (!ratio) return null;
  return {
    minChars: Math.floor(MIN_WORDS * ratio.low),
    maxChars: Math.ceil(MAX_WORDS * ratio.high),
  };
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Compute the per-script "length units" for a text in a given language.
 *
 * - Space-delimited scripts (Latin/Cyrillic/etc.): count whitespace-delimited
 *   tokens (words).
 * - Non-space-delimited scripts (ja/ko/zh/th): count Unicode code points,
 *   excluding whitespace and ASCII punctuation. This produces a character count
 *   comparable to the ratio-derived band.
 *
 * This function is PURE and NEVER calls an LLM.
 *
 * @param text     - The asset body text to measure.
 * @param language - BCP-47 language tag.
 * @returns        Integer length-unit count.
 */
export function computeLengthUnits(text: string, language: string): number {
  if (!text) return 0;

  if (usesCharacterCounting(language)) {
    // Character counting: count Unicode code points, stripping ASCII
    // whitespace and ASCII punctuation so the measure tracks meaningful
    // characters rather than formatting noise.
    const codepoints = [...text];
    let count = 0;
    for (const cp of codepoints) {
      const code = cp.codePointAt(0) ?? 0;
      // Skip ASCII whitespace (U+0000–U+0020)
      if (code <= 0x20) continue;
      count++;
    }
    return count;
  }

  // Word counting: split on whitespace runs
  const tokens = text.trim().split(/\s+/u);
  // Empty string edge case
  if (tokens.length === 1 && tokens[0] === "") return 0;
  return tokens.length;
}

/**
 * Returns true if the text's per-script length falls within the §6 134-167 band
 * (translated to per-script units).
 *
 * - For space-delimited scripts: word count in [134, 167].
 * - For non-space-delimited scripts: character count in [minChars, maxChars]
 *   derived from the per-script ratio table.
 *
 * This function is PURE and NEVER calls an LLM.
 *
 * @param text     - The asset body text.
 * @param language - BCP-47 language tag.
 * @returns        true if the text is within the band, false otherwise.
 */
export function lengthInBand(text: string, language: string): boolean {
  const units = computeLengthUnits(text, language);

  if (usesCharacterCounting(language)) {
    const band = getCharBand(language);
    if (!band) {
      // Fallback: treat as word-count (shouldn't happen for known scripts)
      return units >= MIN_WORDS && units <= MAX_WORDS;
    }
    return units >= band.minChars && units <= band.maxChars;
  }

  // Word-count band
  return units >= MIN_WORDS && units <= MAX_WORDS;
}

// ---------------------------------------------------------------------------
// Exported constants (for gate use)
// ---------------------------------------------------------------------------

/** Lower word count bound for the §6 band. */
export const ANSWER_BLOCK_MIN_WORDS = MIN_WORDS;

/** Upper word count bound for the §6 band. */
export const ANSWER_BLOCK_MAX_WORDS = MAX_WORDS;
