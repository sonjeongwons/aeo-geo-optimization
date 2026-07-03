/**
 * src/content/numericDetect.ts
 *
 * Shared script-aware numeric token detector used by:
 *   - claimVerify.ts  (backstop scanner)
 *   - gates/verifiableNumbers.ts  (GB-02: body scan for ALL content types)
 *   - gates/jsonLdShape.ts  (GB-01/GB-03: nested JSON-LD text scan)
 *
 * DESIGN-phase2.md §"Claim Verification (§7#7)" — BACKSTOP requirement:
 * "every numeric token in body MUST appear in claims[] as a numeric ClaimRecord"
 *
 * GB-01 fix: the old ASCII-only /\d.../ regex could not detect:
 *   - Fullwidth digits  ０１２３４５６７８９  (U+FF10–FF19)
 *   - Arabic-Indic digits ٠١٢٣٤٥٦٧٨٩  (U+0660–U+0669)
 *   - Devanagari/Bengali/etc. via Unicode Nd class  (\p{Nd} with u flag)
 *   - CJK numeral characters 一二三四五六七八九十百千万億〇
 *   - Number-words in en/ja/ko/zh ("fifty percent", "五〇パーセント")
 *
 * This module:
 *   1. NFKC-normalizes body text (converts fullwidth ５ → 5, ％ → %, etc.)
 *      before scanning so a single regex handles most script variants.
 *   2. Uses the `u` flag + \p{Nd} to catch Devanagari/Arabic-Indic/etc. digits
 *      that survive NFKC normalization (they remain Nd, not mapped to ASCII).
 *   3. Explicitly lists CJK numeral chars (一二三四五六七八九十百千万億〇)
 *      which are NOT in \p{Nd} and are NOT fullwidth (not mapped by NFKC).
 *   4. Provides per-language number-word lexicons (seed: en/ja/ko/zh)
 *      so words like "fifty", "五十" that are neither digits nor CJK ideographs
 *      but still represent numeric claims are caught.
 *
 * Returns { text, span } hits on the ORIGINAL (pre-normalisation) body string
 * because spans must correlate back to ClaimRecord.span.
 *
 * PURE: no I/O, no LLM, no network.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

// ---------------------------------------------------------------------------
// CJK numeral character set
// These are ideographic numerals NOT covered by \p{Nd} and NOT fullwidth
// so NFKC does not convert them to ASCII digits.
// ---------------------------------------------------------------------------

const CJK_NUMERAL_CHARS = new Set([
  "〇", "一", "二", "三", "四", "五", "六", "七", "八", "九",
  "十", "百", "千", "万", "億",
]);

/**
 * Build a regex that matches a run of CJK numeral characters
 * (at least one).  E.g. "五〇" or "十五" or "百万".
 */
const CJK_NUMERAL_REGEX = /[〇一二三四五六七八九十百千万億]+/gu;

// ---------------------------------------------------------------------------
// Number-word lexicons per language (seed; extendable)
// Each entry is a word/phrase whose presence constitutes a numeric claim.
// For non-CJK languages: lower-cased; matched with word-boundary logic.
// For CJK: substring match (no word boundaries).
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, readonly string[]> = {
  en: [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty",
    "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred",
    "thousand", "million", "billion", "trillion",
    "half", "quarter", "third", "double", "triple",
    "twofold", "threefold", "fourfold", "fivefold",
    "once", "twice", "thrice",
    "percent", "percentage",
  ],
  ja: [
    // Arabic-script number words used in Japanese copy.
    // NOTE: single-char ratio units 倍/割 are DELIBERATELY excluded here — they
    // collide with common words and the digit+unit forms ("2倍", "3割") are
    // already caught by DIGIT_REGEX (倍/割 are in its unit list). Listing them as
    // standalone number-words caused false-positive numeric blocks on ordinary
    // prose. Multi-char units like パーセント stay (low collision).
    "パーセント",
    // Note: CJK ideographic numerals (一二三...) are caught by CJK_NUMERAL_REGEX
    // Number-like phrases
    "数百", "数千", "数万", "数億",
  ],
  ko: [
    // "배"(ship/pear/stomach) and "할"(verb ending 확인할/구성할) collide with
    // very common Korean words → excluded as standalone. Digit forms "2배"/"3할"
    // are still caught by DIGIT_REGEX. This fixed false-positive numeric blocks
    // on clean capability prose (e.g. "…확인할 수 있습니다").
    "퍼센트",
    "수백", "수천", "수만", "수억",
  ],
  zh: [
    // 倍/成 excluded (collide with 成=become etc.); digit forms caught by DIGIT_REGEX.
    "百分之",
    "数百", "数千", "数万", "数亿",
  ],
};

// ---------------------------------------------------------------------------
// Core regex — matches numeric tokens across scripts after NFKC normalization
// ---------------------------------------------------------------------------

/**
 * Pattern covers (after NFKC normalization):
 *   - ASCII digits (from NFKC-mapped fullwidth, or original ASCII)
 *     with optional comma separators and decimal point
 *   - \p{Nd} for Devanagari/Arabic-Indic/etc. digit scripts
 *   - Followed optionally by unit-like suffixes (%, x, k, m, b, ms, etc.)
 *   - Hash-prefixed rank tokens (#1, #2, ...)
 *
 * The `u` flag is required for \p{Nd}.
 */
