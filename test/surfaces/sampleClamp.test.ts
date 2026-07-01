/**
 * test/surfaces/sampleClamp.test.ts
 *
 * T17 — Non-chat (serp/scrape) surfaces are clamped to nSamples=1.
 *
 * DESIGN-phase4.md T13 / SPEC.md §5.3:
 *   Non-chat (serp/scrape) surfaces are DETERMINISTIC — one work-unit per
 *   (question × surface × language). They MUST NOT get the probabilistic
 *   temp-0.7 multi-sample treatment.
 *
 *   The plan builder (plan.ts) enforces:
 *     effectiveNSamples = model.modality !== "chat" ? 1 : nSamples
 *
 * Tests:
 *   1. SERP surface model produces exactly 1 work-unit per (question × lang).
 *   2. Scrape surface model produces exactly 1 work-unit per (question × lang).
 *   3. Chat surface model produces nSamples work-units (unaffected by clamp).
 *   4. The clamp applies regardless of the tier-configured nSamples value.
 *   5. Mixed model list: each model gets the correct nSamples.
 *   6. buildPlan output nTotal reflects the clamp.
 */

import { describe, it, expect } from "vitest";
import { buildPlan } from "../../src/sampling/plan.js";
import type { PlanInput } from "../../src/sampling/plan.js";
import type { Question, ModelRef, CustomerLanguage, Budget } from "../../src/domain/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: "q-001",
    customerId: "cust-001",
    text: "What is the best brand?",
    densityTier: "primary",
    active: true,
    language: "en",
    promptTemplate: null,
    ...overrides,
  };
}

function makeChatModel(overrides: Partial<ModelRef> = {}): ModelRef {
  return {
    id: "gemini-2.5-flash-lite",
    provider: "gemini",
    modality: "chat",
    capabilities: ["generate"],
    isCheapMonitor: true,
    isJudge: false,
    inputUsdPerMtok: 0.1,
    outputUsdPerMtok: 0.4,
    enabled: true,
    ...overrides,
  };
}

function makeSerpModel(overrides: Partial<ModelRef> = {}): ModelRef {
  return {
    id: "googleAio",
    provider: "googleAio",
    modality: "serp",
    capabilities: ["generate"],
    isCheapMonitor: false,
    isJudge: false,
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    enabled: true,
    ...overrides,
  };
}

function makeScrapeModel(overrides: Partial<ModelRef> = {}): ModelRef {
  return {
    id: "copilot",
    provider: "copilot",
    modality: "scrape",
    capabilities: ["generate"],
    isCheapMonitor: false,
    isJudge: false,
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    enabled: true,
    ...overrides,
  };
}

function makeLanguage(code: string): CustomerLanguage {
  return {
    customerId: "cust-001",
    language: code,
    weight: 1.0,
    isPriority: true,
  };
}

function makeBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    customerId: "cust-001",
    maxModels: 10,
    maxSamples: 5,
    maxLanguages: 5,
    weeklyUsdCap: 100,
    monthlyUsdCap: 300,
    ...overrides,
  };
}

function makePlanInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    runId: "run-001",
    customerId: "cust-001",
    kind: "baseline",
    questions: [makeQuestion()],
    models: [makeChatModel()],
    languages: [makeLanguage("en")],
    budget: makeBudget(),
    currentCycleIndex: 0,
    rotationStates: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. SERP surface model produces exactly 1 work-unit per (question × lang)
// ---------------------------------------------------------------------------

