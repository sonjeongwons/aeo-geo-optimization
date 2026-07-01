/**
 * src/generate/intentMatrix.ts
 *
 * PURE: IntentMatrix builder — given a BrandBrief and GenOptions, produce an
 * IntentCell[] that forms the auditable coverage contract BEFORE any token is
 * spent.
 *
 * Allocation algorithm (DESIGN-phase1.md §Question Model & Generation §2):
 *
 *   1. Sort detectedLanguages by weight desc, then code asc (same ordering as
 *      sampling/languageWeight.ts sortByWeight) so Phase 0 and Phase 1 agree.
 *
 *   2. Distribute the clamped requestedTotal across languages proportional to
 *      their weight.  Use largest-remainder (Hamilton) rounding so the per-
 *      language totals sum exactly to requestedTotal.
 *
 *   3. Within each language distribute the language-total across funnel stages
 *      using the fixed mix awareness 30 / consideration 35 / decision 35 and
 *      again Hamilton-round to sum exactly.
 *
 *   4. Within each (language × funnel_stage) bucket distribute across intent
 *      types using a stage-specific bias (favours category/comparison/
 *      alternative/useCase over brand; attribute is longtail).
 *      Hamilton-round so bucket totals sum exactly.
 *
 *   5. densityTier is left as 'secondary' by default; densityMap.ts will
 *      overwrite it in a later pass (T09).  It is included here so IntentCell
 *      is valid per IntentCellSchema throughout the pipeline.
 *
 *   6. Cells with a targetCount of 0 are omitted (only possible for very small
 *      requestedTotals; Hamilton rounding ensures at most one zero-count cell
 *      is ever produced per bucket before pruning).
 *
 * No LLM calls, no IO.  Deterministic for identical inputs.
 */

import type { BrandBrief, GenOptions, IntentCell } from './types.js';
import { clampTotal } from './types.js';
import type { FunnelStage, IntentType } from './types.js';

// ---------------------------------------------------------------------------
// Funnel-stage weights (fixed mix per spec)
// ---------------------------------------------------------------------------

/** Fixed funnel-stage share (arbitrary-precision; will be normalised). */
const FUNNEL_WEIGHTS: Record<FunnelStage, number> = {
  awareness: 30,
  consideration: 35,
  decision: 35,
};

const FUNNEL_STAGES: FunnelStage[] = ['awareness', 'consideration', 'decision'];

// ---------------------------------------------------------------------------
// Intent-type weights per funnel stage
// ---------------------------------------------------------------------------
// Bias toward category/comparison/alternative/useCase; brand is secondary to
// avoid polluting the measurement with brand-leading questions; attribute is
// always longtail/minor.  These weights are internal to the builder; the
// actual density_tier is set by densityMap.ts.

type IntentWeightMap = Record<IntentType, number>;

const INTENT_WEIGHTS_BY_STAGE: Record<FunnelStage, IntentWeightMap> = {
  awareness: {
    category:    35,
    useCase:     30,
    attribute:   20,
    brand:       10,
    comparison:   3,
    alternative:  2,
  },
  consideration: {
    comparison:  30,
    alternative: 25,
    useCase:     25,
    category:    10,
    brand:        7,
    attribute:    3,
  },
  decision: {
    comparison:  30,
    alternative: 25,
    brand:       20,
    useCase:     15,
    category:     7,
    attribute:    3,
  },
};

const INTENT_TYPES: IntentType[] = [
  'brand',
  'category',
  'comparison',
  'alternative',
  'useCase',
  'attribute',
];

// ---------------------------------------------------------------------------
// Hamilton (largest-remainder) rounding
// ---------------------------------------------------------------------------

/**
 * Distribute `total` integer across `weights` proportionally, using the
 * Hamilton / largest-remainder method to ensure the sum equals `total` exactly.
 *
 * Returns an array of non-negative integers in the same order as `weights`.
 */