const SCRIPT_NUMERIC_REGEX =
  /(?:#[\p{Nd}]+|[\p{Nd}][\p{Nd},]*(?:\.[\p{Nd}]+)?(?:\s*(?:million|billion|trillion|thousand|k|m|b|x|%|ms|s|px|users|stars|languages|percent|倍|割|배|퍼센트|パーセント))?)/giu;

// ---------------------------------------------------------------------------
// NFKC normalization helper
// ---------------------------------------------------------------------------

/**
 * NFKC-normalize text.
 * Converts fullwidth digits/punctuation to ASCII equivalents:
 *   ５ → 5,  ％ → %,  （ → (,  etc.
 * Does NOT convert CJK ideographic numerals (they have no NFKC decomposition
 * to ASCII digits).
 */
function nfkcNormalize(text: string): string {
  return text.normalize("NFKC");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A detected numeric token in the original body text.
 */
export interface NumericHit {
  /** The matched text (from the original, pre-normalization body). */
  text: string;
  /** Character-offset span [start, end) in the original body. */
  span: { start: number; end: number };
  /** Source of detection: 'digit' | 'cjk_numeral' | 'number_word' */
  kind: "digit" | "cjk_numeral" | "number_word";
}

/**
 * Scan body text for numeric tokens across all supported scripts.
 *
 * Strategy:
 * 1. NFKC-normalize a shadow copy for digit regex (fullwidth → ASCII, etc.).
 *    All regex offsets on the normalized copy map 1:1 to the original because
 *    NFKC does NOT change string length for the characters we care about
 *    (fullwidth Latin/digit chars decompose to single ASCII chars — same length).
 * 2. Run the script-aware digit regex over the normalized copy.
 * 3. Run the CJK numeral regex over the original (CJK ideographs are not normalized).
 * 4. Run per-language number-word scan over the original.
 *
 * Returns deduplicated, sorted hits.
 *
 * @param bodyText   Raw body text (original encoding).
 * @param language   BCP-47 language tag (drives number-word lexicon).
 */
export function scanNumerics(
  bodyText: string,
  language = "en"
): NumericHit[] {
  const hits: NumericHit[] = [];

  // ---- 1. Digit scan on NFKC-normalized shadow ----
  const normalized = nfkcNormalize(bodyText);

  // Verify length parity (required for offset mapping).
  // NFKC CAN change length for some exotic chars; if so, fall back to original.
  const useShadow = normalized.length === bodyText.length;
  const scanTarget = useShadow ? normalized : bodyText;

  SCRIPT_NUMERIC_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_NUMERIC_REGEX.exec(scanTarget)) !== null) {
    if (match[0] !== undefined && match[0].trim().length > 0) {
      const start = match.index;
      const end = start + match[0].length;
      hits.push({
        text: bodyText.slice(start, end),  // return original text, not normalized
        span: { start, end },
        kind: "digit",
      });
    }
  }

  // ---- 2. CJK numeral scan on original text ----
  CJK_NUMERAL_REGEX.lastIndex = 0;
  while ((match = CJK_NUMERAL_REGEX.exec(bodyText)) !== null) {
    if (match[0] !== undefined) {
      const start = match.index;
      const end = start + match[0].length;
      // Skip if already covered by a digit hit (shouldn't overlap, but defensive)
      const alreadyCovered = hits.some(
        (h) => h.span.start <= start && end <= h.span.end
      );
      if (!alreadyCovered) {
        hits.push({
          text: match[0],
          span: { start, end },
          kind: "cjk_numeral",
        });
      }
    }
  }

  // ---- 3. Number-word scan ----
  const lang = language.split("-")[0]?.toLowerCase() ?? "en";
  const words = NUMBER_WORDS[lang] ?? NUMBER_WORDS["en"] ?? [];
  const isCjk = lang === "ja" || lang === "ko" || lang === "zh";

  if (isCjk) {
    // Substring search — no word boundaries in CJK
    for (const word of words) {
      let idx = 0;
      while (true) {
        const pos = bodyText.indexOf(word, idx);
        if (pos === -1) break;
        const end = pos + word.length;
        const alreadyCovered = hits.some(
          (h) => h.span.start <= pos && end <= h.span.end
        );
        if (!alreadyCovered) {
          hits.push({
            text: word,
            span: { start: pos, end },
            kind: "number_word",
          });
        }
        idx = pos + 1;
      }
    }
  } else {
    // Word-boundary search (case-insensitive)
    const lowerBody = bodyText.toLowerCase();
    for (const word of words) {
      const lowerWord = word.toLowerCase();
      let idx = 0;
      while (true) {
        const pos = lowerBody.indexOf(lowerWord, idx);
        if (pos === -1) break;
        // Word boundary: char before and after must be non-alphanumeric
        const before = pos > 0 ? lowerBody[pos - 1] : " ";
        const after =
          pos + lowerWord.length < lowerBody.length
            ? lowerBody[pos + lowerWord.length]
            : " ";
        const beforeOk = before === undefined || !/[a-z0-9]/.test(before);
        const afterOk = after === undefined || !/[a-z0-9]/.test(after);
        if (beforeOk && afterOk) {
          const end = pos + word.length;
          const alreadyCovered = hits.some(
            (h) => h.span.start <= pos && end <= h.span.end
          );
          if (!alreadyCovered) {
            hits.push({
              text: bodyText.slice(pos, end),
              span: { start: pos, end },
              kind: "number_word",
            });
          }
        }
        idx = pos + 1;
      }
    }
  }

  // Sort by start offset for deterministic output
  hits.sort((a, b) => a.span.start - b.span.start);

  return hits;
}

/**
 * Simplified wrapper returning {text, span} (no kind field) for backwards
 * compatibility with the existing backstop-hit shape used in claimVerify.ts
 * and the gate scanner in verifiableNumbers.ts / jsonLdShape.ts.
 */
export function scanBodyForNumerics(
  bodyText: string,
  language = "en"
): Array<{ text: string; span: { start: number; end: number } }> {
  return scanNumerics(bodyText, language);
}
