/**
 * test/surfaces/proseCitationSeparation.test.ts
 *
 * T17 — PROSE/CITATION SEPARATION invariant tests.
 *
 * DESIGN-phase4.md T08/T09: parsers MUST put ONLY answer prose into
 * `answerText`. Citations are a SEPARATE structured list and MUST NEVER
 * appear in `answerText`. The judge sees clean prose and brand attribution
 * stays faithful.
 *
 * Tests cover ALL six v1-b parsers:
 *   SERP:   AiOverviewParser, NaverParser
 *   Scrape: CopilotParser, MetaAiParser, LineParser, KakaoParser
 *
 * For each parser:
 *   1. Happy-path: answerText contains ONLY prose (no URL/title noise).
 *   2. Citations list is populated separately.
 *   3. answerText does NOT contain any citation URL.
 *   4. NO_ANSWER returned when answer block is absent.
 *   5. ParseError (DRIFT/SCHEMA_ERROR) returned on unexpected input.
 */

import { describe, it, expect } from "vitest";
import { AiOverviewParser } from "../../src/surfaces/serp/parse/aiOverviewParser.js";
import { NaverParser } from "../../src/surfaces/serp/parse/naverParser.js";
import { CopilotParser } from "../../src/surfaces/scrape/parse/copilotParser.js";
import { MetaAiParser } from "../../src/surfaces/scrape/parse/metaAiParser.js";
import { LineParser } from "../../src/surfaces/scrape/parse/lineParser.js";
import { KakaoParser } from "../../src/surfaces/scrape/parse/kakaoParser.js";
import { NO_ANSWER } from "../../src/surfaces/types.js";

// ---------------------------------------------------------------------------
// Helper: assert prose-citation separation invariant
// ---------------------------------------------------------------------------

/**
 * Given a ParseOk result, verify:
 *   - answerText is non-empty prose
 *   - answerText does NOT contain any citation URL
 *   - citations array is the separate structured list
 */
function assertProseCitationSeparation(
  answerText: string,
  citations: Array<{ url: string; title?: string; snippet?: string; rank?: number }>,
  citationUrls: string[]
): void {
  // answerText must be non-empty
  expect(answerText.trim().length).toBeGreaterThan(0);

  // answerText MUST NOT contain any citation URL
  for (const url of citationUrls) {
    expect(answerText).not.toContain(url);
  }

  // Citations in the structured list must have URLs
  for (const c of citations) {
    expect(typeof c.url).toBe("string");
    expect(c.url.trim().length).toBeGreaterThan(0);
  }
}

// ===========================================================================
// AiOverviewParser — SERP: Google AI Overviews
// ===========================================================================

