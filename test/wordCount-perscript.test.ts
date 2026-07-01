/**
 * test/wordCount-perscript.test.ts
 *
 * T05 — Per-script word-count policy (134-167 band) tests.
 *
 * Acceptance criteria from phase2-tasks.json T05:
 *   1. A 150-word English block passes.
 *   2. A 10-char Korean block fails.
 *   3. A ~300-char Korean block (in-band) passes.
 *   4. computeLengthUnits is deterministic and never calls an LLM.
 *
 * Also tests:
 *   - Japanese character band
 *   - Chinese character band
 *   - Thai character band
 *   - Under-band English fails
 *   - Over-band English fails
 *   - BCP-47 subtag handling (e.g. 'zh-TW', 'zh-CN')
 */

import { describe, it, expect } from "vitest";
import {
  computeLengthUnits,
  lengthInBand,
  getCharBand,
  ANSWER_BLOCK_MIN_WORDS,
  ANSWER_BLOCK_MAX_WORDS,
} from "../src/content/wordCount.js";

// ---------------------------------------------------------------------------
// Helper: build a string of N space-delimited words
// ---------------------------------------------------------------------------
function buildWords(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
}

// ---------------------------------------------------------------------------
// Helper: build a string of N Korean characters (한글 syllables)
// ---------------------------------------------------------------------------
function buildKoreanChars(n: number): string {
  // 가 (U+AC00) through 힣 — use a simple repeating syllable
  return "가".repeat(n);
}

// ---------------------------------------------------------------------------
// Helper: build a string of N Japanese characters (hiragana)
// ---------------------------------------------------------------------------
function buildJapaneseChars(n: number): string {
  return "あ".repeat(n);
}

// ---------------------------------------------------------------------------
// Helper: build a string of N Chinese characters
// ---------------------------------------------------------------------------
function buildChineseChars(n: number): string {
  return "的".repeat(n);
}

// ---------------------------------------------------------------------------
// Constants verification
// ---------------------------------------------------------------------------

describe("word-count constants", () => {
  it("exports MIN_WORDS = 134 and MAX_WORDS = 167", () => {
    expect(ANSWER_BLOCK_MIN_WORDS).toBe(134);
    expect(ANSWER_BLOCK_MAX_WORDS).toBe(167);
  });
});

// ---------------------------------------------------------------------------
// English (space-delimited) tests
// ---------------------------------------------------------------------------

describe("computeLengthUnits — English (word count)", () => {
  it("counts 150 words correctly", () => {
    const text = buildWords(150);
    expect(computeLengthUnits(text, "en")).toBe(150);
  });

  it("counts 134 words correctly (lower bound)", () => {
    const text = buildWords(134);
    expect(computeLengthUnits(text, "en")).toBe(134);
  });

  it("counts 167 words correctly (upper bound)", () => {
    const text = buildWords(167);
    expect(computeLengthUnits(text, "en")).toBe(167);
  });

  it("counts 10 words correctly", () => {
    const text = buildWords(10);
    expect(computeLengthUnits(text, "en")).toBe(10);
  });

  it("handles empty string", () => {
    expect(computeLengthUnits("", "en")).toBe(0);
  });

  it("handles single word", () => {
    expect(computeLengthUnits("hello", "en")).toBe(1);
  });

  it("collapses multiple spaces", () => {
    // "hello   world" should count as 2 words
    expect(computeLengthUnits("hello   world", "en")).toBe(2);
  });

  it("is deterministic — same input always yields same output", () => {
    const text = buildWords(150);
    const a = computeLengthUnits(text, "en");
    const b = computeLengthUnits(text, "en");
    expect(a).toBe(b);
  });
});

