/**
 * test/rule-fallback.test.ts
 *
 * Vitest suite for src/judge/ruleFallback.ts.
 *
 * Tests:
 *   - Basic brand detection (alias matching)
 *   - Transliterated alias detection (hangul/katakana)
 *   - Rank assignment via domain/rank.ts
 *   - Sentiment always = 'neutral' (never fabricated)
 *   - Evidence span is returned when brand is found
 *   - Competitors found with correct ranks
 *   - Null/empty answer text → brand_mentioned=false
 */

import { describe, it, expect } from "vitest";
import { ruleFallback } from "../src/judge/ruleFallback.js";
import type { RuleFallbackRequest } from "../src/judge/ruleFallback.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMORA_BRAND = "EMORA";
const EMORA_ALIASES = ["emora", "에모라", "エモラ"]; // hangul + katakana aliases

const KBEAUTY_BRAND = "K-Beauty Care";
const KBEAUTY_ALIASES = ["k-beauty care", "kbeauty care", "kbeautycare"];

const COMPETITORS = [
  { name: "Character.AI", aliases: ["character ai", "c.ai"] },
  { name: "Replika", aliases: ["replika"] },
];

// ---------------------------------------------------------------------------
// Basic detection
// ---------------------------------------------------------------------------

describe("ruleFallback — basic brand detection", () => {
  it("detects brand by canonical name", () => {
    const req: RuleFallbackRequest = {
      answerText: "You should try EMORA — it has great memory.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(true);
    expect(verdict.evidence).not.toBeNull();
    expect(verdict.evidence?.quote).toBeTruthy();
  });

  it("returns brand_mentioned=false when brand absent", () => {
    const req: RuleFallbackRequest = {
      answerText: "Character.AI is one of the best roleplay apps.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(false);
    expect(verdict.evidence).toBeNull();
    expect(verdict.brand_rank).toBeNull();
  });

  it("null answer text → brand_mentioned=false", () => {
    const req: RuleFallbackRequest = {
      answerText: null,
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(false);
  });

  it("empty string → brand_mentioned=false", () => {
    const req: RuleFallbackRequest = {
      answerText: "   ",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alias matching (NFC-normalized, case-insensitive)
// ---------------------------------------------------------------------------

describe("ruleFallback — alias matching", () => {
  it("detects brand via lowercase alias", () => {
    const req: RuleFallbackRequest = {
      answerText: "Check out emora for the best experience.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(true);
  });

  it("detects brand via hangul alias (에모라)", () => {
    const req: RuleFallbackRequest = {
      answerText: "에모라 앱을 추천합니다. 기억력이 뛰어납니다.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(true);
    expect(verdict.evidence).not.toBeNull();
  });

  it("detects brand via katakana alias (エモラ)", () => {
    const req: RuleFallbackRequest = {
      answerText: "エモラはグループチャット機能があります。",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(true);
    expect(verdict.evidence).not.toBeNull();
  });

  it("detects K-Beauty Care via alias (kbeautycare)", () => {
    const req: RuleFallbackRequest = {
      answerText: "I use kbeautycare for my skin analysis every morning.",
      brandName: KBEAUTY_BRAND,
      brandAliases: KBEAUTY_ALIASES,
      competitors: [],
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sentiment always neutral
// ---------------------------------------------------------------------------

describe("ruleFallback — sentiment always neutral", () => {
  it("brand mentioned → sentiment = 'neutral'", () => {
    const req: RuleFallbackRequest = {
      answerText: "EMORA is absolutely amazing and the best app!",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.sentiment).toBe("neutral");
  });

  it("brand not mentioned → sentiment = null", () => {
    const req: RuleFallbackRequest = {
      answerText: "Character.AI is great for roleplay.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.sentiment).toBeNull();
  });

  it("negative context → sentiment still 'neutral' (never fabricated)", () => {
    const req: RuleFallbackRequest = {
      answerText: "EMORA is terrible and I hate it.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(true);
    expect(verdict.sentiment).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// Rank assignment
// ---------------------------------------------------------------------------

describe("ruleFallback — brand_rank assignment", () => {
  it("brand appears first → brand_rank = 1", () => {
    const req: RuleFallbackRequest = {
      answerText: "EMORA is great. Character.AI is also popular. Replika is third.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(true);
    expect(verdict.brand_rank).toBe(1);
  });

  it("brand appears after one competitor → brand_rank = 2", () => {
    // DESIGN §5.4 example: Replika first, then EMORA, then Character.AI
    const req: RuleFallbackRequest = {
      answerText:
        "Replika is popular, but EMORA has better memory, and Character.AI is large.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_mentioned).toBe(true);
    expect(verdict.brand_rank).toBe(2);
  });

  it("brand appears last → brand_rank = 3", () => {
    const req: RuleFallbackRequest = {
      answerText: "Character.AI leads. Replika is second. EMORA is third.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_rank).toBe(3);
  });

  it("brand not mentioned → brand_rank = null", () => {
    const req: RuleFallbackRequest = {
      answerText: "Character.AI and Replika are the top choices.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.brand_rank).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Competitors found
// ---------------------------------------------------------------------------

describe("ruleFallback — competitors_found", () => {
  it("lists all tracked competitors with ranks", () => {
    const req: RuleFallbackRequest = {
      answerText: "Replika is popular, then EMORA, then Character.AI.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);

    const charAI = verdict.competitors_found.find((c) => c.name === "Character.AI");
    const replika = verdict.competitors_found.find((c) => c.name === "Replika");

    expect(charAI).toBeDefined();
    expect(replika).toBeDefined();
    expect(replika!.rank).toBe(1); // Replika first
    expect(charAI!.rank).toBe(3); // Character.AI third
  });

  it("competitors absent from text → NOT emitted in competitors_found", () => {
    // Fix: ruleFallback now matches the Gemini judge contract — only FOUND
    // competitors (rank !== null) are emitted.  Absent ones are omitted.
    const req: RuleFallbackRequest = {
      answerText: "EMORA is the best app for roleplay.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);

    // Neither Character.AI nor Replika is in the text → neither emitted.
    expect(verdict.competitors_found).toHaveLength(0);
    // All emitted entries (if any) must have a non-null rank.
    for (const comp of verdict.competitors_found) {
      expect(comp.rank).not.toBeNull();
    }
  });

  it("no competitors found → competitors_found is empty (not all tracked)", () => {
    // Canonical contract: only present competitors appear (matches Gemini judge).
    const req: RuleFallbackRequest = {
      answerText: "Try EMORA today.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    // No tracked competitors appear → empty list, NOT the full set with rank=null.
    expect(verdict.competitors_found).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Evidence span
// ---------------------------------------------------------------------------

describe("ruleFallback — evidence span", () => {
  it("evidence.start < evidence.end when brand mentioned", () => {
    const req: RuleFallbackRequest = {
      answerText: "You should definitely try EMORA — it's incredible.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.evidence).not.toBeNull();
    expect(verdict.evidence!.start).toBeGreaterThanOrEqual(0);
    expect(verdict.evidence!.end).toBeGreaterThan(verdict.evidence!.start);
  });

  it("evidence.quote contains the matched alias text (case-insensitive substring)", () => {
    const req: RuleFallbackRequest = {
      answerText: "The app emora is multilingual and fun.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.evidence).not.toBeNull();
    // Quote should contain "emora" somewhere
    expect(verdict.evidence!.quote.toLowerCase()).toContain("emora");
  });

  it("evidence is null when brand not found", () => {
    const req: RuleFallbackRequest = {
      answerText: "Replika and Character.AI are popular.",
      brandName: EMORA_BRAND,
      brandAliases: EMORA_ALIASES,
      competitors: COMPETITORS,
    };
    const { verdict } = ruleFallback(req);
    expect(verdict.evidence).toBeNull();
  });
});
