/**
 * src/generate/densityMap.ts
 *
 * PURE: Density-tier mapping with a HARD core-share cap.
 *
 * Maps (intentType, funnelStage, languageWeight, isPhrasingSibling) ->
 * density_tier ('core' | 'secondary' | 'longtail') for a single IntentCell
 * or DraftQuestion.
 *
 * Cap enforcement (DESIGN-phase1.md §"Question Model & Generation" step 4):
 *   - core ≤ 25% of the total question count across ALL languages.
 *   - An absolute per-language core-count cap (ceil(langTotal * 0.35)) so that
 *     a single language cannot monopolise the core budget.
 *   - Overflow is demoted deterministically to 'secondary' (never to 'longtail',
 *     so the §7#1 monitoring goal is preserved for siblings).
 *
 * Tier assignment rules (before cap enforcement):
 *   - 'core':      decision-stage brand/comparison/alternative/category in
 *                  TOP-weighted languages (weight >= HIGH_WEIGHT_THRESHOLD)
 *                  AND the question is the LEAD phrasing (isPhrasingSibling=false).
 *   - 'longtail':  awareness-stage attribute questions.
 *   - 'secondary': everything else, including phrasing siblings (isPhrasingSibling=true)
 *                  which are explicitly NOT forced to longtail per design.
 *
 * Entry points:
 *   applyDensityTiers(cells, totalQuestions)   — mutates IntentCell[].densityTier in place
 *   mapSingleCell(...)                          — raw tier before cap (pure, no state)
 *   applyDensityToQuestions(questions, brief)  — applies tiers to DraftQuestion[] with cap
 *
 * No LLM calls, no IO. Deterministic for identical inputs.
 */

import type { IntentType, FunnelStage, IntentCell, DraftQuestion } from './types.js';
import type { BrandBrief } from './types.js';
import type { DensityTier } from '../config/template.schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Language weight threshold above which a language is considered "top-weighted"
 * and its decision-stage cells are eligible for core tier.
 *
 * Languages with weight >= this threshold are considered high-priority markets.
 * Based on DESIGN-phase1.md: "top-weight languages" drive core-tier assignment.
 */
const HIGH_WEIGHT_THRESHOLD = 0.5;

/**
 * Hard global cap: core questions must not exceed this fraction of the total.
 * DESIGN-phase1.md: "core kept to <=20-25%".  We enforce 25%.
 */
const CORE_GLOBAL_CAP_FRACTION = 0.25;

/**
 * Per-language cap: core questions must not exceed this fraction of the
 * per-language question total.
 */
const CORE_PER_LANG_CAP_FRACTION = 0.35;

// ---------------------------------------------------------------------------
// Core-eligible intent types per funnel stage (before cap enforcement)
// ---------------------------------------------------------------------------

/** Intent types eligible for core at the decision stage. */
const CORE_ELIGIBLE_DECISION: Set<IntentType> = new Set([
  'brand',
  'comparison',
  'alternative',
  'category',
]);

// ---------------------------------------------------------------------------
// mapSingleCell — raw tier BEFORE cap enforcement
// ---------------------------------------------------------------------------

/**
 * Assign a raw density tier to a single (intentType, funnelStage, languageWeight,
 * isPhrasingSibling) tuple, WITHOUT any cap enforcement.
 *
 * Use this as the first pass; then run cap enforcement via applyDensityTiers().
 *
 * Rules:
 *   1. Paraphrase siblings always start at 'secondary' (NOT longtail, per design).
 *   2. Awareness + attribute -> 'longtail'.
 *   3. Decision + core-eligible intent + top-weight language -> 'core'.
 *   4. Everything else -> 'secondary'.
 *
 * @param intentType       The intent type of the cell/question.
 * @param funnelStage      The funnel stage of the cell/question.
 * @param languageWeight   The weight of the language (0, 1]).
 * @param isPhrasingSibling  True if this is a paraphrase sibling (NOT the lead variant).
 * @returns Raw density tier before cap enforcement.
 */
export function mapSingleCell(
  intentType: IntentType,
  funnelStage: FunnelStage,
  languageWeight: number,
  isPhrasingSibling: boolean,
): DensityTier {
  // Rule 1: paraphrase siblings start at secondary (not longtail)
  if (isPhrasingSibling) {
    return 'secondary';
  }

  // Rule 2: awareness-stage attribute -> longtail
  if (funnelStage === 'awareness' && intentType === 'attribute') {
    return 'longtail';
  }

  // Rule 3: decision + core-eligible intent + top-weight language -> core (pre-cap)
  if (
    funnelStage === 'decision' &&
    CORE_ELIGIBLE_DECISION.has(intentType) &&
    languageWeight >= HIGH_WEIGHT_THRESHOLD
  ) {
    return 'core';
  }

  // Rule 4: everything else -> secondary
  return 'secondary';
}

