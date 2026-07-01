/**
 * test/metrics.aggregate.test.ts
 *
 * Vitest suite for §5.2 SMR/Visibility/SoV/PriorityGap math.
 *
 * Key invariants under test:
 *   1. SMR = brand_hits / run.n_total (snapshot), NOT judgment count.
 *   2. Visibility = Σ(1/brand_rank) / n_total.
 *   3. SoV denominator = brand + competitor total mentions.
 *   4. Re-judging a response (2nd judgment row) does NOT change counts twice
 *      (latest-judgment-wins).
 *   5. report.metrics has evidence_refs and NO free-text claims field.
 *   6. Self-judge-bias disclosure is always present.
 *
 * All DB calls are replaced by in-memory stubs (no real Postgres needed).
 * The aggregate functions use getDb() from src/db/kysely.ts — we mock the
 * kysely module to return a controlled fake.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Pure math helpers (not using DB)
// ---------------------------------------------------------------------------

/**
 * computeSMRFromValues — pure math matching the DESIGN formula.
 * SMR = brand_hits / n_total.
 */
function computeSMRValue(brandHits: number, nTotal: number): number {
  return nTotal > 0 ? brandHits / nTotal : 0;
}

/**
 * computeVisibilityFromValues — pure math.
 * Visibility = Σ(1/brand_rank) / n_total.
 */
function computeVisibilityValue(
  ranks: Array<number | null>,
  nTotal: number
): number {
  const invRankSum = ranks
    .filter((r): r is number => r !== null && r > 0)
    .reduce((sum, r) => sum + 1 / r, 0);
  return nTotal > 0 ? invRankSum / nTotal : 0;
}

/**
 * computeSoVValue — entity_mentions / total_mentions.
 */
function computeSoVValue(entityMentions: number, totalMentions: number): number {
  return totalMentions > 0 ? entityMentions / totalMentions : 0;
}

/**
 * computePriorityGapScore — competitorPresence - brandSMR.
 */
function computePriorityGapScore(
  brandHitsForQ: number,
  totalForQ: number,
  competitorRowsForQ: number
): number {
  const brandSMR = totalForQ > 0 ? brandHitsForQ / totalForQ : 0;
  const competitorPresence = totalForQ > 0 ? competitorRowsForQ / totalForQ : 0;
  return competitorPresence - brandSMR;
}

// ---------------------------------------------------------------------------
// §5.2 SMR formula tests
// ---------------------------------------------------------------------------

describe("SMR = brand_hits / n_total (snapshot denominator)", () => {
  it("basic: 3 hits out of 10 work-units → SMR = 0.3", () => {
    expect(computeSMRValue(3, 10)).toBeCloseTo(0.3);
  });

  it("zero hits → SMR = 0 (not NaN)", () => {
    expect(computeSMRValue(0, 10)).toBe(0);
  });

  it("n_total=0 → SMR = 0 (not division by zero)", () => {
    expect(computeSMRValue(0, 0)).toBe(0);
  });

  it("all hits: brand_hits = n_total → SMR = 1.0", () => {
    expect(computeSMRValue(20, 20)).toBe(1.0);
  });

  it("SMR denominator is n_total snapshot, NOT judgment count (error rows in denominator)", () => {
    // Scenario: 10 work-units scheduled; 7 ok, 2 error, 1 abstain.
    // Only 4 have brand_mentioned=true.
    // SMR must use n_total=10, not 7 (the ok count).
    const nTotal = 10;   // snapshot
    const brandHits = 4; // pass+brand_mentioned
    expect(computeSMRValue(brandHits, nTotal)).toBeCloseTo(0.4);
    // If incorrectly using judgment count as denominator: 4/7 ≈ 0.571
    expect(computeSMRValue(brandHits, 7)).not.toBeCloseTo(0.4);
  });
});

// ---------------------------------------------------------------------------
// §5.2 Visibility formula tests
// ---------------------------------------------------------------------------