describe("AiOverviewParser — prose/citation separation", () => {
  const parser = new AiOverviewParser();

  const FIXTURE_AIO = {
    ai_overview: {
      text_blocks: [
        { type: "paragraph", text: "This is the first paragraph of the AI overview answer." },
        { type: "paragraph", text: "This is the second paragraph with more detail about the topic." },
        // List block — PM-02 fix: list items ARE flattened into prose so the
        // judge can detect brand mentions in list-style AIO answers.
        { type: "list", text: "- item 1\n- item 2" },
      ],
      references: [
        { link: "https://example.com/source1", title: "Source Title 1", snippet: "Relevant excerpt from source 1." },
        { link: "https://example.com/source2", title: "Source Title 2" },
        { link: "https://example.com/source3" },
      ],
    },
  };

  it("returns ParseOk for a valid AIO fixture", () => {
    const result = parser.parse(FIXTURE_AIO);
    expect(result.ok).toBe(true);
  });

  it("answerText is prose only — contains no citation URL", () => {
    const result = parser.parse(FIXTURE_AIO);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText, citations } = result.answer;
    assertProseCitationSeparation(answerText, citations, [
      "https://example.com/source1",
      "https://example.com/source2",
      "https://example.com/source3",
    ]);
  });

  it("prose contains paragraph text AND list items (PM-02 fix)", () => {
    const result = parser.parse(FIXTURE_AIO);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.answerText).toContain("first paragraph");
    expect(result.answer.answerText).toContain("second paragraph");
    // List block text must also be included in prose (PM-02: list-style AIO answers
    // for 'best-X' recommendation queries must reach the judge, not be discarded).
    expect(result.answer.answerText).toContain("item 1");
    expect(result.answer.answerText).toContain("item 2");
  });

  it("citations are structured separately with rank", () => {
    const result = parser.parse(FIXTURE_AIO);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { citations } = result.answer;
    expect(citations.length).toBe(3);
    expect(citations[0]).toMatchObject({ url: "https://example.com/source1", rank: 1 });
    expect(citations[1]).toMatchObject({ url: "https://example.com/source2", rank: 2 });
    expect(citations[2]).toMatchObject({ url: "https://example.com/source3", rank: 3 });
  });

  it("returns NO_ANSWER when ai_overview block is absent", () => {
    const result = parser.parse({ organic_results: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseNoAnswer");
    expect(result.code).toBe(NO_ANSWER);
  });

  it("returns SCHEMA_ERROR when raw is not an object", () => {
    const result = parser.parse("not an object");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseError");
    expect(result.code).toBe("SCHEMA_ERROR");
  });

  it("returns NO_ANSWER when text_blocks are present but yield no prose", () => {
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

  it("surfaceId is googleAio", () => {
    expect(parser.surfaceId).toBe("googleAio");
  });
});

// ===========================================================================
// NaverParser — SERP: Naver AI Answer
// ===========================================================================

describe("NaverParser — prose/citation separation + nativeReview", () => {
  const parser = new NaverParser();

  const FIXTURE_NAVER = {
    naver_ai: {
      answer: "네이버 AI 답변입니다. 브랜드에 대한 정보를 제공합니다.",
      sources: [
        { link: "https://naver.com/source1", title: "Source 1 KR", description: "관련 내용 발췌." },
        { link: "https://naver.com/source2", title: "Source 2 KR" },
      ],
    },
  };

  it("returns ParseOk for a valid Naver fixture", () => {
    const result = parser.parse(FIXTURE_NAVER);
    expect(result.ok).toBe(true);
  });

  it("answerText is prose only — contains no citation URL", () => {
    const result = parser.parse(FIXTURE_NAVER);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText, citations } = result.answer;
    assertProseCitationSeparation(answerText, citations, [
      "https://naver.com/source1",
      "https://naver.com/source2",
    ]);
  });

  it("nativeReview flag is TRUE (KR market surface)", () => {
    const result = parser.parse(FIXTURE_NAVER);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.nativeReview).toBe(true);
  });

  it("citations are structured separately with url + title", () => {
    const result = parser.parse(FIXTURE_NAVER);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { citations } = result.answer;
    expect(citations.length).toBe(2);
    expect(citations[0]).toMatchObject({ url: "https://naver.com/source1", rank: 1 });
  });

  it("accepts ai_answer alias", () => {
    const result = parser.parse({
      ai_answer: {
        answer: "알파 브랜드 정보입니다.",
        sources: [{ link: "https://naver.com/s" }],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("returns NO_ANSWER when naver_ai block is absent", () => {
    const result = parser.parse({ organic_results: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseNoAnswer");
    expect(result.code).toBe(NO_ANSWER);
  });

  it("returns SCHEMA_ERROR when raw is not an object", () => {
    const result = parser.parse(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseError");
    expect(result.code).toBe("SCHEMA_ERROR");
  });

  it("surfaceId is naverAi", () => {
    expect(parser.surfaceId).toBe("naverAi");
  });
});

// ===========================================================================
// CopilotParser — Scrape: Microsoft Copilot
// ===========================================================================

describe("CopilotParser — prose/citation separation", () => {
  const parser = new CopilotParser();

  const FIXTURE_SNAPSHOT = {
    answerBlock: "Copilot says: here is a detailed answer about the brand.",
    citations: [
      { url: "https://bing.com/cite1", title: "Bing Result 1", snippet: "Excerpt", rank: 1 },
      { url: "https://bing.com/cite2", title: "Bing Result 2", rank: 2 },
    ],
  };

  it("returns ParseOk for a valid Copilot snapshot", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    expect(result.ok).toBe(true);
  });

  it("answerText is prose only — contains no citation URL", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText, citations } = result.answer;
    assertProseCitationSeparation(answerText, citations, [
      "https://bing.com/cite1",
      "https://bing.com/cite2",
    ]);
  });

  it("citations are in the structured list", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.citations.length).toBe(2);
    expect(result.answer.citations[0]).toMatchObject({ url: "https://bing.com/cite1", rank: 1 });
  });

  it("nativeReview is NOT set (global English-first surface)", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    if (!result.ok) throw new Error("Expected ParseOk");
    // nativeReview should be falsy (undefined or false) for Copilot
    expect(result.answer.nativeReview).toBeFalsy();
  });

  it("returns NO_ANSWER when noAnswerFound=true", () => {
    const result = parser.parse({ noAnswerFound: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseNoAnswer");
    expect(result.code).toBe(NO_ANSWER);
  });

  it("returns NO_ANSWER when answerBlock is empty", () => {
    const result = parser.parse({ answerBlock: "   ", citations: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseNoAnswer");
    expect(result.code).toBe(NO_ANSWER);
  });

  it("returns DRIFT for unexpected input type", () => {
    const result = parser.parse(42);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseError");
    expect(result.code).toBe("DRIFT");
  });

  it("surfaceId is copilot", () => {
    expect(parser.surfaceId).toBe("copilot");
  });
});

// ===========================================================================
// MetaAiParser — Scrape: Meta AI
// ===========================================================================

describe("MetaAiParser — prose/citation separation", () => {
  const parser = new MetaAiParser();

  const FIXTURE_SNAPSHOT = {
    answerBlock: "Meta AI response: the brand has a strong presence in e-commerce.",
    citations: [
      { url: "https://meta.com/source1", title: "Meta Article", snippet: "Excerpt from Meta AI source.", rank: 1 },
    ],
    modelId: "llama-3.1-70b",
  };

  it("returns ParseOk for a valid Meta AI snapshot", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    expect(result.ok).toBe(true);
  });

  it("answerText is prose only — contains no citation URL", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText, citations } = result.answer;
    assertProseCitationSeparation(answerText, citations, [
      "https://meta.com/source1",
    ]);
  });

  it("nativeReview is NOT set (global English-first surface)", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.nativeReview).toBeFalsy();
  });

  it("returns NO_ANSWER when noAnswerFound=true", () => {
    const result = parser.parse({ noAnswerFound: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseNoAnswer");
    expect(result.code).toBe(NO_ANSWER);
  });

  it("returns DRIFT for unexpected input type", () => {
    const result = parser.parse(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseError");
    expect(result.code).toBe("DRIFT");
  });

  it("surfaceId is metaAi", () => {
    expect(parser.surfaceId).toBe("metaAi");
  });
});

// ===========================================================================
// LineParser — Scrape: Line AI (JP/TW/TH)
// ===========================================================================

describe("LineParser — prose/citation separation + nativeReview", () => {
  const parser = new LineParser();

  const FIXTURE_SNAPSHOT = {
    answerBlock: "ラインAIです。ブランドに関する情報をお伝えします。",
    citations: [
      { url: "https://line.me/source1", title: "Line Source 1", rank: 1 },
      { url: "https://line.me/source2", title: "Line Source 2", rank: 2 },
    ],
  };

  it("returns ParseOk for a valid Line snapshot", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    expect(result.ok).toBe(true);
  });

  it("answerText is prose only — contains no citation URL", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText, citations } = result.answer;
    assertProseCitationSeparation(answerText, citations, [
      "https://line.me/source1",
      "https://line.me/source2",
    ]);
  });

  it("nativeReview flag is TRUE (JP/TW/TH market surface)", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.nativeReview).toBe(true);
  });

  it("returns NO_ANSWER when noAnswerFound=true", () => {
    const result = parser.parse({ noAnswerFound: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseNoAnswer");
    expect(result.code).toBe(NO_ANSWER);
  });

  it("returns DRIFT for unexpected input type", () => {
    const result = parser.parse(42);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseError");
    expect(result.code).toBe("DRIFT");
  });

  it("surfaceId is line", () => {
    expect(parser.surfaceId).toBe("line");
  });
});

// ===========================================================================
// KakaoParser — Scrape: Kakao AI (KR)
// ===========================================================================

describe("KakaoParser — prose/citation separation + nativeReview", () => {
  const parser = new KakaoParser();

  const FIXTURE_SNAPSHOT = {
    answerBlock: "카카오 AI 답변: 해당 브랜드에 대한 정보입니다.",
    citations: [
      { url: "https://kakao.com/source1", title: "카카오 출처 1", snippet: "발췌", rank: 1 },
    ],
  };

  it("returns ParseOk for a valid Kakao snapshot", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    expect(result.ok).toBe(true);
  });

  it("answerText is prose only — contains no citation URL", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    if (!result.ok) throw new Error("Expected ParseOk");
    const { answerText, citations } = result.answer;
    assertProseCitationSeparation(answerText, citations, [
      "https://kakao.com/source1",
    ]);
  });

  it("nativeReview flag is TRUE (KR market surface)", () => {
    const result = parser.parse(FIXTURE_SNAPSHOT);
    if (!result.ok) throw new Error("Expected ParseOk");
    expect(result.answer.nativeReview).toBe(true);
  });

  it("returns NO_ANSWER when noAnswerFound=true", () => {
    const result = parser.parse({ noAnswerFound: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseNoAnswer");
    expect(result.code).toBe(NO_ANSWER);
  });

  it("returns DRIFT for unexpected input type", () => {
    const result = parser.parse(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ParseError");
    expect(result.code).toBe("DRIFT");
  });

  it("surfaceId is kakao", () => {
    expect(parser.surfaceId).toBe("kakao");
  });
});
