/** test/per-prompt-citation-byengine.test.ts — SOTA sweep C + D pure tallies. */
import { describe, it, expect } from "vitest";
import {
  tallyPerPromptVisibility,
  tallyCitationShareByModel,
  type TallyJudgment,
  type WorkUnitSlice,
} from "../src/metrics/promptVisibility.js";

function j(partial: Partial<TallyJudgment>): TallyJudgment {
  return {
    model_id: "m1",
    language: "en",
    question_id: "q1",
    brand_mentioned: true,
    citation_present: false,
    guardrail_status: "pass",
    response_raw_id: `r${Math.random()}`,
    ...partial,
  };
}

describe("tallyPerPromptVisibility (proposal C)", () => {
  it("computes per-cell mention rate over the frozen work_unit denominator", () => {
    const slices: WorkUnitSlice[] = [
      { model_id: "m1", language: "en", question_id: "q1", count: 4 },
    ];
    const judgments = [
      j({ response_raw_id: "a" }),
      j({ response_raw_id: "b" }),
      j({ brand_mentioned: false, response_raw_id: "c" }), // not a hit
    ];
    const out = tallyPerPromptVisibility(slices, judgments);
    expect(out).toHaveLength(1);
    expect(out[0]!.nSamples).toBe(4);
    expect(out[0]!.brandHits).toBe(2);
    expect(out[0]!.mentionRate).toBeCloseTo(0.5, 6);
    expect(out[0]!.lowPower).toBe(true); // nSamples 4 < 30
    expect(out[0]!.ci95.lower).toBeLessThan(0.5);
    expect(out[0]!.ci95.upper).toBeGreaterThan(0.5);
    expect(out[0]!.evidenceRefs.sort()).toEqual(["a", "b"]);
  });

  it("excludes downgraded (non-pass) rows from hits", () => {
    const slices: WorkUnitSlice[] = [
      { model_id: "m1", language: "en", question_id: "q1", count: 2 },
    ];
    const out = tallyPerPromptVisibility(slices, [
      j({ guardrail_status: "downgraded_abstain", response_raw_id: "a" }),
      j({ response_raw_id: "b" }),
    ]);
    expect(out[0]!.brandHits).toBe(1);
  });

  it("separates cells by (question, model, language)", () => {
    const slices: WorkUnitSlice[] = [
      { model_id: "m1", language: "en", question_id: "q1", count: 3 },
      { model_id: "m2", language: "en", question_id: "q1", count: 3 },
      { model_id: "m1", language: "ko", question_id: "q1", count: 3 },
    ];
    const out = tallyPerPromptVisibility(slices, [
      j({ model_id: "m1", language: "en", response_raw_id: "a" }),
      j({ model_id: "m2", language: "en", response_raw_id: "b" }),
    ]);
    expect(out).toHaveLength(3);
    const m1en = out.find((o) => o.modelId === "m1" && o.language === "en")!;
    const m1ko = out.find((o) => o.modelId === "m1" && o.language === "ko")!;
    expect(m1en.brandHits).toBe(1);
    expect(m1ko.brandHits).toBe(0);
  });

  it("flags lowPower=false only when nSamples >= 30", () => {
    const out = tallyPerPromptVisibility(
      [{ model_id: "m1", language: "en", question_id: "q1", count: 30 }],
      [],
    );
    expect(out[0]!.lowPower).toBe(false);
  });
});

describe("tallyCitationShareByModel (proposal D)", () => {
  const slices: WorkUnitSlice[] = [
    { model_id: "m1", language: "en", question_id: "q1", count: 60 },
    { model_id: "m1", language: "en", question_id: "q2", count: 60 }, // m1 total 120
    { model_id: "m2", language: "en", question_id: "q1", count: 50 },
  ];

  it("counts only citation_present ∧ brand_mentioned ∧ pass per engine", () => {
    const out = tallyCitationShareByModel(slices, [
      j({ model_id: "m1", citation_present: true, response_raw_id: "a" }),
      j({ model_id: "m1", citation_present: true, response_raw_id: "b" }),
      j({ model_id: "m1", citation_present: false, response_raw_id: "c" }), // mention only
      j({ model_id: "m1", citation_present: true, brand_mentioned: false, response_raw_id: "d" }), // no mention
      j({ model_id: "m2", citation_present: true, response_raw_id: "e" }),
    ]);
    const m1 = out.find((o) => o.modelId === "m1")!;
    const m2 = out.find((o) => o.modelId === "m2")!;
    expect(m1.citationHits).toBe(2);
    expect(m1.sliceTotal).toBe(120);
    expect(m1.citationShare).toBeCloseTo(2 / 120, 6);
    expect(m1.lowPower).toBe(false); // 120 >= 100
    expect(m2.citationHits).toBe(1);
    expect(m2.sliceTotal).toBe(50);
    expect(m2.lowPower).toBe(true); // 50 < 100
  });

  it("citation requires a gate-passed grounded mention (downgraded excluded)", () => {
    const out = tallyCitationShareByModel(
      [{ model_id: "m1", language: "en", question_id: "q1", count: 10 }],
      [j({ citation_present: true, guardrail_status: "downgraded_abstain", response_raw_id: "x" })],
    );
    expect(out[0]!.citationHits).toBe(0);
  });

  it("a model with no citations gets share 0 with a valid CI", () => {
    const out = tallyCitationShareByModel(
      [{ model_id: "m1", language: "en", question_id: "q1", count: 40 }],
      [],
    );
    expect(out[0]!.citationShare).toBe(0);
    expect(out[0]!.ci95.lower).toBe(0);
    expect(out[0]!.ci95.upper).toBeGreaterThan(0);
  });
});
