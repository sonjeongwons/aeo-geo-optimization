/**
 * Plan builder — DESIGN.md §5.3 "PLAN" step.
 *
 * Expands a run into a list of WorkUnit records:
 *   cartesian(due Q × selected models × selected langs × sampleIdx 0..N-1)
 *   at temperature 0.7.
 *
 * Key invariants from DESIGN:
 *   - N_total = number of work-units emitted; SNAPSHOTTED on run.n_total
 *     BEFORE execution.  This is the frozen SMR denominator (§5.2).
 *   - request_hash = sha256(model|lang|normPrompt|temp|promptVersion).
 *     Does NOT include sample_idx; intra-cycle N samples are N distinct
 *     work_unit rows that NEVER cache-collapse against each other.
 *   - NOT_CONFIGURED providers are excluded at plan time (planner skips them
 *     so no work_units are created for missing keys today).
 *   - Baseline path includes PRIORITY LANGUAGES, not English-only.
 *   - Longtail questions may only use cheap models.
 *
 * Pure, no IO.  The caller (runCycle.ts) does the DB writes.
 */

import { createHash } from "node:crypto";
import type {
  DensityTier,
  Question,
  ModelRef,
  CustomerLanguage,
  WorkUnit,
  RunKind,
  Budget,
} from "../domain/types.js";
import { TIER_CONFIGS, baselineTierConfig } from "./density.js";
import {
  selectSliceIndex,
  pickSlice,
  DEFAULT_NUM_SLICES,
  type RotationState,
} from "./rotation.js";
import { selectLanguagesWithMeta } from "./languageWeight.js";
import { ESCALATION_JUDGE_MODEL } from "../judge/llmJudge.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Models that are ineligible for generation scheduling.
 * These models are reserved for judge-escalation only (§11 cost invariant).
 */
const GENERATION_INELIGIBLE = new Set<string>([ESCALATION_JUDGE_MODEL]);

/** All work-units use this temperature (§5.3). */
export const PLAN_TEMPERATURE = 0.7;

/** Current prompt template version — included in request_hash. */
export const PROMPT_VERSION = "v1";

// ---------------------------------------------------------------------------
// PlanInput
// ---------------------------------------------------------------------------

export interface PlanInput {
  runId: string;
  customerId: string;
  kind: RunKind;

  /** All active questions for the customer. */
  questions: Question[];

  /** Available + enabled models (filtered by provider readiness upstream). */
  models: ModelRef[];

  /** Customer language table rows. */
  languages: CustomerLanguage[];

  /** Customer budget caps. */
  budget: Budget;

  /**
   * Current monotonic cycle index.  Used for rotation slice selection.
   * For baseline runs this can be 0.
   */
  currentCycleIndex: number;

  /**
   * Current rotation states per tier (from rotation_state table).
   * Keyed by density_tier.  Missing tiers default to lastCycleIndex = -1.
   */
  rotationStates: Map<DensityTier, RotationState>;

  /**
   * Optional: inject prompt builder for testing.
   * Defaults to `buildDefaultPrompt`.
   */
  buildPrompt?: (question: Question, language: string) => string;
}

// ---------------------------------------------------------------------------
// PlanOutput
// ---------------------------------------------------------------------------

export interface PlanOutput {
  /** Work units to persist and execute. N_total = workUnits.length. */
  workUnits: PlannedWorkUnit[];

  /** Snapshot value for run.n_total (= workUnits.length). */
  nTotal: number;

  /**
   * Updated rotation states to persist AFTER plan is committed.
   * Only tiers that were scheduled this cycle appear here.
   */
  nextRotationStates: Map<DensityTier, RotationState>;

  /** Informational: how many languages were trimmed by budget cap. */
  languageTrimCount: number;
}

/**
 * A fully-resolved work unit ready for DB insertion.
 * Extends the domain WorkUnit with the derived fields.
 */
export interface PlannedWorkUnit extends WorkUnit {
  /** The resolved prompt text (required by plan). */
  prompt: string;
  /** SHA-256 hash for cross-cycle cache check. */
  requestHash: string;
  /** Temperature used — always PLAN_TEMPERATURE. */
  temperature: number;
  /** Prompt version tag. */
  promptVersion: string;
}

// ---------------------------------------------------------------------------
// buildPlan — main entry point
// ---------------------------------------------------------------------------

/**
 * Build a full set of work-units for a run, honoring density tiering,
 * rotation cursors, language weighting, and budget shape caps.
 *
 * This function is PURE — it reads no DB state beyond what is passed in.
 * The caller is responsible for persisting the returned work-units and
 * nextRotationStates.
 */
