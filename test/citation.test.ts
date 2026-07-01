/** test/citation.test.ts — hi-end audit MUST #2 deterministic citation detection. */
import { describe, it, expect } from "vitest";
import { detectCitation } from "../src/judge/citation.js";
import { ruleFallback } from "../src/judge/ruleFallback.js";

const ALIASES = ["EMORA", "EMORA AI", "에모라"];

describe("detectCitation (MUST #2)", () => {
  it("returns no citation for empty / null text", () => {
    expect(detectCitation("", ALIASES)).toEqual({ present: false, url: null, quote: null });
    expect(detectCitation(null, ALIASES)).toEqual({ present: false, url: null, quote: null });
  });

  it("does NOT treat a bare prose mention as a citation", () => {
    const txt = "EMORA is an AI companion app with strong memory features.";
    expect(detectCitation(txt, ALIASES).present).toBe(false);
  });

  it("detects a markdown link whose anchor is the brand", () => {
    const txt = "You can try [EMORA](https://emora.ai/start) for journaling.";
    const c = detectCitation(txt, ALIASES);
    expect(c.present).toBe(true);
    expect(c.url).toBe("https://emora.ai/start");
    expect(c.quote).toBe("EMORA");
  });

  it("detects a markdown link whose URL carries the brand even if anchor does not", () => {
    const txt = "Read more [here](https://www.emora.ai/about).";
    const c = detectCitation(txt, ALIASES);
    expect(c.present).toBe(true);
    expect(c.url).toContain("emora.ai");
  });

  it("detects an HTML anchor tag", () => {
    const txt = 'See <a href="https://emora.ai">EMORA AI</a> for details.';
    const c = detectCitation(txt, ALIASES);
    expect(c.present).toBe(true);
    expect(c.url).toBe("https://emora.ai");
  });

  it("detects an explicit Source: attribution URL", () => {
    const txt = "EMORA has a memory feature. Source: https://emora.ai/docs/memory";
    const c = detectCitation(txt, ALIASES);
    expect(c.present).toBe(true);
    expect(c.url).toContain("emora.ai");
  });

  it("does NOT cite a competitor's link", () => {
    const txt = "Compare with [Replika](https://replika.com) which is older.";
    expect(detectCitation(txt, ALIASES).present).toBe(false);
  });

  it("does NOT count an unrelated domain that merely CONTAINS the alias substring (v4 bug fix)", () => {
    // "emora" is a substring of "memora-health" and "emorandum" — must NOT match.
    expect(detectCitation("See https://memora-health.com for therapy.", ["EMORA"]).present).toBe(false);
    expect(detectCitation("Try [Emorandum](https://emorandum.io) instead.", ["EMORA"]).present).toBe(false);
  });

  it("is case/alias tolerant (한글 alias in link text)", () => {
    const txt = "자세히는 [에모라](https://emora.ai/ko) 에서 확인하세요.";
    expect(detectCitation(txt, ALIASES).present).toBe(true);
  });
});

describe("ruleFallback citation integration (MUST #2)", () => {
  const base = { brandName: "EMORA", brandAliases: ["EMORA AI"], competitors: [] };

  it("sets citation_present=false for a plain mention", () => {
    const r = ruleFallback({ ...base, answerText: "EMORA is a journaling companion." });
    expect(r.verdict.brand_mentioned).toBe(true);
    expect(r.verdict.citation_present).toBe(false);
    expect(r.verdict.citation_url).toBeNull();
  });

  it("sets citation_present=true + url when the brand is a linked source", () => {
    const r = ruleFallback({
      ...base,
      answerText: "Try [EMORA](https://emora.ai) for memory-first journaling.",
    });
    expect(r.verdict.brand_mentioned).toBe(true);
    expect(r.verdict.citation_present).toBe(true);
    expect(r.verdict.citation_url).toBe("https://emora.ai");
  });

  it("citation requires a mention (no brand → no citation)", () => {
    const r = ruleFallback({ ...base, answerText: "Replika is a popular option." });
    expect(r.verdict.brand_mentioned).toBe(false);
    expect(r.verdict.citation_present).toBe(false);
  });
});
