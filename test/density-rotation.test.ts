/**
 * test/density-rotation.test.ts
 *
 * Vitest suite for src/sampling/density.ts + src/sampling/rotation.ts:
 *   - Rotation cursor advances after each scheduled tier.
 *   - No starvation: every question is eventually covered.
 *   - Longtail questions: monthly cadence + cheap-model only.
 *   - Secondary questions: biweekly cadence.
 *   - Core questions: every cycle.
 *   - selectSliceIndex is deterministic and covers all slices over time.
 *
 * Pure, no DB.
 */

import { describe, it, expect } from "vitest";
import {
  isDue,
  TIER_CONFIGS,
  CYCLE_PERIOD_BY_TIER,
  SAMPLES_BY_TIER,
  BASELINE_N_SAMPLES,
  baselineTierConfig,
} from "../src/sampling/density.js";
import {
  isRotationDue,
  advanceRotation,
  selectSliceIndex,
  pickSlice,
  DEFAULT_NUM_SLICES,
  type RotationState,
} from "../src/sampling/rotation.js";
import { buildPlan } from "../src/sampling/plan.js";
import type { PlanInput } from "../src/sampling/plan.js";
import type { Question, ModelRef, CustomerLanguage, Budget, DensityTier } from "../src/domain/types.js";
import { ESCALATION_JUDGE_MODEL } from "../src/judge/llmJudge.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQuestion(
  id: string,
  densityTier: DensityTier,
  language = "en"
): Question {
  return {
    id,
    customerId: "cust-1",
    text: `What is the best AI app? (${id})`,
    language,
    funnelStage: null,
    densityTier,
    active: true,
  };
}

function makeCheapModel(id = "gemini-2.5-flash-lite"): ModelRef {
  return {
    id,
    provider: "gemini",
    modality: "chat",
    capabilities: ["generate"],
    isCheapMonitor: true,
    isJudge: false,
    inputUsdPerMtok: 0.075,
    outputUsdPerMtok: 0.3,
    enabled: true,
  };
}

function makeFullModel(id = "gemini-2.5-flash"): ModelRef {
  return {
    id,
    provider: "gemini",
    modality: "chat",
    capabilities: ["generate", "judge", "structured"],
    isCheapMonitor: false,
    isJudge: true,
    inputUsdPerMtok: 0.3,
    outputUsdPerMtok: 2.5,
    enabled: true,
  };
}

function makeBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    customerId: "cust-1",
    maxModels: 5,
    maxSamples: 10,
    maxLanguages: 5,
    weeklyUsdCap: 100,
    monthlyUsdCap: 300,
    ...overrides,
  };
}

function makeLanguages(langs: string[]): CustomerLanguage[] {
  return langs.map((language) => ({
    customerId: "cust-1",
    language,
    weight: 1.0,
  }));
}

function makeRotationState(
  tier: DensityTier,
  lastCycleIndex: number
): RotationState {
  return { customerId: "cust-1", densityTier: tier, lastCycleIndex };
}

// ---------------------------------------------------------------------------
// TIER_CONFIGS constants
// ---------------------------------------------------------------------------

describe("density — tier constants", () => {
  it("core: nSamples=5, cyclePeriod=1, cheapModelOnly=false", () => {
    expect(TIER_CONFIGS.core.nSamples).toBe(5);
    expect(TIER_CONFIGS.core.cyclePeriod).toBe(1);
    expect(TIER_CONFIGS.core.cheapModelOnly).toBe(false);
  });

  it("secondary: nSamples=3, cyclePeriod=2, cheapModelOnly=false", () => {
    expect(TIER_CONFIGS.secondary.nSamples).toBe(3);
    expect(TIER_CONFIGS.secondary.cyclePeriod).toBe(2);
    expect(TIER_CONFIGS.secondary.cheapModelOnly).toBe(false);
  });

  it("longtail: nSamples=3, cyclePeriod=4, cheapModelOnly=true", () => {
    expect(TIER_CONFIGS.longtail.nSamples).toBe(3);
    expect(TIER_CONFIGS.longtail.cyclePeriod).toBe(4);
    expect(TIER_CONFIGS.longtail.cheapModelOnly).toBe(true);
  });

  it("SAMPLES_BY_TIER matches TIER_CONFIGS", () => {
    expect(SAMPLES_BY_TIER.core).toBe(TIER_CONFIGS.core.nSamples);
    expect(SAMPLES_BY_TIER.secondary).toBe(TIER_CONFIGS.secondary.nSamples);
    expect(SAMPLES_BY_TIER.longtail).toBe(TIER_CONFIGS.longtail.nSamples);
  });
});