function hamiltonRound(weights: number[], total: number): number[] {
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum === 0) {
    // Degenerate case: distribute evenly (or leave as zeros).
    const base = Math.floor(total / weights.length);
    const remainder = total - base * weights.length;
    return weights.map((_, i) => (i < remainder ? base + 1 : base));
  }

  // Floor allocations
  const exact = weights.map((w) => (w / weightSum) * total);
  const floors = exact.map((x) => Math.floor(x));
  const floorSum = floors.reduce((s, v) => s + v, 0);
  let remaining = total - floorSum;

  // Sort indices by fractional part descending, then original index ascending
  // for determinism on ties.
  const indices = weights.map((_, i) => i);
  indices.sort((a, b) => {
    const fracDiff = (exact[b]! % 1) - (exact[a]! % 1);
    if (fracDiff !== 0) return fracDiff;
    return a - b; // tie-break by original index (deterministic)
  });

  const result = [...floors];
  for (let k = 0; k < remaining; k++) {
    result[indices[k]!]! += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// sortDetectedLanguages — mirror of sampling/languageWeight.ts sortByWeight
// ---------------------------------------------------------------------------

interface WeightedLang {
  code: string;
  weight: number;
}

/**
 * Sort detected languages by weight descending; break ties by code ascending.
 * Mirrors the Phase 0 sortByWeight semantics so Phase 1 allocation matches.
 */
function sortDetectedLanguages(langs: WeightedLang[]): WeightedLang[] {
  return [...langs].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.code.localeCompare(b.code);
  });
}

// ---------------------------------------------------------------------------
// buildIntentMatrix — main export
// ---------------------------------------------------------------------------

/**
 * Build the IntentMatrix (IntentCell[]) for the given BrandBrief and options.
 *
 * @param brief   Diagnosed BrandBrief — detectedLanguages drives allocation.
 * @param options Generation options; requestedTotal is clamped to [50, 200].
 * @returns       IntentCell[] ordered by (weight desc, code asc, funnel_stage,
 *                intent_type) with sum(targetCount) === clamped requestedTotal.
 */
export function buildIntentMatrix(brief: BrandBrief, options: GenOptions): IntentCell[] {
  const total = clampTotal(options.requestedTotal);

  // 1. Sort languages by weight desc, code asc.
  const sortedLangs = sortDetectedLanguages(brief.detectedLanguages);
  const langWeights = sortedLangs.map((l) => l.weight);

  // 2. Allocate total across languages (Hamilton rounding).
  const langTotals = hamiltonRound(langWeights, total);

  const cells: IntentCell[] = [];

  for (let li = 0; li < sortedLangs.length; li++) {
    const lang = sortedLangs[li]!;
    const langTotal = langTotals[li]!;

    if (langTotal === 0) continue;

    // 3. Distribute language total across funnel stages.
    const stageWeights = FUNNEL_STAGES.map((s) => FUNNEL_WEIGHTS[s]);
    const stageTotals = hamiltonRound(stageWeights, langTotal);

    for (let si = 0; si < FUNNEL_STAGES.length; si++) {
      const stage = FUNNEL_STAGES[si]!;
      const stageTotal = stageTotals[si]!;

      if (stageTotal === 0) continue;

      // 4. Distribute stage total across intent types.
      const intentWeightMap = INTENT_WEIGHTS_BY_STAGE[stage];
      const intentWeights = INTENT_TYPES.map((t) => intentWeightMap[t]);
      const intentTotals = hamiltonRound(intentWeights, stageTotal);

      for (let ii = 0; ii < INTENT_TYPES.length; ii++) {
        const intentType = INTENT_TYPES[ii]!;
        const count = intentTotals[ii]!;

        if (count === 0) continue;

        cells.push({
          language: lang.code,
          funnelStage: stage,
          intentType,
          targetCount: count,
          // densityTier will be overwritten by densityMap.ts (T09).
          // Set to a valid default now so IntentCellSchema validates.
          densityTier: 'secondary',
        });
      }
    }
  }

  return cells;
}

// ---------------------------------------------------------------------------
// Utility: sum targetCounts (for test assertions)
// ---------------------------------------------------------------------------

/**
 * Sum the targetCount of all cells.  Should equal the clamped requestedTotal.
 */
export function sumTargetCounts(cells: IntentCell[]): number {
  return cells.reduce((s, c) => s + c.targetCount, 0);
}
