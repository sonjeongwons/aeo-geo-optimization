/**
 * test/rank-agreement.test.ts
 *
 * LOAD-BEARING test (DESIGN §6): asserts that the judge prompt rule
 * (computeRank / computeAllRanks from domain/rank.ts) and ruleFallback
 * produce IDENTICAL brand_rank values on the same fixtures.
 *
 * This is required so Visibility = Σ(1/rank)/N_total is provenance-independent
 * — judge verdicts and fallback verdicts must agree on rank.
 *
 * >= 3 fixtures required per phase0-tasks.json T15 acceptanceCriteria.
 */

import { describe, it, expect } from "vitest";
import { computeRank, type RankedEntity } from "../src/domain/rank.ts";
import { ruleFallback } from "../src/judge/ruleFallback.js";
import type { RuleFallbackRequest } from "../src/judge/ruleFallback.js";

// ---------------------------------------------------------------------------
// Fixtures
// Each fixture defines: answerText, brand entity, competitor entities.
// We compute rank two ways:
//   A. computeRank(answerText, allEntities, brandName)  ← judge rule
//   B. ruleFallback(req).verdict.brand_rank             ← rule fallback
// and assert A === B.
// ---------------------------------------------------------------------------

interface Fixture {
  label: string;
  answerText: string;
  brandName: string;
  brandAliases: string[];
  competitors: Array<{ name: string; aliases: string[] }>;
  expectedBrandRank: number | null;
}

const FIXTURES: Fixture[] = [
  // Fixture 1: DESIGN §5.4 canonical example
  {
    label: "DESIGN §5.4 example — Replika first, EMORA second, Character.AI third",
    answerText:
      "Replika is popular, but EMORA has better memory, and Character.AI is large.",
    brandName: "EMORA",
    brandAliases: ["emora", "에모라", "エモラ"],
    competitors: [
      { name: "Character.AI", aliases: ["character ai", "c.ai"] },
      { name: "Replika", aliases: ["replika"] },
    ],
    expectedBrandRank: 2,
  },

  // Fixture 2: brand appears first (rank=1)
  {
    label: "brand first, two competitors after",
    answerText:
      "EMORA is the top choice. After that, Replika is decent. Character.AI is also good.",
    brandName: "EMORA",
    brandAliases: ["emora"],
    competitors: [
      { name: "Replika", aliases: ["replika"] },
      { name: "Character.AI", aliases: ["character ai", "c.ai"] },
    ],
    expectedBrandRank: 1,
  },

  // Fixture 3: brand not mentioned (rank=null)
  {
    label: "brand not mentioned — rank=null",
    answerText: "Character.AI and Replika are the most popular AI companion apps.",
    brandName: "EMORA",
    brandAliases: ["emora", "에모라"],
    competitors: [
      { name: "Character.AI", aliases: ["character ai"] },
      { name: "Replika", aliases: ["replika"] },
    ],
    expectedBrandRank: null,
  },

  // Fixture 4: alias match (hangul)
  {
    label: "brand detected via hangul alias — rank=1 (only entity found)",
    answerText: "에모라 앱은 매우 추천합니다.",
    brandName: "EMORA",
    brandAliases: ["emora", "에모라"],
    competitors: [
      { name: "Replika", aliases: ["replika"] },
    ],
    expectedBrandRank: 1,
  },

  // Fixture 5: brand last among 3 (rank=3)
  {
    label: "all three entities present, brand last",
    answerText: "Character.AI leads the market. Replika is growing. EMORA is an emerging brand.",
    brandName: "EMORA",
    brandAliases: ["emora"],
    competitors: [
      { name: "Character.AI", aliases: ["character ai", "c.ai"] },
      { name: "Replika", aliases: ["replika"] },
    ],
    expectedBrandRank: 3,
  },

  // Fixture 6: K-Beauty brand + alias matching
  {
    label: "K-Beauty Care brand alias match — rank=2",
    answerText: "GlowLab is great, and kbeautycare is also excellent for skin analysis.",
    brandName: "K-Beauty Care",
    brandAliases: ["k-beauty care", "kbeauty care", "kbeautycare"],
    competitors: [
      { name: "GlowLab", aliases: ["glowlab", "glow lab"] },
    ],
    expectedBrandRank: 2,
  },

  // Fixture 7: tie-break — two entities have the same earliest alias offset.
  // Both "Zeta" and "Ze" appear at offset 0 in "Zeta is here".
  // normalizeForMatch("ze") matches at 0 in normalizeForMatch("zeta is here").
  // normalizeForMatch("zeta") also matches at 0.
  // Both entities land at firstOffset=0 → tie-break alphabetical by canonical name.
  // "Alpha" < "Zeta" alphabetically → Alpha gets rank 1, Zeta (brand) gets rank 2.
  {
    label: "tie-break: same offset (both aliases start at 0), alphabetical canonical name — brand 'Zeta' rank=2",
    answerText: "Zeta is here",
    brandName: "Zeta",
    brandAliases: ["zeta"],
    competitors: [
      { name: "Alpha", aliases: ["ze"] },
    ],
    // normalizeForMatch: "ze" found at 0, "zeta" found at 0 → tie → "Alpha" < "Zeta" → Alpha=rank1, Zeta=rank2.
    expectedBrandRank: 2,
  },
];