// ---------------------------------------------------------------------------
// isDue
// ---------------------------------------------------------------------------

describe("isDue — per-tier cadence", () => {
  it("core is always due (every cycle)", () => {
    expect(isDue("core", 0, -1)).toBe(true);
    expect(isDue("core", 5, 4)).toBe(true);
    expect(isDue("core", 100, 99)).toBe(true);
  });

  it("secondary is due every 2nd cycle (gap >= 2)", () => {
    // gap = currentCycleIndex - lastCycleIndex; secondary period=2
    // cycle=0, lastCycleIndex=-1: gap=1 < 2 → NOT due
    expect(isDue("secondary", 0, -1)).toBe(false);
    // cycle=1, lastCycleIndex=-1: gap=2 >= 2 → due
    expect(isDue("secondary", 1, -1)).toBe(true);
    // cycle=2, lastCycleIndex=0: gap=2 >= 2 → due
    expect(isDue("secondary", 2, 0)).toBe(true);
    // cycle=1, lastCycleIndex=0: gap=1 < 2 → NOT due
    expect(isDue("secondary", 1, 0)).toBe(false);
  });

  it("longtail is due every 4th cycle (gap >= 4)", () => {
    expect(isDue("longtail", 3, -1)).toBe(true);   // gap=4 >= 4
    expect(isDue("longtail", 2, -1)).toBe(false);  // gap=3 < 4
    expect(isDue("longtail", 7, 3)).toBe(true);    // gap=4
    expect(isDue("longtail", 6, 3)).toBe(false);   // gap=3 < 4
  });

  it("after advance, secondary not due until 2 more cycles pass", () => {
    // Scheduled at cycle 2, next due at cycle 4.
    expect(isDue("secondary", 3, 2)).toBe(false);  // gap=1 < 2
    expect(isDue("secondary", 4, 2)).toBe(true);   // gap=2
  });
});

// ---------------------------------------------------------------------------
// isRotationDue
// ---------------------------------------------------------------------------

describe("isRotationDue — cursor-based due check", () => {
  it("secondary: due when gap >= 2", () => {
    const state = makeRotationState("secondary", -1);
    expect(isRotationDue(0, state)).toBe(false); // gap=1 < 2
    expect(isRotationDue(1, state)).toBe(true);  // gap=2
  });

  it("longtail: due when gap >= 4", () => {
    const state = makeRotationState("longtail", -1);
    expect(isRotationDue(3, state)).toBe(true);   // gap=4
    expect(isRotationDue(2, state)).toBe(false);  // gap=3
  });

  it("core: always due (period=1, any gap >= 1)", () => {
    const state = makeRotationState("core", 5);
    expect(isRotationDue(6, state)).toBe(true);   // gap=1 >= 1
  });
});

// ---------------------------------------------------------------------------
// advanceRotation — cursor advances
// ---------------------------------------------------------------------------

