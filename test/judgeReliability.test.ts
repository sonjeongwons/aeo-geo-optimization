/**
 * test/judgeReliability.test.ts — X12 judge certification against human gold labels.
 *
 * Tests certifyJudge and certifyJudges from src/judge/judgeReliability.ts.
 * This module runs Gwet's AC1 between the Gemini judge's labels and a human gold set
 * to measure whether the judge can be trusted for a given task.
 */
import { describe, it, expect } from "vitest";
import { certifyJudge, certifyJudges } from "../src/judge/judgeReliability.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build a boolean array of length n with `trueCount` trues at the start. */
function boolArr(n: number, trueCount: number): boolean[] {
  return Array.from({ length: n }, (_, i) => i < trueCount);
}

/** Build n identical labels. */
function fill(n: number, v: boolean): boolean[] {
  return Array(n).fill(v) as boolean[];
}

// ---------------------------------------------------------------------------
// certifyJudge — perfect agreement (status "ok")
// ---------------------------------------------------------------------------

describe("certifyJudge — perfect agreement ≥ minN", () => {
  it('returns status "ok" and ac1 === 1 when judge perfectly matches gold', () => {
    // 30 items, alternating to introduce variance.
    const gold = Array.from({ length: 30 }, (_, i) => i % 2 === 0);
    const judge = [...gold]; // identical

    const result = certifyJudge("sentiment", judge, gold);

    expect(result.status).toBe("ok");
    expect(result.ac1).toBeCloseTo(1, 6);
    expect(result.n).toBe(30);
    expect(result.task).toBe("sentiment");
  });

  it("ac1 is exactly 1 for perfect agreement on all-true gold (prevalence-robust)", () => {
    // AC1 stays at 1 even when all labels are the same (κ would be undefined/0).
    const gold = fill(40, true);
    const judge = fill(40, true);

    const result = certifyJudge("claim_adjudication", judge, gold);

    expect(result.status).toBe("ok");
    expect(result.ac1).toBeCloseTo(1, 6);
    expect(result.prevalence).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// certifyJudge — systematic disagreement (status "low_trust")
// ---------------------------------------------------------------------------

describe("certifyJudge — systematic disagreement", () => {
  it('returns status "low_trust" when judge systematically opposes gold', () => {
    // Judge always disagrees → AC1 will be very negative, well below threshold.
    const gold = Array.from({ length: 40 }, (_, i) => i % 2 === 0);
    const judge = gold.map((v) => !v); // perfect anti-correlation

    const result = certifyJudge("recommendation_polarity", judge, gold);

    expect(result.status).toBe("low_trust");
    expect(result.ac1).not.toBeNull();
    expect(result.ac1!).toBeLessThan(0.6);
    expect(result.note).toContain("low-trust");
    expect(result.note).toContain("recommendation_polarity");
  });

  it("ac1 below custom threshold yields low_trust", () => {
    // 50/50 random → AC1 ≈ 0; custom threshold = 0.9
    const gold = boolArr(30, 15);
    const judge = boolArr(30, 15).reverse();

    const result = certifyJudge("sentiment", judge, gold, { threshold: 0.9 });

    expect(result.status).toBe("low_trust");
    expect(result.threshold).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// certifyJudge — fewer than minN items (status "not_measurable")
// ---------------------------------------------------------------------------

describe("certifyJudge — fewer than minN items", () => {
  it('returns "not_measurable" but surfaces the computed ac1 + a shortfall note (v6 Y4)', () => {
    const gold = boolArr(10, 5);  // only 10 items, need 30
    const judge = boolArr(10, 5);

    const result = certifyJudge("claim_adjudication", judge, gold);

    expect(result.status).toBe("not_measurable");
    // ac1 is the COMPUTED coefficient (null only at n===0); the honesty gate is
    // `status` + `note`, and prevalence is surfaced at the same n — symmetry. (v6 Y4)
    expect(result.ac1).not.toBeNull();
    expect(result.n).toBe(10);
    // Note must mention the counts, not fabricate a certification result.
    expect(result.note).toMatch(/10/);
    expect(result.note).toMatch(/30/);
  });

  it("n=29 (one below default minN=30) is still not_measurable (ac1 still computed)", () => {
    const gold = fill(29, true);
    const judge = fill(29, true);

    const result = certifyJudge("sentiment", judge, gold);

    expect(result.status).toBe("not_measurable");
    expect(result.ac1).not.toBeNull();
    expect(result.n).toBe(29);
  });

  it("custom minN is respected", () => {
    // 10 items, custom minN=5 → measurable.
    const gold = boolArr(10, 3);
    const judge = boolArr(10, 3);

    const result = certifyJudge("sentiment", judge, gold, { minN: 5 });

    // 10 >= 5, and perfect agreement → ok
    expect(result.status).toBe("ok");
    expect(result.ac1).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// certifyJudge — empty arrays
// ---------------------------------------------------------------------------

describe("certifyJudge — empty arrays", () => {
  it("returns not_measurable, ac1 null, prevalence null, n 0", () => {
    const result = certifyJudge("sentiment", [], []);

    expect(result.status).toBe("not_measurable");
    expect(result.ac1).toBeNull();
    expect(result.prevalence).toBeNull();
    expect(result.n).toBe(0);
    expect(result.note).toContain("human gold set");
  });

  it("mismatched lengths: judge empty, gold has items → n=0", () => {
    const result = certifyJudge("claim_adjudication", [], fill(30, true));

    expect(result.n).toBe(0);
    expect(result.ac1).toBeNull();
    expect(result.status).toBe("not_measurable");
  });
});

// ---------------------------------------------------------------------------
// certifyJudge — prevalence computation
// ---------------------------------------------------------------------------

describe("certifyJudge — prevalence", () => {
  it("3 of 10 gold true → prevalence 0.3", () => {
    // Use minN=5 so we get a computed prevalence rather than not_measurable early.
    const gold = boolArr(10, 3); // [true, true, true, false, false, ...]
    const judge = boolArr(10, 3);

    const result = certifyJudge("sentiment", judge, gold, { minN: 5 });

    expect(result.prevalence).toBeCloseTo(0.3, 6);
  });

  it("all gold false → prevalence 0", () => {
    const gold = fill(30, false);
    const judge = fill(30, false);

    const result = certifyJudge("sentiment", judge, gold);

    expect(result.prevalence).toBeCloseTo(0, 6);
  });

  it("all gold true → prevalence 1", () => {
    const gold = fill(30, true);
    const judge = fill(30, true);

    const result = certifyJudge("sentiment", judge, gold);

    expect(result.prevalence).toBeCloseTo(1, 6);
  });

  it("prevalence uses only first n=min(judge,gold) gold items", () => {
    // gold has 40, judge has 30 → n=30; only first 30 gold items counted.
    const gold = [...boolArr(30, 15), ...fill(10, true)]; // first 30 are 50/50
    const judge = fill(30, true);

    const result = certifyJudge("sentiment", judge, gold);

    // prevalence should be 15/30 = 0.5, not 25/40 = 0.625
    expect(result.n).toBe(30);
    expect(result.prevalence).toBeCloseTo(0.5, 6);
  });
});

// ---------------------------------------------------------------------------
// certifyJudges — multi-task fan-out
// ---------------------------------------------------------------------------

describe("certifyJudges", () => {
  it("maps multiple tasks and preserves order", () => {
    const sets = [
      {
        task: "sentiment",
        judgeLabels: fill(30, true),
        goldLabels: fill(30, true),
      },
      {
        task: "claim_adjudication",
        judgeLabels: fill(30, false),
        goldLabels: fill(30, true), // all wrong
      },
      {
        task: "recommendation_polarity",
        judgeLabels: [] as boolean[],
        goldLabels: [] as boolean[],
      },
    ];

    const results = certifyJudges(sets);

    expect(results).toHaveLength(3);
    expect(results[0]!.task).toBe("sentiment");
    expect(results[0]!.status).toBe("ok");

    expect(results[1]!.task).toBe("claim_adjudication");
    expect(results[1]!.status).toBe("low_trust");

    expect(results[2]!.task).toBe("recommendation_polarity");
    expect(results[2]!.status).toBe("not_measurable");
  });

  it("shared opts are forwarded to every task", () => {
    const sets = [
      { task: "a", judgeLabels: fill(5, true), goldLabels: fill(5, true) },
      { task: "b", judgeLabels: fill(5, false), goldLabels: fill(5, false) },
    ];

    const results = certifyJudges(sets, { minN: 3, threshold: 0.5 });

    // Both have n=5 >= minN=3, both perfect agreement → ok
    expect(results[0]!.status).toBe("ok");
    expect(results[1]!.status).toBe("ok");
    // Threshold is propagated
    expect(results[0]!.threshold).toBe(0.5);
    expect(results[1]!.threshold).toBe(0.5);
  });

  it("empty input array returns empty array", () => {
    expect(certifyJudges([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Disclosed threshold and note integrity
// ---------------------------------------------------------------------------

describe("threshold and note integrity", () => {
  it("default threshold is 0.6", () => {
    const result = certifyJudge("t", fill(30, true), fill(30, true));
    expect(result.threshold).toBe(0.6);
  });

  it("ok note includes the ac1 value and threshold", () => {
    const result = certifyJudge("t", fill(30, true), fill(30, true));
    expect(result.note).toContain("1.00");
    expect(result.note).toContain("0.6");
  });

  it("low_trust note contains the task name", () => {
    const gold = Array.from({ length: 30 }, (_, i) => i % 2 === 0);
    const judge = gold.map((v) => !v);
    const result = certifyJudge("my_special_task", judge, gold);
    expect(result.note).toContain("my_special_task");
  });

  it("not_measurable note never PRESENTS the ac1 as a certified number", () => {
    // 5 items < minN=30. ac1 is computed (v6 Y4) but the NOTE must not claim
    // certification — `status` not_measurable is the honesty gate.
    const result = certifyJudge("t", fill(5, true), fill(5, true));
    expect(result.status).toBe("not_measurable");
    expect(result.ac1).not.toBeNull();
    // The note must not present a certified coefficient line ("AC1=…").
    expect(result.note).not.toMatch(/AC1=/);
  });
});