describe("lengthInBand — English", () => {
  it("150-word English block is in-band (passes)", () => {
    // Acceptance criterion 1: a 150-word English block passes
    const text = buildWords(150);
    expect(lengthInBand(text, "en")).toBe(true);
  });

  it("134-word English block is at lower bound (passes)", () => {
    expect(lengthInBand(buildWords(134), "en")).toBe(true);
  });

  it("167-word English block is at upper bound (passes)", () => {
    expect(lengthInBand(buildWords(167), "en")).toBe(true);
  });

  it("133-word English block is below lower bound (fails)", () => {
    expect(lengthInBand(buildWords(133), "en")).toBe(false);
  });

  it("168-word English block is above upper bound (fails)", () => {
    expect(lengthInBand(buildWords(168), "en")).toBe(false);
  });

  it("10-word English block fails", () => {
    expect(lengthInBand(buildWords(10), "en")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Korean (character count) tests
// ---------------------------------------------------------------------------

describe("getCharBand — Korean", () => {
  it("returns a character band for Korean", () => {
    const band = getCharBand("ko");
    expect(band).not.toBeNull();
    // min = floor(134 * 2.0) = 268, max = ceil(167 * 3.0) = 501
    expect(band!.minChars).toBe(268);
    expect(band!.maxChars).toBe(501);
  });
});

describe("computeLengthUnits — Korean (character count)", () => {
  it("counts 10 Korean characters as 10 units", () => {
    // Acceptance criterion 2: 10-char Korean block — we just confirm the count
    expect(computeLengthUnits(buildKoreanChars(10), "ko")).toBe(10);
  });

  it("counts 300 Korean characters as 300 units", () => {
    expect(computeLengthUnits(buildKoreanChars(300), "ko")).toBe(300);
  });

  it("strips whitespace from character count", () => {
    // whitespace should not be counted
    const textWithSpaces = "가 나 다"; // 3 characters + 2 spaces
    expect(computeLengthUnits(textWithSpaces, "ko")).toBe(3);
  });
});

describe("lengthInBand — Korean", () => {
  it("10-char Korean block fails (below band)", () => {
    // Acceptance criterion 2: a 10-char Korean block fails
    expect(lengthInBand(buildKoreanChars(10), "ko")).toBe(false);
  });

  it("~300-char Korean block is in-band (passes)", () => {
    // Acceptance criterion 3: a ~300-char Korean block passes
    // Band: 268–501 chars; 300 is within range
    expect(lengthInBand(buildKoreanChars(300), "ko")).toBe(true);
  });

  it("267-char Korean block is below band (fails)", () => {
    expect(lengthInBand(buildKoreanChars(267), "ko")).toBe(false);
  });

  it("502-char Korean block is above band (fails)", () => {
    expect(lengthInBand(buildKoreanChars(502), "ko")).toBe(false);
  });

  it("268-char Korean block is at lower bound (passes)", () => {
    expect(lengthInBand(buildKoreanChars(268), "ko")).toBe(true);
  });

  it("501-char Korean block is at upper bound (passes)", () => {
    expect(lengthInBand(buildKoreanChars(501), "ko")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Japanese (character count) tests
// ---------------------------------------------------------------------------

describe("getCharBand — Japanese", () => {
  it("returns a character band for Japanese", () => {
    const band = getCharBand("ja");
    expect(band).not.toBeNull();
    // min = floor(134 * 1.6) = 214, max = ceil(167 * 2.4) = 401
    expect(band!.minChars).toBe(214);
    expect(band!.maxChars).toBe(401);
  });
});

describe("lengthInBand — Japanese", () => {
  it("10-char Japanese block fails", () => {
    expect(lengthInBand(buildJapaneseChars(10), "ja")).toBe(false);
  });

  it("250-char Japanese block passes", () => {
    // 250 is within [214, 401]
    expect(lengthInBand(buildJapaneseChars(250), "ja")).toBe(true);
  });

  it("214-char Japanese block passes (at lower bound)", () => {
    expect(lengthInBand(buildJapaneseChars(214), "ja")).toBe(true);
  });

  it("401-char Japanese block passes (at upper bound)", () => {
    expect(lengthInBand(buildJapaneseChars(401), "ja")).toBe(true);
  });

  it("213-char Japanese block fails (below lower bound)", () => {
    expect(lengthInBand(buildJapaneseChars(213), "ja")).toBe(false);
  });

  it("402-char Japanese block fails (above upper bound)", () => {
    expect(lengthInBand(buildJapaneseChars(402), "ja")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Chinese (character count) tests — including zh-TW / zh-CN subtag handling
// ---------------------------------------------------------------------------

describe("getCharBand — Chinese", () => {
  it("returns a character band for Chinese (zh)", () => {
    const band = getCharBand("zh");
    expect(band).not.toBeNull();
    // min = floor(134 * 1.6) = 214, max = ceil(167 * 2.0) = 334
    expect(band!.minChars).toBe(214);
    expect(band!.maxChars).toBe(334);
  });

  it("handles zh-TW (Traditional Chinese) via primary subtag", () => {
    const band = getCharBand("zh-TW");
    expect(band).not.toBeNull();
    expect(band!.minChars).toBe(214);
    expect(band!.maxChars).toBe(334);
  });

  it("handles zh-CN (Simplified Chinese) via primary subtag", () => {
    const band = getCharBand("zh-CN");
    expect(band).not.toBeNull();
  });
});

describe("lengthInBand — Chinese (zh-TW)", () => {
  it("250-char Chinese block passes", () => {
    expect(lengthInBand(buildChineseChars(250), "zh-TW")).toBe(true);
  });

  it("10-char Chinese block fails", () => {
    expect(lengthInBand(buildChineseChars(10), "zh-TW")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Thai (character count) tests
// ---------------------------------------------------------------------------

describe("getCharBand — Thai", () => {
  it("returns a character band for Thai", () => {
    const band = getCharBand("th");
    expect(band).not.toBeNull();
    // min = floor(134 * 2.0) = 268, max = ceil(167 * 3.0) = 501
    expect(band!.minChars).toBe(268);
    expect(band!.maxChars).toBe(501);
  });
});

describe("lengthInBand — Thai", () => {
  it("300-char Thai block passes", () => {
    // Thai character: ก (U+0E01)
    expect(lengthInBand("ก".repeat(300), "th")).toBe(true);
  });

  it("10-char Thai block fails", () => {
    expect(lengthInBand("ก".repeat(10), "th")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Language fallback — Latin-script languages
// ---------------------------------------------------------------------------

describe("lengthInBand — other Latin-script languages", () => {
  it("French (fr) uses word counting", () => {
    // 150 French words should pass
    expect(lengthInBand(buildWords(150), "fr")).toBe(true);
  });

  it("Spanish (es) uses word counting", () => {
    expect(lengthInBand(buildWords(150), "es")).toBe(true);
  });

  it("German (de) uses word counting", () => {
    expect(lengthInBand(buildWords(150), "de")).toBe(true);
  });

  it("Russian (ru) uses word counting", () => {
    const russianWords = Array.from({ length: 150 }, () => "слово").join(" ");
    expect(lengthInBand(russianWords, "ru")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getCharBand returns null for space-delimited scripts
// ---------------------------------------------------------------------------

describe("getCharBand — null for space-delimited scripts", () => {
  it("returns null for English", () => {
    expect(getCharBand("en")).toBeNull();
  });

  it("returns null for French", () => {
    expect(getCharBand("fr")).toBeNull();
  });

  it("returns null for Russian", () => {
    expect(getCharBand("ru")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Determinism: computeLengthUnits never calls an LLM
// ---------------------------------------------------------------------------

describe("computeLengthUnits — determinism guarantee", () => {
  it("returns the same result on repeated calls for English", () => {
    const text = buildWords(150);
    const results = Array.from({ length: 5 }, () => computeLengthUnits(text, "en"));
    expect(results.every((r) => r === results[0])).toBe(true);
  });

  it("returns the same result on repeated calls for Korean", () => {
    const text = buildKoreanChars(300);
    const results = Array.from({ length: 5 }, () => computeLengthUnits(text, "ko"));
    expect(results.every((r) => r === results[0])).toBe(true);
  });

  it("returns the same result on repeated calls for Japanese", () => {
    const text = buildJapaneseChars(300);
    const results = Array.from({ length: 5 }, () => computeLengthUnits(text, "ja"));
    expect(results.every((r) => r === results[0])).toBe(true);
  });
});