// ---------------------------------------------------------------------------
// applyDensityTiers — assign tiers to IntentCell[] with cap enforcement
// ---------------------------------------------------------------------------

/**
 * Assign densityTier to every cell in the matrix using the mapping rules +
 * HARD core-cap enforcement.
 *
 * Mutates each cell's densityTier field in place, then enforces:
 *   1. Global cap: core count ≤ floor(totalQuestions * CORE_GLOBAL_CAP_FRACTION).
 *   2. Per-language cap: core count per language ≤ ceil(langTotal * CORE_PER_LANG_CAP_FRACTION).
 *
 * Overflow cells are demoted to 'secondary' in a deterministic order:
 * lowest language-weight first, then within a language by funnelStage order
 * (awareness > consideration > decision), then by intentType alphabetically.
 * This means the "least important" core cells are demoted first.
 *
 * @param cells          IntentCell[] from buildIntentMatrix(); mutated in place.
 * @param langWeights    Map from language code to its weight (from BrandBrief).
 * @param totalQuestions The clamped total (sum of all cell targetCounts).
 * @returns              The same array (mutated), for convenience.
 */
export function applyDensityTiers(
  cells: IntentCell[],
  langWeights: Map<string, number>,
  totalQuestions: number,
): IntentCell[] {
  // --- Pass 1: raw tier assignment ---
  for (const cell of cells) {
    const weight = langWeights.get(cell.language) ?? 0;
    // IntentCells from buildIntentMatrix are always lead (not siblings);
    // sibling tracking is done at the DraftQuestion level via phrasingGroupId.
    cell.densityTier = mapSingleCell(cell.intentType, cell.funnelStage, weight, false);
  }

  // --- Pass 2: per-language cap enforcement ---
  // Group cells by language.
  const byLang = new Map<string, IntentCell[]>();
  for (const cell of cells) {
    const arr = byLang.get(cell.language) ?? [];
    arr.push(cell);
    byLang.set(cell.language, arr);
  }

  for (const [lang, langCells] of byLang) {
    const langTotal = langCells.reduce((s, c) => s + c.targetCount, 0);
    const langCoreCap = Math.ceil(langTotal * CORE_PER_LANG_CAP_FRACTION);
    const coreInLang = langCells.filter((c) => c.densityTier === 'core');
    const coreCountInLang = coreInLang.reduce((s, c) => s + c.targetCount, 0);

    if (coreCountInLang > langCoreCap) {
      // Demote overflow cells deterministically: lowest-importance first.
      // Sort by (funnelStage asc intentionally reversed: awareness first, then consideration, then decision)
      // then by intentType alphabetically.
      const demotionOrder = [...coreInLang].sort((a, b) => {
        const stageOrder: Record<FunnelStage, number> = {
          awareness: 0,
          consideration: 1,
          decision: 2,
        };
        const stageDiff = stageOrder[a.funnelStage] - stageOrder[b.funnelStage];
        if (stageDiff !== 0) return stageDiff;
        return a.intentType.localeCompare(b.intentType);
      });

      let overflow = coreCountInLang - langCoreCap;
      for (const cell of demotionOrder) {
        if (overflow <= 0) break;
        if (cell.densityTier === 'core') {
          cell.densityTier = 'secondary';
          overflow -= cell.targetCount;
        }
      }
    }
    // suppress unused variable lint (byLang key)
    void lang;
  }

  // --- Pass 3: global cap enforcement ---
  const globalCoreCap = Math.floor(totalQuestions * CORE_GLOBAL_CAP_FRACTION);
  const coreWeightedCells = cells.filter((c) => c.densityTier === 'core');
  const globalCoreCount = coreWeightedCells.reduce((s, c) => s + c.targetCount, 0);

  if (globalCoreCount > globalCoreCap) {
    // Demote in order: lowest language weight first, then same tiebreak as above.
    const demotionOrder = [...coreWeightedCells].sort((a, b) => {
      const wa = langWeights.get(a.language) ?? 0;
      const wb = langWeights.get(b.language) ?? 0;
      if (wa !== wb) return wa - wb; // lower weight demoted first
      const stageOrder: Record<FunnelStage, number> = {
        awareness: 0,
        consideration: 1,
        decision: 2,
      };
      const stageDiff = stageOrder[a.funnelStage] - stageOrder[b.funnelStage];
      if (stageDiff !== 0) return stageDiff;
      return a.intentType.localeCompare(b.intentType);
    });

    let overflow = globalCoreCount - globalCoreCap;
    for (const cell of demotionOrder) {
      if (overflow <= 0) break;
      if (cell.densityTier === 'core') {
        cell.densityTier = 'secondary';
        overflow -= cell.targetCount;
      }
    }
  }

  return cells;
}

