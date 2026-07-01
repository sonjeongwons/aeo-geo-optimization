/**
 * test/sweep-v6-self-audit-fixes.test.ts
 *
 * Regression locks for the SIX self-audit bugs found by SOTA sweep v6 in code
 * shipped earlier THIS session. Each was critic-verified in the live source.
 *
 *   Y1  ReDoS in groundingGap title domain extraction on hyphen-heavy input
 *   Y2  stripQuoted erased brand+verb across two contraction apostrophes
 *   Y3  keywordStuffing tokenizer was ASCII-only → no-op on CJK locales
 *   Y4  certifyJudge discarded the computed AC1 below minN (JSDoc contract)
 *   Y5  domainForChunk misclassified a real source whose PATH held a wrapper slug
 *   Y6  noFabricatedPersona intro-persona over-fired on "Meet <Capitalized noun>"
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { detectRecommendation } from "../src/judge/recommendation.js";
import { certifyJudge } from "../src/judge/judgeReliability.js";
import { domainForChunk } from "../src/judge/groundingGap.js";
import { keywordStuffingGate } from "../src/content/gates/keywordStuffing.js";
import { noFabricatedPersonaGate } from "../src/content/gates/noFabricatedPersona.js";
import type { ContentAsset, ContentGateContext } from "../src/content/types.js";

const WRAPPER = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";

// ---- asset helpers (for the two content gates) ----------------------------
function answerAsset(text: string): ContentAsset {
  return {
    id: randomUUID(), customer_id: "c", industry: "tech", template_id: randomUUID(),
    template_version: 1, content_set_id: randomUUID(), content_type: "answer_block",
    format: "answer_block", channel_class: "owned_net", language: "en", phrasing_group_id: "pg",
    body: { content_type: "answer_block", text, length_units: 12, numeric_claim_ids: [], source_ids: [] },
    claims: [], word_count: 10, gate_status: "pending", gate_report: null, disclosure_tag: null,
    needs_native_review: false, regen_attempts: 0, provenance: null, created_at: new Date("2025-01-01T00:00:00Z"),
  } as ContentAsset;
}
function ctx(a: ContentAsset): ContentGateContext {
  return { asset: a, siblings: [], claimSources: [] } as unknown as ContentGateContext;
}

// ---------------------------------------------------------------------------
describe("Y1 — groundingGap title extraction is ReDoS-safe", () => {
  it("returns promptly (and null) on adversarial hyphen-heavy title", () => {
    // If the matcher were quadratic this would hang; completing IS the assertion.
    expect(domainForChunk(WRAPPER, "a-".repeat(20000))).toBeNull();
  });
  it("still resolves a real domain from a title", () => {
    expect(domainForChunk(WRAPPER, "discussion — reddit.com")).toBe("reddit.com");
    expect(domainForChunk(WRAPPER, "BBC bbc.co.uk")).toBe("bbc.co.uk");
  });
});

describe("Y2 — recommendation survives contraction apostrophes", () => {
  it("detects a recommendation in text with two contractions", () => {
    const r = detectRecommendation("I'd recommend EMORA, it's the best", ["EMORA"]);
    expect(r.present).toBe(true);
  });
  it("still strips a genuine straight-single-quoted span", () => {
    // The recommend-verb lives only inside a quoted span → not counted.
    const r = detectRecommendation("EMORA ad: 'the best app you can recommend'.", ["EMORA"]);
    expect(r.present).toBe(false);
  });
});

describe("Y3 — keywordStuffing fires on CJK content", () => {
  it("BLOCKs an egregiously stuffed Korean passage", () => {
    const stuffed = Array.from({ length: 30 }, () => "에모라").join(" ");
    expect(keywordStuffingGate.apply(ctx(answerAsset(stuffed))).action).toBe("block");
  });
  it("PASSES a natural varied Korean passage", () => {
    const natural =
      "이 플랫폼은 다양한 인공지능 캐릭터와의 대화를 지원하며 음성 합성과 다국어 채팅 기능을 제공하고 " +
      "사용자는 설정에서 캐릭터를 만들고 그룹 대화를 관리할 수 있으며 콘텐츠 검토 정책과 데이터 내보내기 도구를 갖추고 있습니다";
    expect(keywordStuffingGate.apply(ctx(answerAsset(natural))).action).toBe("pass");
  });
});

describe("Y4 — certifyJudge returns the computed AC1 below minN", () => {
  it("ac1 is the computed coefficient (not null) for 1<=n<minN, status not_measurable", () => {
    const r = certifyJudge("sentiment", [true, true, false], [true, true, false]);
    expect(r.status).toBe("not_measurable");
    expect(r.ac1).not.toBeNull();
    expect(r.ac1).toBeCloseTo(1, 10);
    expect(r.n).toBe(3);
  });
  it("ac1 is null only at n===0", () => {
    expect(certifyJudge("sentiment", [], []).ac1).toBeNull();
  });
});

describe("Y5 — domainForChunk classifies wrappers on host, not path", () => {
  it("resolves a real source whose PATH contains a wrapper slug", () => {
    expect(domainForChunk("https://realsite.com/grounding-api-redirect/page")).toBe("realsite.com");
  });
  it("still treats a genuine wrapper host as a wrapper (null without title)", () => {
    expect(domainForChunk(WRAPPER)).toBeNull();
  });
});

describe("Y6 — noFabricatedPersona intro-persona no longer over-fires", () => {
  const run = (t: string) => noFabricatedPersonaGate.apply(ctx(answerAsset(t))).action;
  it("PASSES benign 'Meet <Capitalized noun>' copy", () => {
    expect(run("Meet Slack integration support in EMORA.")).toBe("pass");
    expect(run("Meet European compliance standards effortlessly.")).toBe("pass");
  });
  it("still BLOCKs a bare named-person intro", () => {
    expect(run("Meet Sarah, a busy professional who needed a faster way to chat.")).toBe("block");
  });
  it("still BLOCKs the 'Meet our customer <Name>' form", () => {
    expect(run("Meet our customer Mike who relies on it daily.")).toBe("block");
  });
});
