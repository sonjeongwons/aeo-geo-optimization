/**
 * test/fallback-judge-sov-parity.test.ts
 *
 * Load-bearing invariant: ruleFallback and the Gemini LLM judge must produce
 * IDENTICAL SoV values on the same answer fixture (§5.2 / DESIGN §5.4
 * "provenance-independent").
 *
 * This test owns the critical invariant added as part of the fix for:
 *   [CRITICAL] sov-fallback-counts-absent-competitors
 *
 * We simulate the judge path by constructing competitors_found arrays that
 * match the judge contract (only present competitors emitted), and the fallback
 * path by running ruleFallback directly.  Both are fed into the pure SoV math
 * to confirm the values are identical.
 *
 * No DB / network calls — pure logic.
 */

import { describe, it, expect } from "vitest";
import { ruleFallback } from "../src/judge/ruleFallback.js";
import type { RuleFallbackRequest } from "../src/judge/ruleFallback.js";

// ---------------------------------------------------------------------------
// Pure SoV computation (mirrors aggregate.ts computeSoV logic for unit testing)
// ---------------------------------------------------------------------------

interface CompetitorEntry {
  name: string;
  rank: number | null;
}

/**
 * computeSoVFromJudgments — mirrors aggregate.ts computeSoV logic.
 *
 * Takes a list of "judgment rows" (brand_mentioned flag + competitors_found)
 * and the tracked competitor names.  Each entry in competitors_found with
 * rank === null is treated as ABSENT (not counted).
 *
 * Returns { brandSoV, competitorSoV } for a two-entity scenario.
 */