// ---------------------------------------------------------------------------
// applyDensityToQuestions — apply tiers to DraftQuestion[] with cap enforcement
// ---------------------------------------------------------------------------

/**
 * Apply density tiers to a flat DraftQuestion[] using the brief's language weights,
 * then enforce global + per-language core caps.
 *
 * This is the DraftQuestion-level analogue of applyDensityTiers() for IntentCell[].
 * Each question's isPhrasingSibling is determined by whether its phrasingGroupId
 * appears in an earlier question (first occurrence is the lead; subsequent are siblings).
 *
 * @param questions   DraftQuestion[] to annotate; mutated in place.
 * @param brief       BrandBrief for language weights.
 * @returns           The same array (mutated), for convenience.
 */
export function applyDensityToQuestions(
  questions: DraftQuestion[],
  brief: BrandBrief,
): DraftQuestion[] {
  const langWeights = new Map(brief.detectedLanguages.map((l) => [l.code, l.weight]));

  // Determine which phrasingGroupIds have already been seen per language
  // (first occurrence = lead; subsequent = sibling).
  const seenGroupPerLang = new Map<string, Set<string>>();

  // --- Pass 1: raw tier ---
  for (const q of questions) {
    const seenSet = seenGroupPerLang.get(q.language) ?? new Set<string>();
    const isPhrasingSibling = seenSet.has(q.phrasingGroupId);
    seenSet.add(q.phrasingGroupId);
    seenGroupPerLang.set(q.language, seenSet);

    const weight = langWeights.get(q.language) ?? 0;
    const funnelStage = (q.funnel_stage ?? 'awareness') as FunnelStage;
    q.density_tier = mapSingleCell(q.intentType, funnelStage, weight, isPhrasingSibling);
  }

  // --- Pass 2: per-language cap ---
  const byLang = new Map<string, DraftQuestion[]>();
  for (const q of questions) {
    const arr = byLang.get(q.language) ?? [];
    arr.push(q);
    byLang.set(q.language, arr);
  }

  for (const [lang, langQs] of byLang) {
    const langCoreCap = Math.ceil(langQs.length * CORE_PER_LANG_CAP_FRACTION);
    const coreQs = langQs.filter((q) => q.density_tier === 'core');

    if (coreQs.length > langCoreCap) {
      // Demote lowest-importance core questions first
      const demotionOrder = [...coreQs].sort((a, b) => {
        const stageOrder: Record<string, number> = {
          awareness: 0,
          consideration: 1,
          decision: 2,
        };
        const stageDiff =
          (stageOrder[a.funnel_stage ?? 'awareness'] ?? 0) -
          (stageOrder[b.funnel_stage ?? 'awareness'] ?? 0);
        if (stageDiff !== 0) return stageDiff;
        return a.intentType.localeCompare(b.intentType);
      });

      let overflow = coreQs.length - langCoreCap;
      for (const q of demotionOrder) {
        if (overflow <= 0) break;
        if (q.density_tier === 'core') {
          q.density_tier = 'secondary';
          overflow--;
        }
      }
    }
    void lang;
  }

  // --- Pass 3: global cap ---
  const totalQuestions = questions.length;
  const globalCoreCap = Math.floor(totalQuestions * CORE_GLOBAL_CAP_FRACTION);
  const coreQs = questions.filter((q) => q.density_tier === 'core');

  if (coreQs.length > globalCoreCap) {
    const demotionOrder = [...coreQs].sort((a, b) => {
      const wa = langWeights.get(a.language) ?? 0;
      const wb = langWeights.get(b.language) ?? 0;
      if (wa !== wb) return wa - wb;
      const stageOrder: Record<string, number> = {
        awareness: 0,
        consideration: 1,
        decision: 2,
      };
      const stageDiff =
        (stageOrder[a.funnel_stage ?? 'awareness'] ?? 0) -
        (stageOrder[b.funnel_stage ?? 'awareness'] ?? 0);
      if (stageDiff !== 0) return stageDiff;
      return a.intentType.localeCompare(b.intentType);
    });

    let overflow = coreQs.length - globalCoreCap;
    for (const q of demotionOrder) {
      if (overflow <= 0) break;
      if (q.density_tier === 'core') {
        q.density_tier = 'secondary';
        overflow--;
      }
    }
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Utility: build langWeights map from BrandBrief (convenience export)
// ---------------------------------------------------------------------------

/**
 * Build a Map<languageCode, weight> from a BrandBrief's detectedLanguages.
 * Convenience helper for callers that have a BrandBrief rather than a raw map.
 */
export function buildLangWeightsMap(brief: BrandBrief): Map<string, number> {
  return new Map(brief.detectedLanguages.map((l) => [l.code, l.weight]));
}