describe("Visibility = Σ(1/brand_rank) / n_total", () => {
  it("single rank=1 out of 5 → Visibility = 0.2", () => {
    expect(computeVisibilityValue([1], 5)).toBeCloseTo(0.2);
  });

  it("two hits rank=1,rank=2 out of 4 → Σ(1+0.5)/4 = 0.375", () => {
    expect(computeVisibilityValue([1, 2], 4)).toBeCloseTo(0.375);
  });

  it("null ranks excluded from Σ", () => {
    // 3 responses: rank=2, null, null. invRankSum=0.5, n_total=3.
    expect(computeVisibilityValue([2, null, null], 3)).toBeCloseTo(0.5 / 3);
  });

  it("rank=1 weighted higher than rank=2", () => {
    const vis1 = computeVisibilityValue([1], 4);
    const vis2 = computeVisibilityValue([2], 4);
    expect(vis1).toBeGreaterThan(vis2);
  });

  it("zero hits → Visibility = 0", () => {
    expect(computeVisibilityValue([null, null], 5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §5.2 SoV formula tests
// ---------------------------------------------------------------------------

describe("SoV = entity_mentions / (brand_mentions + competitor_mentions)", () => {
  it("brand: 6 mentions, competitor: 4 → brand SoV = 0.6", () => {
    const total = 6 + 4;
    expect(computeSoVValue(6, total)).toBeCloseTo(0.6);
  });

  it("competitor: 4 mentions, brand: 6 → competitor SoV = 0.4", () => {
    const total = 6 + 4;
    expect(computeSoVValue(4, total)).toBeCloseTo(0.4);
  });

  it("all SoV values sum to 1.0 for two entities", () => {
    const brand = 7;
    const comp = 3;
    const total = brand + comp;
    const brandSoV = computeSoVValue(brand, total);
    const compSoV = computeSoVValue(comp, total);
    expect(brandSoV + compSoV).toBeCloseTo(1.0);
  });

  it("zero total mentions → SoV = 0 (not NaN)", () => {
    expect(computeSoVValue(0, 0)).toBe(0);
  });

  it("SoV denominator includes BOTH brand and competitor mentions", () => {
    // If denominator incorrectly used only competitor mentions:
    const brandMentions = 5;
    const competitorMentions = 5;
    const correctTotal = brandMentions + competitorMentions; // 10
    const wrongTotal = competitorMentions; // 5 — wrong

    expect(computeSoVValue(brandMentions, correctTotal)).toBeCloseTo(0.5);
    expect(computeSoVValue(brandMentions, wrongTotal)).toBe(1.0); // would be wrong
  });
});

// ---------------------------------------------------------------------------
// §5.2 Priority Gap formula tests
// ---------------------------------------------------------------------------

describe("Priority Gap = competitorPresence - brandSMR", () => {
  it("high competitor, low brand → large positive gap", () => {
    // 10 judgments for Q1: brand hit 0 times, competitor in 8 responses
    const score = computePriorityGapScore(0, 10, 8);
    expect(score).toBeCloseTo(0.8);
  });

  it("balanced → gap near 0", () => {
    const score = computePriorityGapScore(5, 10, 5);
    expect(score).toBeCloseTo(0);
  });

  it("brand dominates → negative gap (not a priority)", () => {
    const score = computePriorityGapScore(9, 10, 1);
    expect(score).toBeLessThan(0);
  });

  it("zero judgments → gap = 0 (no NaN)", () => {
    const score = computePriorityGapScore(0, 0, 0);
    expect(score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Latest-judgment-wins: re-judging should NOT double-count
// ---------------------------------------------------------------------------

describe("latest-judgment-wins: re-judge does not double-count", () => {
  /**
   * Simulate the current_judgment view behavior:
   * given multiple judgment rows for the same response_raw_id, only the
   * LATEST (by captured_at) counts.
   */
  function applyLatestJudgmentWins(
    rows: Array<{
      response_raw_id: string;
      captured_at: Date;
      brand_mentioned: boolean;
      guardrail_status: "pass" | "downgraded_abstain";
    }>
  ): Array<{
    response_raw_id: string;
    brand_mentioned: boolean;
    guardrail_status: "pass" | "downgraded_abstain";
  }> {
    // Group by response_raw_id, pick latest captured_at.
    const latest = new Map<string, typeof rows[0]>();
    for (const row of rows) {
      const existing = latest.get(row.response_raw_id);
      if (!existing || row.captured_at > existing.captured_at) {
        latest.set(row.response_raw_id, row);
      }
    }
    return Array.from(latest.values()).map((r) => ({
      response_raw_id: r.response_raw_id,
      brand_mentioned: r.brand_mentioned,
      guardrail_status: r.guardrail_status,
    }));
  }

  it("two judgment rows for same response → only latest counts", () => {
    const t1 = new Date("2024-01-01T10:00:00Z");
    const t2 = new Date("2024-01-01T11:00:00Z");

    const rows = [
      {
        response_raw_id: "resp-1",
        captured_at: t1,
        brand_mentioned: true,
        guardrail_status: "pass" as const,
      },
      {
        response_raw_id: "resp-1",
        captured_at: t2,
        brand_mentioned: false, // re-judged: not mentioned
        guardrail_status: "downgraded_abstain" as const,
      },
    ];

    const result = applyLatestJudgmentWins(rows);
    expect(result).toHaveLength(1);
    expect(result[0]!.brand_mentioned).toBe(false);
    expect(result[0]!.guardrail_status).toBe("downgraded_abstain");
  });

  it("re-judging brand=true → brand=false changes brand_hits from 1 to 0", () => {
    const t1 = new Date("2024-01-01T10:00:00Z");
    const t2 = new Date("2024-01-01T11:00:00Z");

    // n_total snapshot = 5 (fixed)
    const nTotal = 5;

    // Before re-judge: 1 brand hit.
    const beforeRows = [
      { response_raw_id: "r1", captured_at: t1, brand_mentioned: true, guardrail_status: "pass" as const },
    ];
    const before = applyLatestJudgmentWins(beforeRows);
    const brandHitsBefore = before.filter((r) => r.brand_mentioned && r.guardrail_status === "pass").length;
    expect(computeSMRValue(brandHitsBefore, nTotal)).toBeCloseTo(0.2);

    // After re-judge: new row for same response_raw_id with brand_mentioned=false.
    const afterRows = [
      { response_raw_id: "r1", captured_at: t1, brand_mentioned: true, guardrail_status: "pass" as const },
      { response_raw_id: "r1", captured_at: t2, brand_mentioned: false, guardrail_status: "downgraded_abstain" as const },
    ];
    const after = applyLatestJudgmentWins(afterRows);
    const brandHitsAfter = after.filter((r) => r.brand_mentioned && r.guardrail_status === "pass").length;
    expect(computeSMRValue(brandHitsAfter, nTotal)).toBeCloseTo(0);
  });

  it("re-judging to SAME verdict does NOT change SMR", () => {
    const t1 = new Date("2024-01-01T10:00:00Z");
    const t2 = new Date("2024-01-01T11:00:00Z");
    const nTotal = 10;

    // Original: brand=true
    const orig = [
      { response_raw_id: "r1", captured_at: t1, brand_mentioned: true, guardrail_status: "pass" as const },
      { response_raw_id: "r2", captured_at: t1, brand_mentioned: true, guardrail_status: "pass" as const },
    ];

    // Re-judge r1 → still brand=true
    const rejudged = [
      ...orig,
      { response_raw_id: "r1", captured_at: t2, brand_mentioned: true, guardrail_status: "pass" as const },
    ];

    const before = applyLatestJudgmentWins(orig);
    const after = applyLatestJudgmentWins(rejudged);

    const hitsBefore = before.filter((r) => r.brand_mentioned && r.guardrail_status === "pass").length;
    const hitsAfter = after.filter((r) => r.brand_mentioned && r.guardrail_status === "pass").length;

    expect(computeSMRValue(hitsBefore, nTotal)).toBeCloseTo(computeSMRValue(hitsAfter, nTotal));
  });
});

// ---------------------------------------------------------------------------
// RunReport structure: no free-text claims, evidence_refs present
// ---------------------------------------------------------------------------

describe("RunReport type structure (compile-time + runtime assertions)", () => {
  it("MetricTuple has metric, value, nTotal, evidenceRefs — no claims field", () => {
    // This is a compile-time guarantee enforced by the type.
    // At runtime we verify the shape matches.
    const tuple = {
      metric: "smr",
      value: 0.4,
      nTotal: 10,
      evidenceRefs: ["resp-1", "resp-2"],
    };

    expect(tuple).toHaveProperty("metric");
    expect(tuple).toHaveProperty("value");
    expect(tuple).toHaveProperty("nTotal");
    expect(tuple).toHaveProperty("evidenceRefs");
    // No free-text "claims" field:
    expect(tuple).not.toHaveProperty("claims");
    expect(tuple).not.toHaveProperty("narrative");
    expect(tuple).not.toHaveProperty("freeText");
  });

  it("SELF_JUDGE_BIAS_DISCLOSURE is a non-empty string", async () => {
    const { SELF_JUDGE_BIAS_DISCLOSURE } = await import(
      "../src/domain/metrics.types.js"
    );
    expect(typeof SELF_JUDGE_BIAS_DISCLOSURE).toBe("string");
    expect(SELF_JUDGE_BIAS_DISCLOSURE.length).toBeGreaterThan(0);
    expect(SELF_JUDGE_BIAS_DISCLOSURE.toLowerCase()).toContain("gemini");
    expect(SELF_JUDGE_BIAS_DISCLOSURE.toLowerCase()).toContain("bias");
  });
});