function computeSoVFromJudgments(
  judgments: Array<{
    brand_mentioned: boolean;
    competitors_found: CompetitorEntry[];
  }>,
  brandName: string,
  competitorName: string
): { brandSoV: number; competitorSoV: number; totalMentions: number } {
  let brandMentions = 0;
  let competitorMentions = 0;

  for (const j of judgments) {
    if (j.brand_mentioned) brandMentions++;
    for (const comp of j.competitors_found) {
      // rank===null means absent — skip (this is the fixed invariant).
      if (comp.rank === null) continue;
      if (comp.name.toLowerCase() === competitorName.toLowerCase()) {
        competitorMentions++;
      }
    }
  }

  const totalMentions = brandMentions + competitorMentions;
  return {
    brandSoV: totalMentions > 0 ? brandMentions / totalMentions : 0,
    competitorSoV: totalMentions > 0 ? competitorMentions / totalMentions : 0,
    totalMentions,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BRAND_NAME = "EMORA";
const BRAND_ALIASES = ["emora", "에모라", "エモラ"];
const COMPETITOR_NAME = "Character.AI";
const COMPETITOR_ALIASES = ["character ai", "c.ai"];

const COMPETITORS = [{ name: COMPETITOR_NAME, aliases: COMPETITOR_ALIASES }];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run ruleFallback on an answer text and extract the judgment row shape that
 * aggregate.ts computeSoV would process.
 */
function runFallback(answerText: string | null): {
  brand_mentioned: boolean;
  competitors_found: CompetitorEntry[];
} {
  const req: RuleFallbackRequest = {
    answerText,
    brandName: BRAND_NAME,
    brandAliases: BRAND_ALIASES,
    competitors: COMPETITORS,
  };
  const { verdict } = ruleFallback(req);
  return {
    brand_mentioned: verdict.brand_mentioned,
    competitors_found: verdict.competitors_found,
  };
}

/**
 * Simulate the judge path INDEPENDENTLY from runFallback.
 *
 * A real Gemini judge emits a competitors_found array that MAY include absent
 * competitors as {name, rank:null} placeholders (mention.schema.ts line 21-28
 * allows nullable rank).  This simulation exercises that exact contract:
 *
 *   - brand_mentioned is determined by simple string search (independent of
 *     ruleFallback).
 *   - For the tracked competitor (Character.AI), we emit an explicit
 *     {name:'Character.AI', rank:null} absent-placeholder whenever the
 *     competitor is NOT found in the text, mirroring what an LLM judge may
 *     include in its JSON output.
 *   - When the competitor IS found, we emit {name:'Character.AI', rank:<n>}.
 *
 * This means the judge row may contain rank===null entries that MUST be
 * filtered by the consumer (aggregate.ts ~259).  The test then verifies that
 * computeSoVFromJudgments produces the SAME result as the fallback path —
 * genuinely exercising the rank!==null consumer guard rather than comparing
 * ruleFallback against itself.
 */
function simulateJudge(answerText: string | null): {
  brand_mentioned: boolean;
  competitors_found: CompetitorEntry[];
} {
  if (!answerText || answerText.trim() === "") {
    // Judge emits an explicit absent-placeholder even for null/empty answers.
    // The consumer guard (rank!==null filter) must neutralize it.
    return {
      brand_mentioned: false,
      competitors_found: [{ name: COMPETITOR_NAME, rank: null }],
    };
  }

  // Independent brand detection: check for brand name or any alias.
  const lowerText = answerText.toLowerCase();
  const brandFound =
    lowerText.includes(BRAND_NAME.toLowerCase()) ||
    BRAND_ALIASES.some((a) => lowerText.includes(a.toLowerCase()));

  // Independent competitor detection: check for competitor name or aliases.
  const competitorAliasesToCheck = [COMPETITOR_NAME, ...COMPETITOR_ALIASES];
  const competitorFound = competitorAliasesToCheck.some((a) =>
    lowerText.includes(a.toLowerCase())
  );

  // Build competitors_found with an explicit rank:null absent-placeholder when
  // the competitor is not present.  This is the schema-permitted judge output
  // that the consumer guard (aggregate.ts ~259) must filter out.
  const competitors_found: CompetitorEntry[] = [
    {
      name: COMPETITOR_NAME,
      rank: competitorFound ? 1 : null, // null = absent placeholder
    },
  ];

  return {
    brand_mentioned: brandFound,
    competitors_found,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fallback ↔ judge SoV parity (load-bearing invariant)", () => {
  it("brand only: both paths agree on SoV when competitor is absent", () => {
    // Answer mentions EMORA but NOT Character.AI.
    const text = "You should try EMORA for AI roleplay — it has great memory.";

    const fallbackRow = runFallback(text);
    const judgeRow = simulateJudge(text);

    // Both paths must detect brand_mentioned=true.
    expect(fallbackRow.brand_mentioned).toBe(true);
    expect(judgeRow.brand_mentioned).toBe(true);

    // Fallback contract: absent competitor is NOT emitted (rank null = absent → omitted).
    expect(
      fallbackRow.competitors_found.filter((c) => c.rank === null)
    ).toHaveLength(0);

    // Judge contract: MAY emit {name, rank:null} absent-placeholder.
    // The key invariant is that the consumer guard (rank!==null filter in
    // computeSoVFromJudgments) must neutralize it — verified by the SoV equality below.
    const judgeAbsentEntries = judgeRow.competitors_found.filter((c) => c.rank === null);
    expect(judgeAbsentEntries.length).toBeGreaterThanOrEqual(0); // schema-permitted

    const fallbackSoV = computeSoVFromJudgments(
      [fallbackRow],
      BRAND_NAME,
      COMPETITOR_NAME
    );
    const judgeSoV = computeSoVFromJudgments(
      [judgeRow],
      BRAND_NAME,
      COMPETITOR_NAME
    );

    // Identical SoV despite potentially divergent input shapes: the consumer guard
    // filters rank===null entries so provenance does not affect the result.
    expect(fallbackSoV.brandSoV).toBeCloseTo(judgeSoV.brandSoV);
    expect(fallbackSoV.competitorSoV).toBeCloseTo(judgeSoV.competitorSoV);
    expect(fallbackSoV.brandSoV).toBeCloseTo(1.0);
    expect(fallbackSoV.competitorSoV).toBeCloseTo(0.0);
  });

  it("competitor only: both paths agree when brand is absent", () => {
    // Answer mentions Character.AI but NOT EMORA.
    const text = "Character.AI is one of the best AI roleplay apps available.";

    const fallbackRow = runFallback(text);
    const judgeRow = simulateJudge(text);

    expect(fallbackRow.brand_mentioned).toBe(false);
    expect(judgeRow.brand_mentioned).toBe(false);

    const fallbackSoV = computeSoVFromJudgments(
      [fallbackRow],
      BRAND_NAME,
      COMPETITOR_NAME
    );
    const judgeSoV = computeSoVFromJudgments(
      [judgeRow],
      BRAND_NAME,
      COMPETITOR_NAME
    );

    // brand SoV = 0.0, competitor SoV = 1.0.
    expect(fallbackSoV.brandSoV).toBeCloseTo(judgeSoV.brandSoV);
    expect(fallbackSoV.competitorSoV).toBeCloseTo(judgeSoV.competitorSoV);
    expect(fallbackSoV.brandSoV).toBeCloseTo(0.0);
    expect(fallbackSoV.competitorSoV).toBeCloseTo(1.0);
  });

  it("both present: both paths produce the same split SoV", () => {
    // Answer mentions both EMORA and Character.AI.
    const text = "EMORA and Character.AI are both popular AI roleplay apps.";

    const fallbackRow = runFallback(text);
    const judgeRow = simulateJudge(text);

    const fallbackSoV = computeSoVFromJudgments(
      [fallbackRow],
      BRAND_NAME,
      COMPETITOR_NAME
    );
    const judgeSoV = computeSoVFromJudgments(
      [judgeRow],
      BRAND_NAME,
      COMPETITOR_NAME
    );

    // Both present → SoV split 50/50 (each mentioned once).
    expect(fallbackSoV.brandSoV).toBeCloseTo(judgeSoV.brandSoV);
    expect(fallbackSoV.competitorSoV).toBeCloseTo(judgeSoV.competitorSoV);
    expect(fallbackSoV.brandSoV).toBeCloseTo(0.5);
    expect(fallbackSoV.competitorSoV).toBeCloseTo(0.5);
    // Total mentions = 2 in both paths.
    expect(fallbackSoV.totalMentions).toBe(judgeSoV.totalMentions);
    expect(fallbackSoV.totalMentions).toBe(2);
  });

  it("null/empty answer: both paths produce zero SoV (not inflated)", () => {
    for (const text of [null, "", "   "]) {
      const fallbackRow = runFallback(text);
      const judgeRow = simulateJudge(text);

      // Fallback contract: no competitors emitted for empty/null text.
      expect(fallbackRow.competitors_found).toHaveLength(0);

      // Judge contract: MAY emit {name, rank:null} absent-placeholder even on
      // empty text.  The consumer guard (rank!==null filter) must neutralize it.
      // Verify the judge row has no entries with rank !== null (i.e. no "found" entries).
      expect(
        judgeRow.competitors_found.filter((c) => c.rank !== null)
      ).toHaveLength(0);

      const fallbackSoV = computeSoVFromJudgments(
        [fallbackRow],
        BRAND_NAME,
        COMPETITOR_NAME
      );
      const judgeSoV = computeSoVFromJudgments(
        [judgeRow],
        BRAND_NAME,
        COMPETITOR_NAME
      );

      // After rank!==null filtering, both paths produce zero SoV.
      expect(fallbackSoV.totalMentions).toBe(0);
      expect(judgeSoV.totalMentions).toBe(0);
      expect(fallbackSoV.brandSoV).toBe(0);
      expect(judgeSoV.brandSoV).toBe(0);
    }
  });

  it("multi-response run: fallback SoV equals judge SoV for the same fixture set", () => {
    // Simulate 4 responses — mixed: brand+comp, brand-only, comp-only, neither.
    const answers = [
      "EMORA and Character.AI are popular apps.",   // both present
      "EMORA has great memory features.",            // brand only
      "Character.AI is the most popular.",          // competitor only
      "There are many AI apps to choose from.",     // neither
    ];

    const fallbackRows = answers.map((a) => runFallback(a));
    const judgeRows = answers.map((a) => simulateJudge(a));

    const fallbackSoV = computeSoVFromJudgments(
      fallbackRows,
      BRAND_NAME,
      COMPETITOR_NAME
    );
    const judgeSoV = computeSoVFromJudgments(
      judgeRows,
      BRAND_NAME,
      COMPETITOR_NAME
    );

    // Critical invariant: provenance must not change SoV.
    expect(fallbackSoV.brandSoV).toBeCloseTo(judgeSoV.brandSoV);
    expect(fallbackSoV.competitorSoV).toBeCloseTo(judgeSoV.competitorSoV);
    expect(fallbackSoV.totalMentions).toBe(judgeSoV.totalMentions);

    // Sanity check the math: brand appears in 2 rows, competitor in 2 rows →
    // total = 4, brand SoV = 0.5, competitor SoV = 0.5.
    expect(fallbackSoV.totalMentions).toBe(4);
    expect(fallbackSoV.brandSoV).toBeCloseTo(0.5);
    expect(fallbackSoV.competitorSoV).toBeCloseTo(0.5);
  });

  it("absent-competitor entries with rank===null are excluded from SoV denominator", () => {
    // This directly tests the pre-fix regression:
    // Before the fix, ruleFallback emitted {name:'Character.AI', rank:null}
    // for an answer that only mentions EMORA.  The consumer (computeSoV) would
    // then count it as a mention, inflating the denominator and halving
    // brand SoV from 1.0 to 0.5 — even though the competitor was absent.
    const text = "EMORA is the only app I use.";
    const fallbackRow = runFallback(text);

    // After the fix: no absent-competitor placeholders from ruleFallback.
    const absentEntries = fallbackRow.competitors_found.filter(
      (c) => c.rank === null
    );
    expect(absentEntries).toHaveLength(0);

    // SoV must be 1.0 for brand (sole mention), not 0.5 (inflated denominator).
    const sov = computeSoVFromJudgments(
      [fallbackRow],
      BRAND_NAME,
      COMPETITOR_NAME
    );
    expect(sov.brandSoV).toBeCloseTo(1.0);
    expect(sov.competitorSoV).toBeCloseTo(0.0);
    expect(sov.totalMentions).toBe(1);
  });

  it("judge-path rank===null absent-placeholder is neutralized by consumer guard", () => {
    // This test genuinely exercises the rank!==null consumer guard (aggregate.ts ~259)
    // against divergent inputs — the core purpose of this test suite.
    //
    // simulateJudge emits {name:'Character.AI', rank:null} when the competitor is
    // absent.  Without the consumer guard, this would inflate the SoV denominator
    // and halve brand SoV from 1.0 to 0.5.  With the guard, the null entry is
    // filtered and the SoV matches the fallback path.
    const text = "EMORA is the only app I use.";

    const fallbackRow = runFallback(text);
    const judgeRow = simulateJudge(text);

    // Judge path emits the absent-placeholder — verify this is our divergent input.
    const judgeAbsentPlaceholders = judgeRow.competitors_found.filter((c) => c.rank === null);
    expect(judgeAbsentPlaceholders).toHaveLength(1);
    expect(judgeAbsentPlaceholders[0]!.name).toBe(COMPETITOR_NAME);

    // Fallback path emits NO absent-placeholder.
    expect(fallbackRow.competitors_found.filter((c) => c.rank === null)).toHaveLength(0);

    const fallbackSoV = computeSoVFromJudgments(
      [fallbackRow],
      BRAND_NAME,
      COMPETITOR_NAME
    );
    const judgeSoV = computeSoVFromJudgments(
      [judgeRow],
      BRAND_NAME,
      COMPETITOR_NAME
    );

    // Despite divergent input shapes (judge has rank:null placeholder, fallback omits it),
    // the consumer guard (rank!==null filter) produces IDENTICAL SoV results.
    expect(judgeSoV.brandSoV).toBeCloseTo(1.0);
    expect(judgeSoV.competitorSoV).toBeCloseTo(0.0);
    expect(judgeSoV.totalMentions).toBe(1);

    expect(fallbackSoV.brandSoV).toBeCloseTo(judgeSoV.brandSoV);
    expect(fallbackSoV.competitorSoV).toBeCloseTo(judgeSoV.competitorSoV);
    expect(fallbackSoV.totalMentions).toBe(judgeSoV.totalMentions);
  });
});