export function buildPlan(input: PlanInput): PlanOutput {
  const {
    runId,
    customerId,
    kind,
    questions,
    models,
    languages,
    budget,
    currentCycleIndex,
    rotationStates,
    buildPrompt = buildDefaultPrompt,
  } = input;

  const isBaseline = kind === "baseline";

  // -----------------------------------------------------------------------
  // 1. Select languages
  // -----------------------------------------------------------------------
  const { selected: selectedLanguages, trimmedCount: languageTrimCount } =
    selectLanguagesWithMeta(languages, budget.maxLanguages, isBaseline);

  // -----------------------------------------------------------------------
  // 2. Select models (cap to budget.maxModels)
  //    Baseline uses standard flash; operating uses cheap monitor by default.
  //    Longtail enforces cheapModelOnly.
  //    NOT_CONFIGURED models already excluded by caller (models list only
  //    has enabled models for providers that have API keys).
  //
  //    GENERATION CANDIDATE RULES (§11 cost):
  //    Sort deterministically so slice(0, maxModels) is stable run-to-run and
  //    the judge-escalation-only model (gemini-2.5-pro) never wins over a
  //    cheaper generation model when maxModels is small:
  //
  //      Baseline:  non-cheap-monitor models first (flash before flash-lite),
  //                 then cheap-monitor models; alphabetically within each group.
  //                 Alphabetical order ensures "gemini-2.5-flash" is always
  //                 selected before "gemini-2.5-pro" (f < p).
  //      Operating: cheap-monitor models first (flash-lite), then others;
  //                 alphabetically within each group.
  //                 When maxModels=1 this always picks flash-lite, never pro.
  //
  //    With maxModels=1 the top-sorted model is always the correct generation
  //    model (flash for baseline, flash-lite for operating), making pro
  //    unreachable in the generation candidate set under normal budget caps.
  // -----------------------------------------------------------------------
  // Exclude judge-escalation-only models from generation candidates (§11).
  // ESCALATION_JUDGE_MODEL (gemini-2.5-pro) must only be reached via the
  // judge-escalation path in llmJudge.ts, never scheduled as a generation model.
  const enabledModels = models.filter(
    (m) => m.enabled && !GENERATION_INELIGIBLE.has(m.id)
  );

  // Sort deterministically by role-preference, then alphabetically by id.
  // For baseline: prefer non-cheap-monitor (flash) over cheap-monitor (flash-lite);
  //   within the non-cheap group alphabetical order ensures flash < pro.
  // For operating: prefer cheap-monitor (flash-lite) first; within the non-cheap
  //   group alphabetical order ensures flash < pro.
  const sortedModels = [...enabledModels].sort((a, b) => {
    if (isBaseline) {
      // Non-cheap-monitor first (baseline flash model preferred for generation).
      if (a.isCheapMonitor !== b.isCheapMonitor) {
        return a.isCheapMonitor ? 1 : -1; // non-cheap first
      }
    } else {
      // Cheap-monitor first (flash-lite preferred for operating generation).
      if (a.isCheapMonitor !== b.isCheapMonitor) {
        return a.isCheapMonitor ? -1 : 1; // cheap first
      }
    }
    // Within same isCheapMonitor group: alphabetical by id for determinism.
    // This ensures "gemini-2.5-flash" always sorts before "gemini-2.5-pro".
    return a.id.localeCompare(b.id);
  });

  // Cap at budget.maxModels
  const cappedModels = sortedModels.slice(0, budget.maxModels);

  // -----------------------------------------------------------------------
  // 3. Determine which questions are "due" this cycle and their configs.
  // -----------------------------------------------------------------------
  const nextRotationStates = new Map<DensityTier, RotationState>();

  // Track which tiers were selected and need their cursor advanced.
  const tiersScheduled = new Set<DensityTier>();

  // Resolve due questions with their tier configs.
  interface DueQuestion {
    question: Question;
    nSamples: number;
    cheapModelOnly: boolean;
  }

  const dueQuestions: DueQuestion[] = [];

  // Group questions by tier for rotation slice selection.
  const questionsByTier = new Map<DensityTier, Question[]>();
  for (const q of questions) {
    if (!q.active) continue;
    const list = questionsByTier.get(q.densityTier) ?? [];
    list.push(q);
    questionsByTier.set(q.densityTier, list);
  }

  for (const [tier, tierQuestions] of questionsByTier) {
    const tierConfig = isBaseline
      ? baselineTierConfig(tier)
      : TIER_CONFIGS[tier];

    if (!isBaseline) {
      // Check if this tier is due based on rotation state.
      const state = rotationStates.get(tier) ?? {
        customerId,
        densityTier: tier,
        lastCycleIndex: -1,
      };

      const gap = currentCycleIndex - state.lastCycleIndex;
      if (gap < tierConfig.cyclePeriod) {
        // Not due this cycle — skip.
        continue;
      }

      // For secondary/longtail, pick a rotating slice so not all questions
      // run every period (cost savings with no starvation over time).
      // Cap numSlices to tierQuestions.length to avoid empty slices when the
      // question set is small.
      const numSlices = Math.min(DEFAULT_NUM_SLICES[tier], tierQuestions.length || 1);
      const sliceIdx = selectSliceIndex(currentCycleIndex, tier, numSlices);
      const slice = pickSlice(
        // Sort for determinism before slicing.
        [...tierQuestions].sort((a, b) => a.id.localeCompare(b.id)),
        numSlices,
        sliceIdx
      );

      for (const q of slice) {
        dueQuestions.push({
          question: q,
          nSamples: tierConfig.nSamples,
          cheapModelOnly: tierConfig.cheapModelOnly,
        });
      }

      tiersScheduled.add(tier);
    } else {
      // Baseline: all questions are due, no rotation slicing.
      for (const q of tierQuestions) {
        dueQuestions.push({
          question: q,
          nSamples: tierConfig.nSamples,
          cheapModelOnly: tierConfig.cheapModelOnly,
        });
      }
      // Baseline doesn't advance operating rotation cursors.
    }
  }

  // -----------------------------------------------------------------------
  // 4. Build work units: cartesian(dueQ × models × langs × sampleIdx)
  // -----------------------------------------------------------------------
  const workUnits: PlannedWorkUnit[] = [];

  for (const { question, nSamples, cheapModelOnly } of dueQuestions) {
    // Filter models for this tier (longtail = cheap only).
    const tierModels = cheapModelOnly
      ? cappedModels.filter((m) => m.isCheapMonitor)
      : cappedModels;

    if (tierModels.length === 0) continue;

    for (const model of tierModels) {
      // §5.3 / Phase 4 T13: non-chat (serp/scrape) surfaces are deterministic —
      // one work-unit per (question × surface × language). Chat surfaces retain
      // the tier-configured nSamples (3–5 probabilistic draws at temp 0.7).
      const effectiveNSamples = model.modality !== "chat" ? 1 : nSamples;

      for (const lang of selectedLanguages) {
        // Build the prompt (language-aware).
        const prompt = buildPrompt(question, lang);
        // Normalize prompt for hashing.
        const normPrompt = prompt.normalize("NFC").trim();

        // request_hash = sha256(model|lang|normPrompt|temp|promptVersion)
        // Does NOT include sample_idx — intra-cycle samples share the hash
        // but are NEVER collapsed (they are N distinct work_unit rows).
        const requestHash = computeRequestHash(
          model.id,
          lang,
          normPrompt,
          PLAN_TEMPERATURE,
          PROMPT_VERSION
        );

        for (let sampleIdx = 0; sampleIdx < effectiveNSamples; sampleIdx++) {
          workUnits.push({
            runId,
            questionId: question.id,
            modelId: model.id,
            language: lang,
            sampleIdx,
            status: "pending",
            responseRawId: null,
            prompt,
            requestHash,
            temperature: PLAN_TEMPERATURE,
            promptVersion: PROMPT_VERSION,
          });
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // 5. Update rotation states for tiers that were scheduled.
  // -----------------------------------------------------------------------
  if (!isBaseline) {
    for (const tier of tiersScheduled) {
      const prev = rotationStates.get(tier) ?? {
        customerId,
        densityTier: tier,
        lastCycleIndex: -1,
      };
      nextRotationStates.set(tier, {
        ...prev,
        lastCycleIndex: currentCycleIndex,
      });
    }
  }

  return {
    workUnits,
    nTotal: workUnits.length,
    nextRotationStates,
    languageTrimCount,
  };
}

// ---------------------------------------------------------------------------
// computeRequestHash
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 request hash for a work-unit.
 *
 * hash = sha256(model_id + "|" + language + "|" + normPrompt + "|" + temperature + "|" + promptVersion)
 *
 * NOTE: sample_idx is intentionally excluded.  N intra-cycle samples for the
 * same (model, lang, question) produce N identical hashes — but they are N
 * DISTINCT work_unit rows and the cache check (cache.ts) must NEVER collapse
 * them within the same run.
 */
export function computeRequestHash(
  modelId: string,
  language: string,
  normPrompt: string,
  temperature: number,
  promptVersion: string
): string {
  const content = [modelId, language, normPrompt, temperature.toFixed(6), promptVersion].join("|");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// buildDefaultPrompt — minimal default prompt
// ---------------------------------------------------------------------------

/**
 * Default prompt builder.  In production this is overridden by the template
 * loader (T10) which injects brand/competitor context.  This default ensures
 * plan.ts is self-contained and testable without external dependencies.
 *
 * The prompt language is set to `language` so the LLM responds in that locale.
 */
export function buildDefaultPrompt(question: Question, language: string): string {
  return `[Language: ${language}]\n\n${question.text}`;
}
