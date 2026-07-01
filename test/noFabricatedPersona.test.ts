/**
 * test/noFabricatedPersona.test.ts
 *
 * W4 acceptance criteria for noFabricatedPersonaGate (FTC fake-endorsement guard):
 *
 * BLOCKS (fabricated endorsement — by construction, AI-generated content has no
 *   real endorser):
 *   - first-person endorsement voice ("I've been using EMORA…", "my experience with")
 *   - self-styled endorser ("As a longtime user…")
 *   - fabricated demographic persona ("Sarah, a 32-year-old marketer, says …")
 *   - intro persona ("Meet Sarah")
 *   - attributed testimonial quote ("…changed my life." — Mike)
 *   - invented spokesperson ("our brand ambassador")
 *   - Korean / Japanese first-person endorsement
 *
 * PASSES (precision guards — legitimate AEO content):
 *   - first-person QUESTIONS ("How do I cancel?", "Can I export my data?")
 *   - second-person instructional voice ("you can configure…")
 *   - third-person factual description ("EMORA supports group chat")
 *   - JSON-LD bodies (structured data; W3's province)
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { noFabricatedPersonaGate } from "../src/content/gates/noFabricatedPersona.js";
import type { ContentAsset, ContentGateContext } from "../src/content/types.js";

const NOW = new Date("2025-01-01T00:00:00Z");

function makeAsset(body: ContentAsset["body"], language = "en"): ContentAsset {
  return {
    id: randomUUID(),
    customer_id: "cust-1",
    industry: "tech",
    template_id: randomUUID(),
    template_version: 1,
    content_set_id: randomUUID(),
    content_type: body.content_type,
    format: body.content_type === "jsonld" ? "jsonld_org" : "answer_block",
    channel_class: "owned_net",
    language,
    phrasing_group_id: "pg-1",
    body,
    claims: [],
    word_count: 10,
    gate_status: "pending",
    gate_report: null,
    disclosure_tag: null,
    needs_native_review: false,
    regen_attempts: 0,
    provenance: null,
    created_at: NOW,
  } as ContentAsset;
}

function answer(text: string): ContentAsset["body"] {
  return {
    content_type: "answer_block",
    text,
    length_units: 12,
    numeric_claim_ids: [],
    source_ids: [],
  };
}

function ctx(asset: ContentAsset): ContentGateContext {
  return { asset, siblings: [], claimSources: [] } as unknown as ContentGateContext;
}

function run(text: string, language = "en") {
  return noFabricatedPersonaGate.apply(ctx(makeAsset(answer(text), language)));
}

describe("noFabricatedPersonaGate (W4 FTC fake-endorsement guard)", () => {
  it("has correct name and phase", () => {
    expect(noFabricatedPersonaGate.name).toBe("noFabricatedPersonaGate");
    expect(noFabricatedPersonaGate.phase).toBe("content");
  });

  // ---- BLOCK cases --------------------------------------------------------
  it("blocks first-person endorsement voice", () => {
    const r = run("I've been using EMORA for months and it transformed my workflow.");
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/first-person-endorsement/);
  });

  it("blocks first-person possessive testimonial", () => {
    const r = run("In my experience with EMORA, the onboarding was effortless.");
    expect(r.action).toBe("block");
  });

  it("blocks self-styled endorser", () => {
    const r = run("As a longtime user, EMORA has become indispensable.");
    expect(r.action).toBe("block");
  });

  it("blocks fabricated demographic persona", () => {
    const r = run("Sarah, a 32-year-old marketer, says EMORA saves her hours each week.");
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/fabricated-demographic-persona/);
  });

  it("blocks intro persona", () => {
    const r = run("Meet Sarah, a busy professional who needed a faster way to chat.");
    expect(r.action).toBe("block");
  });

  it("blocks attributed testimonial quote", () => {
    const r = run('"EMORA completely changed how I work each day." — Mike');
    expect(r.action).toBe("block");
  });

  it("blocks invented spokesperson", () => {
    const r = run("According to our brand ambassador, EMORA leads the category.");
    expect(r.action).toBe("block");
  });

  it("blocks Korean first-person endorsement", () => {
    const r = run("제가 EMORA를 직접 사용해보니 정말 추천합니다.", "ko");
    expect(r.action).toBe("block");
  });

  it("blocks Japanese first-person endorsement", () => {
    const r = run("私はEMORAを使ってみました。本当におすすめします。", "ja");
    expect(r.action).toBe("block");
  });

  // ---- PASS cases (precision guards) -------------------------------------
  it("passes first-person QUESTION in FAQ (not a testimonial)", () => {
    const body: ContentAsset["body"] = {
      content_type: "faq",
      rows: [
        { q: "How do I cancel my subscription?", a: "Open Settings and choose Cancel.", answer_claim_ids: [] },
        { q: "Can I export my data?", a: "Yes, data export is available in Settings.", answer_claim_ids: [] },
      ],
    } as unknown as ContentAsset["body"];
    const r = noFabricatedPersonaGate.apply(ctx(makeAsset(body)));
    expect(r.action).toBe("pass");
  });

  it("passes second-person instructional voice", () => {
    expect(run("You can configure character voices in the settings panel.").action).toBe("pass");
  });

  it("passes third-person factual description", () => {
    expect(run("EMORA supports group chat with multiple AI characters.").action).toBe("pass");
  });

  it("passes a Korean factual description (no first-person endorsement)", () => {
    expect(run("EMORA는 여러 AI 캐릭터와의 그룹 채팅을 지원합니다.", "ko").action).toBe("pass");
  });

  it("passes JSON-LD bodies (structured data is out of scope)", () => {
    const body: ContentAsset["body"] = {
      content_type: "jsonld",
      schema_type: "Organization",
      json: { "@type": "Organization", name: "EMORA", review: { author: "Sarah" } },
    } as unknown as ContentAsset["body"];
    const r = noFabricatedPersonaGate.apply(ctx(makeAsset(body)));
    expect(r.action).toBe("pass");
  });

  it("passes empty prose", () => {
    expect(run("").action).toBe("pass");
  });
});