// ---------------------------------------------------------------------------
// Helper: compute rank using domain/rank.ts (the judge rule source)
// ---------------------------------------------------------------------------

function computeRankViaRule(fixture: Fixture): number | null {
  const allEntities: RankedEntity[] = [
    { name: fixture.brandName, aliases: [fixture.brandName, ...fixture.brandAliases] },
    ...fixture.competitors.map((c) => ({
      name: c.name,
      aliases: [c.name, ...c.aliases],
    })),
  ];
  return computeRank(fixture.answerText, allEntities, fixture.brandName);
}

// ---------------------------------------------------------------------------
// Helper: compute rank via ruleFallback
// ---------------------------------------------------------------------------

function computeRankViaFallback(fixture: Fixture): number | null {
  const req: RuleFallbackRequest = {
    answerText: fixture.answerText,
    brandName: fixture.brandName,
    brandAliases: fixture.brandAliases,
    competitors: fixture.competitors,
  };
  const { verdict } = ruleFallback(req);
  return verdict.brand_rank;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rank-agreement: judge rule (computeRank) == ruleFallback output", () => {
  for (const fixture of FIXTURES) {
    it(`[${fixture.label}] brand_rank matches`, () => {
      const ruleRank = computeRankViaRule(fixture);
      const fallbackRank = computeRankViaFallback(fixture);

      // Both methods must agree.
      expect(fallbackRank).toBe(ruleRank);

      // Also verify against the expected value documented in the fixture.
      expect(ruleRank).toBe(fixture.expectedBrandRank);
    });
  }

  // Explicit assertion that we tested >= 3 fixtures (T15 acceptance criteria).
  it("at least 3 fixtures are tested", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(3);
  });
});

describe("rank-agreement: competitor ranks also consistent", () => {
  it("competitor ranks in ruleFallback match computeRank for same answer", () => {
    // Fixture: Replika=1, EMORA=2, Character.AI=3
    const answerText =
      "Replika is popular, but EMORA has better memory, and Character.AI is large.";
    const brandName = "EMORA";
    const competitors = [
      { name: "Character.AI", aliases: ["character ai", "c.ai"] },
      { name: "Replika", aliases: ["replika"] },
    ];

    const allEntities: RankedEntity[] = [
      { name: brandName, aliases: [brandName, "emora", "에모라", "エモラ"] },
      ...competitors.map((c) => ({ name: c.name, aliases: [c.name, ...c.aliases] })),
    ];

    // Rule ranks for competitors
    const replikaRuleRank = computeRank(answerText, allEntities, "Replika");
    const charAIRuleRank = computeRank(answerText, allEntities, "Character.AI");

    // Fallback competitor ranks
    const { verdict } = ruleFallback({
      answerText,
      brandName,
      brandAliases: ["emora", "에모라", "エモラ"],
      competitors,
    });

    const replikaFallback = verdict.competitors_found.find((c) => c.name === "Replika");
    const charAIFallback = verdict.competitors_found.find((c) => c.name === "Character.AI");

    expect(replikaFallback?.rank).toBe(replikaRuleRank);
    expect(charAIFallback?.rank).toBe(charAIRuleRank);
    expect(replikaFallback?.rank).toBe(1);
    expect(charAIFallback?.rank).toBe(3);
  });
});
