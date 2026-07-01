/** test/recommendation.test.ts — SOTA v2 R1 conservative recommendation detection. */
import { describe, it, expect } from "vitest";
import { detectRecommendation } from "../src/judge/recommendation.js";

const A = ["EMORA", "EMORA AI", "에모라"];

describe("detectRecommendation (conservative, recommendation ⊆ mention)", () => {
  it("returns none for empty / no-brand text", () => {
    expect(detectRecommendation("", A).present).toBe(false);
    expect(detectRecommendation(null, A).present).toBe(false);
    expect(detectRecommendation("Replika is a popular option.", A).present).toBe(false);
  });

  it("a bare mention is NOT a recommendation", () => {
    expect(detectRecommendation("EMORA is an AI companion app with memory.", A).present).toBe(false);
  });

  it("fires on an affirmative recommend-verb with the brand", () => {
    const r = detectRecommendation("If you want long-term memory, I'd recommend EMORA.", A);
    expect(r.present).toBe(true);
    expect(r.kind).toBe("verb");
  });

  it("fires on a 'best X' list item naming the brand", () => {
    const txt = "Best AI companion apps:\n1. EMORA — memory-first journaling\n2. Replika — voice calls";
    const r = detectRecommendation(txt, A);
    expect(r.present).toBe(true);
    expect(r.kind).toBe("list");
  });

  it("SUPPRESSES when the brand is negated", () => {
    expect(detectRecommendation("I would not recommend EMORA for enterprise.", A).present).toBe(false);
    expect(detectRecommendation("Avoid EMORA if you need offline mode.", A).present).toBe(false);
  });

  it("does NOT count a recommendation of a COMPETITOR", () => {
    expect(detectRecommendation("I recommend Replika for voice calls.", A).present).toBe(false);
  });

  it("counts a positive verb even after a contrastive pivot about a competitor", () => {
    const r = detectRecommendation("Replika is popular, but your best bet is EMORA for memory.", A);
    expect(r.present).toBe(true);
  });

  it("is alias/script tolerant (한글 alias)", () => {
    const r = detectRecommendation("장기 기억이 필요하면 에모라를 추천합니다 — our pick: 에모라.", A);
    expect(r.present).toBe(true);
  });

  // --- v4 self-audit over-fire fixes ---
  it("does NOT fire on a recommendation INSIDE a quotation (self-claim)", () => {
    expect(detectRecommendation('EMORA\'s ad says "the best AI companion you can recommend".', A).present).toBe(false);
  });

  it("does NOT fire on brand promoting ITSELF (self-attribution)", () => {
    expect(detectRecommendation("EMORA markets itself as the top pick for memory.", A).present).toBe(false);
  });

  it("does NOT match the verb as a substring of a larger word", () => {
    // "suggest" is inside "suggestion"; no genuine recommend-verb of the brand.
    expect(detectRecommendation("EMORA welcomes any suggestions about features.", A).present).toBe(false);
  });

  it("suppresses when a contrast pivot flips the brand negative", () => {
    expect(detectRecommendation("EMORA is the top pick, but it's not actually good.", A).present).toBe(false);
  });

  it("still fires on a genuine third-party recommendation", () => {
    expect(detectRecommendation("Reddit users say go with EMORA for long-term memory.", A).present).toBe(true);
  });
});