describe("advanceRotation — cursor persists current cycle", () => {
  it("advances lastCycleIndex to currentCycleIndex", () => {
    const state = makeRotationState("secondary", -1);
    const next = advanceRotation(2, state);
    expect(next.lastCycleIndex).toBe(2);
    expect(next.densityTier).toBe("secondary");
    expect(next.customerId).toBe("cust-1");
  });

  it("after advance, tier is no longer due for next cycle", () => {
    const state = makeRotationState("secondary", -1);
    const advanced = advanceRotation(2, state);
    // Gap from 2 to 3 = 1 < period=2 → not due.
    expect(isRotationDue(3, advanced)).toBe(false);
  });

  it("after advance, tier is due again after full period", () => {
    const state = makeRotationState("secondary", -1);
    const advanced = advanceRotation(2, state);
    // Gap from 2 to 4 = 2 >= period=2 → due.
    expect(isRotationDue(4, advanced)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectSliceIndex — deterministic slice rotation
// ---------------------------------------------------------------------------

describe("selectSliceIndex — deterministic rotation", () => {
  it("secondary (period=2, numSlices=2) cycles through all slices", () => {
    // sliceIndex = floor(cycleIndex / period) % numSlices
    // cycle=0: floor(0/2)%2 = 0
    // cycle=1: floor(1/2)%2 = 0
    // cycle=2: floor(2/2)%2 = 1
    // cycle=3: floor(3/2)%2 = 1
    // cycle=4: floor(4/2)%2 = 0  (wraps)
    expect(selectSliceIndex(0, "secondary", 2)).toBe(0);
    expect(selectSliceIndex(2, "secondary", 2)).toBe(1);
    expect(selectSliceIndex(4, "secondary", 2)).toBe(0);
    expect(selectSliceIndex(6, "secondary", 2)).toBe(1);
  });

  it("longtail (period=4, numSlices=4) cycles through all 4 slices", () => {
    // slice = floor(cycleIndex / 4) % 4
    expect(selectSliceIndex(0, "longtail", 4)).toBe(0);
    expect(selectSliceIndex(4, "longtail", 4)).toBe(1);
    expect(selectSliceIndex(8, "longtail", 4)).toBe(2);
    expect(selectSliceIndex(12, "longtail", 4)).toBe(3);
    expect(selectSliceIndex(16, "longtail", 4)).toBe(0); // wraps
  });

  it("all slices are covered over the full rotation period (no starvation)", () => {
    const numSlices = 4;
    const period = CYCLE_PERIOD_BY_TIER.longtail; // 4
    const cyclesNeeded = numSlices * period;       // 16 cycles to cover all slices

    const slicesSeen = new Set<number>();
    for (let cycle = 0; cycle < cyclesNeeded; cycle++) {
      slicesSeen.add(selectSliceIndex(cycle, "longtail", numSlices));
    }

    expect(slicesSeen.size).toBe(numSlices);
    for (let i = 0; i < numSlices; i++) {
      expect(slicesSeen.has(i)).toBe(true);
    }
  });

  it("returns 0 for numSlices <= 1", () => {
    expect(selectSliceIndex(5, "secondary", 1)).toBe(0);
    expect(selectSliceIndex(5, "longtail", 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pickSlice — no starvation over rotation
// ---------------------------------------------------------------------------

describe("pickSlice — divides items into equal slices", () => {
  const items = ["q1", "q2", "q3", "q4", "q5", "q6"];

  it("slice 0 of 2 returns first half", () => {
    const result = pickSlice(items, 2, 0);
    expect(result).toEqual(["q1", "q2", "q3"]);
  });

  it("slice 1 of 2 returns second half", () => {
    const result = pickSlice(items, 2, 1);
    expect(result).toEqual(["q4", "q5", "q6"]);
  });

  it("over 2 cycles all items are covered (no starvation)", () => {
    const slice0 = pickSlice(items, 2, 0);
    const slice1 = pickSlice(items, 2, 1);
    const covered = new Set([...slice0, ...slice1]);
    expect(covered.size).toBe(items.length);
  });

  it("over 4 longtail slices all items are covered", () => {
    const longtailItems = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"];
    const covered = new Set<string>();
    for (let i = 0; i < 4; i++) {
      pickSlice(longtailItems, 4, i).forEach((q) => covered.add(q));
    }
    expect(covered.size).toBe(longtailItems.length);
  });

  it("numSlices=1 returns all items", () => {
    expect(pickSlice(items, 1, 0)).toEqual(items);
  });

  it("empty array returns empty slice", () => {
    expect(pickSlice([], 3, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_NUM_SLICES
// ---------------------------------------------------------------------------

describe("DEFAULT_NUM_SLICES values", () => {
  it("core=1 (no slicing — runs every cycle)", () => {
    expect(DEFAULT_NUM_SLICES.core).toBe(1);
  });
  it("secondary=2 (biweekly, 2 slices)", () => {
    expect(DEFAULT_NUM_SLICES.secondary).toBe(2);
  });
  it("longtail=4 (monthly, 4 slices)", () => {
    expect(DEFAULT_NUM_SLICES.longtail).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// buildPlan integration — longtail monthly + cheap-only
// ---------------------------------------------------------------------------

describe("buildPlan — longtail monthly + cheap-model-only", () => {
  const coreQ = makeQuestion("q-core-1", "core");
  const longtailQ = makeQuestion("q-longtail-1", "longtail");
  const cheapModel = makeCheapModel();
  const fullModel = makeFullModel();
  const languages = makeLanguages(["en"]);
  const budget = makeBudget();

  it("longtail questions are NOT scheduled before cycle 3 (period=4)", () => {
    // At cycle 0, lastCycleIndex=-1, gap=1 < 4 → not due.
    const rotationStates = new Map<DensityTier, RotationState>([
      ["longtail", makeRotationState("longtail", -1)],
    ]);

    const plan = buildPlan({
      runId: "run-1",
      customerId: "cust-1",
      kind: "operating",
      questions: [longtailQ],
      models: [cheapModel, fullModel],
      languages,
      budget,
      currentCycleIndex: 0, // gap = 0 - (-1) = 1 < 4 → NOT due
      rotationStates,
    });

    // Longtail not due at cycle 0 → no work units
    expect(plan.workUnits).toHaveLength(0);
  });

  it("longtail questions ARE scheduled at cycle 3 (gap=4 >= 4)", () => {
    const rotationStates = new Map<DensityTier, RotationState>([
      ["longtail", makeRotationState("longtail", -1)],
    ]);

    const plan = buildPlan({
      runId: "run-1",
      customerId: "cust-1",
      kind: "operating",
      questions: [longtailQ],
      models: [cheapModel, fullModel],
      languages,
      budget,
      currentCycleIndex: 3, // gap = 3 - (-1) = 4 >= 4 → DUE
      rotationStates,
    });

    expect(plan.workUnits.length).toBeGreaterThan(0);
  });

  it("longtail work units use ONLY cheap model (cheapModelOnly=true)", () => {
    const rotationStates = new Map<DensityTier, RotationState>([
      ["longtail", makeRotationState("longtail", -1)],
    ]);

    const plan = buildPlan({
      runId: "run-1",
      customerId: "cust-1",
      kind: "operating",
      questions: [longtailQ],
      models: [cheapModel, fullModel],
      languages,
      budget,
      currentCycleIndex: 3,
      rotationStates,
    });

    for (const wu of plan.workUnits) {
      expect(wu.modelId).toBe(cheapModel.id);
    }
  });

  it("core questions use all available models (not cheap-only)", () => {
    const rotationStates = new Map<DensityTier, RotationState>();

    const plan = buildPlan({
      runId: "run-1",
      customerId: "cust-1",
      kind: "operating",
      questions: [coreQ],
      models: [cheapModel, fullModel],
      languages,
      budget,
      currentCycleIndex: 0,
      rotationStates,
    });

    const modelIds = new Set(plan.workUnits.map((wu) => wu.modelId));
    expect(modelIds.has(cheapModel.id)).toBe(true);
    expect(modelIds.has(fullModel.id)).toBe(true);
  });

  it("core questions produce N=5 samples per (question, model, language)", () => {
    const rotationStates = new Map<DensityTier, RotationState>();

    const plan = buildPlan({
      runId: "run-1",
      customerId: "cust-1",
      kind: "operating",
      questions: [coreQ],
      models: [cheapModel],
      languages,
      budget,
      currentCycleIndex: 0,
      rotationStates,
    });

    // 1 question × 1 model × 1 language × 5 samples = 5
    expect(plan.workUnits).toHaveLength(5);
    const sampleIdxs = plan.workUnits.map((wu) => wu.sampleIdx).sort();
    expect(sampleIdxs).toEqual([0, 1, 2, 3, 4]);
  });

  it("advancing rotation cursor prevents secondary re-scheduling until 2 cycles later", () => {
    const secondaryQ = makeQuestion("q-secondary-1", "secondary");

    // Cycle 1: secondary is due (gap = 1-(-1) = 2 >= 2)
    const initialStates = new Map<DensityTier, RotationState>([
      ["secondary", makeRotationState("secondary", -1)],
    ]);

    const plan1 = buildPlan({
      runId: "run-1",
      customerId: "cust-1",
      kind: "operating",
      questions: [secondaryQ],
      models: [cheapModel],
      languages,
      budget,
      currentCycleIndex: 1,
      rotationStates: initialStates,
    });

    expect(plan1.workUnits.length).toBeGreaterThan(0);

    // After cycle 1, advance the rotation state
    const afterCycle1States = plan1.nextRotationStates;

    // Cycle 2: secondary is NOT due (gap = 2-1 = 1 < 2)
    const plan2 = buildPlan({
      runId: "run-2",
      customerId: "cust-1",
      kind: "operating",
      questions: [secondaryQ],
      models: [cheapModel],
      languages,
      budget,
      currentCycleIndex: 2,
      rotationStates: afterCycle1States,
    });

    expect(plan2.workUnits).toHaveLength(0);

    // Cycle 3: secondary IS due (gap = 3-1 = 2 >= 2)
    const plan3 = buildPlan({
      runId: "run-3",
      customerId: "cust-1",
      kind: "operating",
      questions: [secondaryQ],
      models: [cheapModel],
      languages,
      budget,
      currentCycleIndex: 3,
      rotationStates: afterCycle1States,
    });

    expect(plan3.workUnits.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildPlan — escalation model excluded from generation (§11 invariant)
// ---------------------------------------------------------------------------

describe("buildPlan — ESCALATION_JUDGE_MODEL never in generation plan", () => {
  const coreQ = makeQuestion("q-core-esc", "core");
  const languages = makeLanguages(["en"]);

  function makeEscalationModel(): ModelRef {
    return {
      id: ESCALATION_JUDGE_MODEL, // "gemini-2.5-pro"
      provider: "gemini",
      modality: "chat",
      capabilities: ["generate", "judge", "structured"],
      isCheapMonitor: false,
      isJudge: true,
      inputUsdPerMtok: 3.5,
      outputUsdPerMtok: 10.5,
      enabled: true,
    };
  }

  it("escalation model is excluded from generation plan even with max_models=5", () => {
    // Provide flash-lite, flash, AND pro (escalation model) — budget allows all 5
    const cheapModel = makeCheapModel();                  // flash-lite
    const fullModel = makeFullModel();                    // flash
    const escalationModel = makeEscalationModel();        // pro (judge-escalation only)
    const budget = makeBudget({ maxModels: 5 });

    const plan = buildPlan({
      runId: "run-esc-test",
      customerId: "cust-1",
      kind: "baseline",
      questions: [coreQ],
      models: [cheapModel, fullModel, escalationModel],
      languages,
      budget,
      currentCycleIndex: 0,
      rotationStates: new Map(),
    });

    expect(plan.workUnits.length).toBeGreaterThan(0);

    const modelIds = new Set(plan.workUnits.map((wu) => wu.modelId));
    // flash and flash-lite should be scheduled
    expect(modelIds.has(cheapModel.id)).toBe(true);
    expect(modelIds.has(fullModel.id)).toBe(true);
    // pro must NEVER appear in the generation plan
    expect(modelIds.has(ESCALATION_JUDGE_MODEL)).toBe(false);
  });

  it("escalation model excluded in operating mode with max_models=5", () => {
    const cheapModel = makeCheapModel();
    const fullModel = makeFullModel();
    const escalationModel = makeEscalationModel();
    const budget = makeBudget({ maxModels: 5 });

    const plan = buildPlan({
      runId: "run-esc-test-op",
      customerId: "cust-1",
      kind: "operating",
      questions: [coreQ],
      models: [cheapModel, fullModel, escalationModel],
      languages,
      budget,
      currentCycleIndex: 0,
      rotationStates: new Map(),
    });

    expect(plan.workUnits.length).toBeGreaterThan(0);

    const modelIds = new Set(plan.workUnits.map((wu) => wu.modelId));
    expect(modelIds.has(ESCALATION_JUDGE_MODEL)).toBe(false);
    // Cheaper models still selected by role
    expect(modelIds.has(cheapModel.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Baseline tier config
// ---------------------------------------------------------------------------

describe("baselineTierConfig — simplified for diagnostic baseline", () => {
  it("all tiers have nSamples=3 in baseline mode", () => {
    expect(baselineTierConfig("core").nSamples).toBe(BASELINE_N_SAMPLES);
    expect(baselineTierConfig("secondary").nSamples).toBe(BASELINE_N_SAMPLES);
    expect(baselineTierConfig("longtail").nSamples).toBe(BASELINE_N_SAMPLES);
    expect(BASELINE_N_SAMPLES).toBe(3);
  });

  it("all tiers have cyclePeriod=1 (due every cycle) in baseline mode", () => {
    expect(baselineTierConfig("core").cyclePeriod).toBe(1);
    expect(baselineTierConfig("secondary").cyclePeriod).toBe(1);
    expect(baselineTierConfig("longtail").cyclePeriod).toBe(1);
  });

  it("baseline overrides cheapModelOnly to false for longtail", () => {
    expect(baselineTierConfig("longtail").cheapModelOnly).toBe(false);
  });
});