describe("sampleClamp — SERP surface produces nSamples=1", () => {
  it("googleAio: 1 question × 1 lang × serp → exactly 1 work-unit", () => {
    const plan = buildPlan(makePlanInput({
      models: [makeSerpModel({ id: "googleAio" })],
      // For baseline, primary questions are all due
    }));

    expect(plan.workUnits).toHaveLength(1);
    expect(plan.workUnits[0].sampleIdx).toBe(0);
    expect(plan.workUnits[0].modelId).toBe("googleAio");
  });

  it("naverAi: 1 question × 1 lang × serp → exactly 1 work-unit", () => {
    const plan = buildPlan(makePlanInput({
      models: [makeSerpModel({ id: "naverAi" })],
    }));

    expect(plan.workUnits).toHaveLength(1);
    expect(plan.workUnits[0].sampleIdx).toBe(0);
  });

  it("SERP: 1 question × 2 langs → exactly 2 work-units (1 per lang)", () => {
    const plan = buildPlan(makePlanInput({
      models: [makeSerpModel({ id: "googleAio" })],
      languages: [makeLanguage("en"), makeLanguage("ko")],
    }));

    expect(plan.workUnits).toHaveLength(2);
    // All sampleIdx === 0 (never more than 1 sample per SERP surface)
    expect(plan.workUnits.every(wu => wu.sampleIdx === 0)).toBe(true);
  });

  it("SERP: 2 questions × 1 lang → exactly 2 work-units", () => {
    const plan = buildPlan(makePlanInput({
      questions: [makeQuestion({ id: "q-1" }), makeQuestion({ id: "q-2" })],
      models: [makeSerpModel({ id: "googleAio" })],
    }));

    expect(plan.workUnits).toHaveLength(2);
    expect(plan.workUnits.every(wu => wu.sampleIdx === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Scrape surface model produces exactly 1 work-unit per (question × lang)
// ---------------------------------------------------------------------------

describe("sampleClamp — Scrape surface produces nSamples=1", () => {
  it("copilot: 1 question × 1 lang × scrape → exactly 1 work-unit", () => {
    const plan = buildPlan(makePlanInput({
      models: [makeScrapeModel({ id: "copilot" })],
    }));

    expect(plan.workUnits).toHaveLength(1);
    expect(plan.workUnits[0].sampleIdx).toBe(0);
    expect(plan.workUnits[0].modelId).toBe("copilot");
  });

  it("metaAi: 1 question × 2 langs → exactly 2 work-units (1 per lang)", () => {
    const plan = buildPlan(makePlanInput({
      models: [makeScrapeModel({ id: "metaAi" })],
      languages: [makeLanguage("en"), makeLanguage("es")],
    }));

    expect(plan.workUnits).toHaveLength(2);
    expect(plan.workUnits.every(wu => wu.sampleIdx === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Chat surface model retains tier-configured nSamples (unaffected by clamp)
// ---------------------------------------------------------------------------

describe("sampleClamp — chat surface retains nSamples from tier config", () => {
  it("baseline primary tier: nSamples=3 → 3 work-units per (question × lang)", () => {
    // For baseline + primary tier, nSamples = 3 (see density.ts baselineTierConfig)
    const plan = buildPlan(makePlanInput({
      models: [makeChatModel({ id: "gemini-2.5-flash-lite" })],
    }));

    // The number of work-units should be > 1 for a chat model on baseline primary
    // (N=3 samples at temperature 0.7)
    // We verify it is NOT clamped to 1
    expect(plan.workUnits.length).toBeGreaterThan(1);
    // All work-units are for the same model
    expect(plan.workUnits.every(wu => wu.modelId === "gemini-2.5-flash-lite")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Clamp applies regardless of tier-configured nSamples
// ---------------------------------------------------------------------------

describe("sampleClamp — clamp applies regardless of densityTier nSamples", () => {
  it("SERP on operating + secondary tier: still 1 work-unit per (question × lang)", () => {
    // Use operating kind with a secondary-tier question
    // Even if secondary tier has nSamples > 1 for chat, SERP clamps to 1
    const plan = buildPlan(makePlanInput({
      kind: "operating",
      questions: [makeQuestion({ densityTier: "secondary" })],
      models: [makeSerpModel({ id: "googleAio", isCheapMonitor: true })],
      currentCycleIndex: 100, // ensure secondary tier is due
      rotationStates: new Map(),
    }));

    // All work-units (if any) must have sampleIdx=0 for serp surfaces
    for (const wu of plan.workUnits) {
      expect(wu.sampleIdx).toBe(0);
    }
    // No work-unit for a SERP surface should have sampleIdx > 0
    expect(plan.workUnits.some(wu => wu.sampleIdx > 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Mixed model list: each model gets the correct nSamples
// ---------------------------------------------------------------------------

describe("sampleClamp — mixed model list", () => {
  it("1 chat + 1 SERP + 1 scrape × 1 question × 1 lang", () => {
    const chatModel = makeChatModel({ id: "gemini-2.5-flash-lite" });
    const serpModel = makeSerpModel({ id: "googleAio" });
    const scrapeModel = makeScrapeModel({ id: "copilot" });

    const plan = buildPlan(makePlanInput({
      models: [chatModel, serpModel, scrapeModel],
    }));

    const chatWUs = plan.workUnits.filter(wu => wu.modelId === "gemini-2.5-flash-lite");
    const serpWUs = plan.workUnits.filter(wu => wu.modelId === "googleAio");
    const scrapeWUs = plan.workUnits.filter(wu => wu.modelId === "copilot");

    // SERP and scrape: exactly 1 work-unit each
    expect(serpWUs).toHaveLength(1);
    expect(scrapeWUs).toHaveLength(1);
    expect(serpWUs[0].sampleIdx).toBe(0);
    expect(scrapeWUs[0].sampleIdx).toBe(0);

    // Chat: more than 1 work-unit (N=3 for baseline primary)
    expect(chatWUs.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 6. buildPlan nTotal reflects the clamp
// ---------------------------------------------------------------------------

describe("sampleClamp — nTotal reflects sample clamp", () => {
  it("2 questions × 1 lang × 1 SERP model → nTotal=2", () => {
    const plan = buildPlan(makePlanInput({
      questions: [makeQuestion({ id: "q-1" }), makeQuestion({ id: "q-2" })],
      models: [makeSerpModel({ id: "googleAio" })],
    }));

    expect(plan.nTotal).toBe(2);
    expect(plan.workUnits).toHaveLength(plan.nTotal);
  });

  it("2 questions × 2 langs × 1 scrape model → nTotal=4", () => {
    const plan = buildPlan(makePlanInput({
      questions: [makeQuestion({ id: "q-1" }), makeQuestion({ id: "q-2" })],
      models: [makeScrapeModel({ id: "copilot" })],
      languages: [makeLanguage("en"), makeLanguage("ja")],
    }));

    expect(plan.nTotal).toBe(4);
    expect(plan.workUnits).toHaveLength(plan.nTotal);
  });
});
