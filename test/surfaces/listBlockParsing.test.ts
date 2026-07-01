/**
 * test/surfaces/listBlockParsing.test.ts
 *
 * PM-02 regression tests — list-block extraction in AiOverviewParser and NaverParser.
 *
 * DEFECT: The AI Overviews parser (and Naver parser) previously discarded 'list'
 * type blocks, so AIO answers rendered entirely as lists (the dominant format for
 * 'best-X' / 'top-alternatives' recommendation queries — SPEC §14 brand-attribution
 * queries) reached the judge as empty prose. Brand was never detected -> measurement
 * defect.
 *
 * FIX: List blocks are now flattened into prose as "- <item>" bullets. Citation URLs
 * remain in the citations array (PROSE/CITATION SEPARATION invariant preserved).
 *
 * Fixture shape tested:
 *   - All-list AIO: text_blocks contains ONLY list-type entries, no paragraphs.
 *   - Mixed: paragraph + list blocks interleaved.
 *   - Structured items array (vendor shape 2): list block with items: string[].
 *   - Naver text_blocks: Naver AI answer using text_blocks with list entries.
 *   - Citation separation: list item text does NOT appear as a citation URL.
 */

import { describe, it, expect } from "vitest";
import { AiOverviewParser } from "../../src/surfaces/serp/parse/aiOverviewParser.js";
import { NaverParser } from "../../src/surfaces/serp/parse/naverParser.js";
import { NO_ANSWER } from "../../src/surfaces/types.js";

// ===========================================================================
// AiOverviewParser — list-block extraction (PM-02)
// ===========================================================================

