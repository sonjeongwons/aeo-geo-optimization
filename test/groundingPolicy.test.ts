/**
 * test/groundingPolicy.test.ts — cost-controlled grounding subsample policy + the
 * search-engine self-reference exclusion (both from the live-grounding work).
 */
import { describe, it, expect } from "vitest";
import { shouldGround, stableHash01 } from "../src/providers/groundingPolicy.js";
import { isSearchEngineSelfRef } from "../src/judge/groundingGap.js";

describe("shouldGround — subsample policy", () => {
  it("GEMINI_GROUNDING=on grounds everything", () => {
    for (const k of ["a", "b:en:0", "z:ja:4"]) {
      expect(shouldGround(k, { GEMINI_GROUNDING: "on" })).toBe(true);
      expect(shouldGround(k, { GEMINI_GROUNDING: "ON", GEMINI_GROUNDING_SAMPLE_PCT: "0" })).toBe(true);
    }
  });

  it("neither env set → grounds nothing", () => {
    expect(shouldGround("q:en:0", {})).toBe(false);
  });

  it("SAMPLE_PCT=100 grounds all; 0/invalid grounds none", () => {
    expect(shouldGround("q:en:0", { GEMINI_GROUNDING_SAMPLE_PCT: "100" })).toBe(true);
    expect(shouldGround("q:en:0", { GEMINI_GROUNDING_SAMPLE_PCT: "0" })).toBe(false);
    expect(shouldGround("q:en:0", { GEMINI_GROUNDING_SAMPLE_PCT: "abc" })).toBe(false);
    expect(shouldGround("q:en:0", { GEMINI_GROUNDING_SAMPLE_PCT: "-5" })).toBe(false);
  });

  it("STRICT integer parse (v11 Z2) — exponent/hex/decimal do NOT coerce to a surprising %", () => {
    // Number('1e2')===100 would ground EVERYTHING; Number('0x10')===16. Rejected.
    for (const bad of ["1e2", "0x10", "50.5", "1e1", " 1e2 ", "100.0", "0b1"]) {
      expect(shouldGround("q:en:0", { GEMINI_GROUNDING_SAMPLE_PCT: bad })).toBe(false);
    }
    // Plain integers (optionally whitespace-padded) still work.
    expect(shouldGround("q:en:0", { GEMINI_GROUNDING_SAMPLE_PCT: " 100 " })).toBe(true);
    expect(shouldGround("q:en:0", { GEMINI_GROUNDING_SAMPLE_PCT: " 0 " })).toBe(false);
  });

  it("is deterministic for a given key + pct", () => {
    const env = { GEMINI_GROUNDING_SAMPLE_PCT: "50" };
    for (const k of ["q1:en:0", "q2:ja:3", "q3:de:1"]) {
      expect(shouldGround(k, env)).toBe(shouldGround(k, env));
    }
  });

  it("SAMPLE_PCT≈50 grounds roughly half of many distinct keys", () => {
    const env = { GEMINI_GROUNDING_SAMPLE_PCT: "50" };
    let on = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) if (shouldGround(`q${i}:en:0`, env)) on++;
    expect(on).toBeGreaterThan(N * 0.4);
    expect(on).toBeLessThan(N * 0.6);
  });

  it("does not key on modelId — same (q,lang,sample) grounds identically across engines", () => {
    // The caller keys as `${questionId}:${language}:${sampleIdx}` (no model), so
    // two engines evaluating the same work-unit get the same decision.
    const env = { GEMINI_GROUNDING_SAMPLE_PCT: "30" };
    const key = "question-7:en:2";
    expect(shouldGround(key, env)).toBe(shouldGround(key, env));
  });

  it("stableHash01 returns a value in [0,1) and is stable", () => {
    const h = stableHash01("hello:world:1");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(1);
    expect(stableHash01("hello:world:1")).toBe(h);
  });
});

describe("isSearchEngineSelfRef — earned-source targeting exclusion", () => {
  it("flags search-engine self-reference surfaces (not targetable)", () => {
    for (const d of ["google.com", "www.google.com", "bing.com", "duckduckgo.com", "GOOGLE.COM"]) {
      expect(isSearchEngineSelfRef(d)).toBe(true);
    }
  });
  it("does NOT flag real third-party publishers", () => {
    for (const d of ["reddit.com", "medium.com", "genies.com", "pinku.ai", "g2.com"]) {
      expect(isSearchEngineSelfRef(d)).toBe(false);
    }
  });
});