describe("AiOverviewParser — list-block extraction (PM-02)", () => {
  const parser = new AiOverviewParser();

  // -------------------------------------------------------------------------
  // Fixture 1: All-list AIO — no paragraph blocks at all.
  // This is the dominant shape for 'best-X' recommendation queries.
  // -------------------------------------------------------------------------
  const FIXTURE_ALL_LIST = {
    ai_overview: {
      text_blocks: [
        {
          type: "list",
          text: "- BrandAlpha: best overall pick\n- BrandBeta: budget option\n- BrandGamma: premium tier",
        },
      ],
      references: [
        { link: "https://example.com/review1", title: "Top Picks Review", snippet: "Comprehensive comparison." },
        { link: "https://example.com/review2", title: "Budget Guide" },
      ],
    },
  };

  it("all-list AIO: returns ParseOk (not NO_ANSWER) when only list blocks present", () => {
    const result = parser.parse(FIXTURE_ALL_LIST);
    expect(result.ok).toBe(true);
  });

  it("all-list AIO: answer_text contains the list item content", () => {
    const result = parser.parse(FIXTURE_ALL_LIST);
    if (!result.ok) throw new Error(`Expected ParseOk, got code=${result.code}`);
    const { answerText } = result.answer;
    expect(answerText).toContain("BrandAlpha");
    expect(answerText).toContain("BrandBeta");
    expect(answerText).toContain("BrandGamma");
    expect(answerText).toContain("best overall pick");
  });

  it("all-list AIO: citations are populated separately, not in answer_text", () => {
    const result = parser.parse(FIXTURE_ALL_LIST);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText, citations } = result.answer;

    // Citations must be in the structured array
    expect(citations.length).toBe(2);
    expect(citations[0]).toMatchObject({ url: "https://example.com/review1", rank: 1 });
    expect(citations[1]).toMatchObject({ url: "https://example.com/review2", rank: 2 });

    // Citation URLs must NOT appear in answerText (PROSE/CITATION SEPARATION)
    expect(answerText).not.toContain("https://example.com/review1");
    expect(answerText).not.toContain("https://example.com/review2");
  });

  it("all-list AIO: surfaceId is googleAio", () => {
    const result = parser.parse(FIXTURE_ALL_LIST);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.surfaceId).toBe("googleAio");
  });

  // -------------------------------------------------------------------------
  // Fixture 2: All-list AIO with structured items array (vendor shape 2).
  // Some vendors send list blocks as { type: 'list', items: string[] } instead
  // of encoding bullets in the text field.
  // -------------------------------------------------------------------------
  const FIXTURE_ALL_LIST_ITEMS_ARRAY = {
    ai_overview: {
      text_blocks: [
        {
          type: "list",
          items: [
            "BrandAlpha — rated #1 for performance",
            "BrandBeta — best value under $50",
            "BrandGamma — top pick for professionals",
          ],
        },
      ],
      references: [
        { link: "https://example.com/source1", title: "Expert Review" },
      ],
    },
  };

  it("structured items array: returns ParseOk and flattens items into prose", () => {
    const result = parser.parse(FIXTURE_ALL_LIST_ITEMS_ARRAY);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText } = result.answer;
    expect(answerText).toContain("BrandAlpha");
    expect(answerText).toContain("BrandBeta");
    expect(answerText).toContain("BrandGamma");
    // Items should be formatted as "- <item>" bullets
    expect(answerText).toContain("- BrandAlpha");
    expect(answerText).toContain("- BrandBeta");
    expect(answerText).toContain("- BrandGamma");
  });

  it("structured items array: citations stay separate", () => {
    const result = parser.parse(FIXTURE_ALL_LIST_ITEMS_ARRAY);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText, citations } = result.answer;
    expect(citations.length).toBe(1);
    expect(citations[0]).toMatchObject({ url: "https://example.com/source1", rank: 1 });
    expect(answerText).not.toContain("https://example.com/source1");
  });

  // -------------------------------------------------------------------------
  // Fixture 3: Mixed — paragraph + list blocks interleaved.
  // Both types must appear in the final prose.
  // -------------------------------------------------------------------------
  const FIXTURE_MIXED = {
    ai_overview: {
      text_blocks: [
        { type: "paragraph", text: "Here are the top alternatives for your query:" },
        {
          type: "list",
          items: ["BrandAlpha — leading option", "BrandBeta — runner-up"],
        },
        { type: "paragraph", text: "These brands cover most use cases effectively." },
        // code block must still be skipped
        { type: "code", text: "const x = 1;" },
      ],
      references: [
        { link: "https://example.com/compare", title: "Comparison Guide" },
      ],
    },
  };

  it("mixed blocks: prose includes both paragraph and list content", () => {
    const result = parser.parse(FIXTURE_MIXED);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText } = result.answer;
    expect(answerText).toContain("top alternatives");
    expect(answerText).toContain("BrandAlpha");
    expect(answerText).toContain("BrandBeta");
    expect(answerText).toContain("cover most use cases");
  });

  it("mixed blocks: code block content is NOT included in prose", () => {
    const result = parser.parse(FIXTURE_MIXED);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.answerText).not.toContain("const x = 1");
  });

  it("mixed blocks: citations stay separate", () => {
    const result = parser.parse(FIXTURE_MIXED);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.citations.length).toBe(1);
    expect(result.answer.answerText).not.toContain("https://example.com/compare");
  });

  // -------------------------------------------------------------------------
  // Regression: all-image AIO still returns NO_ANSWER (image blocks are skipped).
  // -------------------------------------------------------------------------
  it("all-image blocks: still returns NO_ANSWER (non-prose blocks skipped)", () => {
    const result = parser.parse({
      ai_overview: {
        text_blocks: [{ type: "image", text: "" }],
        references: [],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseNoAnswer");
    expect(result.code).toBe(NO_ANSWER);
  });

  // -------------------------------------------------------------------------
  // Regression: empty list block (no text, no items) does not break parsing.
  // -------------------------------------------------------------------------
  it("empty list block alongside paragraph: paragraph prose is returned", () => {
    const result = parser.parse({
      ai_overview: {
        text_blocks: [
          { type: "list" },  // no text, no items — should be skipped silently
          { type: "paragraph", text: "Fallback paragraph text." },
        ],
        references: [],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.answerText).toContain("Fallback paragraph text");
  });
});

// ===========================================================================
// NaverParser — list-block extraction via text_blocks (PM-02 parity)
// ===========================================================================

describe("NaverParser — list-block extraction via text_blocks (PM-02 parity)", () => {
  const parser = new NaverParser();

  // -------------------------------------------------------------------------
  // Fixture: Naver AI answer using text_blocks with list entries.
  // Some Naver SERP API vendors mirror the Google AIO text_blocks shape.
  // -------------------------------------------------------------------------
  const FIXTURE_NAVER_TEXT_BLOCKS = {
    naver_ai: {
      text_blocks: [
        { type: "paragraph", text: "네이버 AI 추천 목록입니다:" },
        {
          type: "list",
          items: ["브랜드알파 — 1위 선정", "브랜드베타 — 가성비 최고", "브랜드감마 — 프리미엄"],
        },
      ],
      sources: [
        { link: "https://naver.com/review1", title: "네이버 리뷰", description: "상세 비교." },
        { link: "https://naver.com/review2", title: "가이드" },
      ],
    },
  };

  it("text_blocks Naver: returns ParseOk when text_blocks has list content", () => {
    const result = parser.parse(FIXTURE_NAVER_TEXT_BLOCKS);
    expect(result.ok).toBe(true);
  });

  it("text_blocks Naver: answer_text contains list item content", () => {
    const result = parser.parse(FIXTURE_NAVER_TEXT_BLOCKS);
    if (!result.ok) throw new Error(`Expected ParseOk, got code=${result.code}`);
    const { answerText } = result.answer;
    expect(answerText).toContain("네이버 AI 추천 목록입니다");
    expect(answerText).toContain("브랜드알파");
    expect(answerText).toContain("브랜드베타");
    expect(answerText).toContain("브랜드감마");
  });

  it("text_blocks Naver: citations stay separate, not in answer_text", () => {
    const result = parser.parse(FIXTURE_NAVER_TEXT_BLOCKS);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText, citations } = result.answer;
    expect(citations.length).toBe(2);
    expect(citations[0]).toMatchObject({ url: "https://naver.com/review1", rank: 1 });
    expect(citations[1]).toMatchObject({ url: "https://naver.com/review2", rank: 2 });
    expect(answerText).not.toContain("https://naver.com/review1");
    expect(answerText).not.toContain("https://naver.com/review2");
  });

  it("text_blocks Naver: nativeReview flag is TRUE (KR surface)", () => {
    const result = parser.parse(FIXTURE_NAVER_TEXT_BLOCKS);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.nativeReview).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Fixture: all-list text_blocks — no flat string fields, no paragraph blocks.
  // -------------------------------------------------------------------------
  const FIXTURE_NAVER_ALL_LIST_BLOCKS = {
    naver_ai: {
      text_blocks: [
        {
          type: "list",
          text: "- 브랜드알파: 최고 추천\n- 브랜드베타: 실속형\n- 브랜드감마: 고급형",
        },
      ],
      sources: [
        { link: "https://naver.com/source1", title: "Source KR" },
      ],
    },
  };

  it("all-list text_blocks Naver: returns ParseOk (not NO_ANSWER)", () => {
    const result = parser.parse(FIXTURE_NAVER_ALL_LIST_BLOCKS);
    expect(result.ok).toBe(true);
  });

  it("all-list text_blocks Naver: list content appears in answer_text", () => {
    const result = parser.parse(FIXTURE_NAVER_ALL_LIST_BLOCKS);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.answerText).toContain("브랜드알파");
    expect(result.answer.answerText).toContain("브랜드베타");
    expect(result.answer.answerText).toContain("브랜드감마");
  });

  it("all-list text_blocks Naver: citations stay separate", () => {
    const result = parser.parse(FIXTURE_NAVER_ALL_LIST_BLOCKS);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText, citations } = result.answer;
    expect(citations.length).toBe(1);
    expect(answerText).not.toContain("https://naver.com/source1");
  });

  // -------------------------------------------------------------------------
  // Regression: flat string fields still work (legacy Naver API shape).
  // -------------------------------------------------------------------------
  it("flat string field still works when text_blocks is absent", () => {
    const result = parser.parse({
      naver_ai: {
        answer: "브랜드 정보입니다.",
        sources: [{ link: "https://naver.com/s" }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.answerText).toContain("브랜드 정보입니다");
  });

  // -------------------------------------------------------------------------
  // Regression: text_blocks with only non-prose types falls back to flat fields.
  // -------------------------------------------------------------------------
  it("text_blocks yielding no prose falls back to flat answer field", () => {
    const result = parser.parse({
      naver_ai: {
        answer: "폴백 텍스트.",
        text_blocks: [{ type: "image", text: "" }],
        sources: [],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.answerText).toContain("폴백 텍스트");
  });
});
