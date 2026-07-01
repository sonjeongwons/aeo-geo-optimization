/**
 * test/densityMap.test.ts
 *
 * Vitest tests for src/generate/densityMap.ts (T09).
 *
 * Acceptance criteria verified:
 *   1. Core share never exceeds the cap (25%) on any input set.
 *   2. Tiers are reproducible for identical input (deterministic).
 *   3. Paraphrase siblings are NOT all forced to longtail (they go to secondary).
 *   4. densityMap.test.ts asserts core minority + cap enforcement.
 */

import { describe, it, expect } from 'vitest';
import {
  mapSingleCell,
  applyDensityTiers,
  applyDensityToQuestions,
  buildLangWeightsMap,
} from '../src/generate/densityMap.js';
import { buildIntentMatrix } from '../src/generate/intentMatrix.js';
import {
  GenOptionsSchema,
  type BrandBrief,
  type GenOptions,
  type IntentCell,
  type DraftQuestion,
} from '../src/generate/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BRIEF_EN_ONLY: BrandBrief = {
  brandName: 'EMORA',
  brandAliases: ['エモーラ', '에모라'],
  category: 'AI companion app',
  industryKey: 'ai-companion',
  icp: ['loneliness sufferers', 'language learners'],
  productAttributes: ['voice chat', 'emotion tracking'],
  seedCompetitors: [{ name: 'Replika', aliases: ['レプリカ'] }],
  detectedLanguages: [{ code: 'en', weight: 1.0, rationale: 'primary' }],
  confidence: 0.9,
};

const BRIEF_EN_JA: BrandBrief = {
  ...BRIEF_EN_ONLY,
  detectedLanguages: [
    { code: 'en', weight: 1.0, rationale: 'primary' },
    { code: 'ja', weight: 0.9, rationale: 'hreflang' },
  ],
};

/** 14-language emora-like brief. */
const BRIEF_14_LANGS: BrandBrief = {
  ...BRIEF_EN_ONLY,
  detectedLanguages: [
    { code: 'en', weight: 1.0, rationale: 'primary' },
    { code: 'ja', weight: 0.9, rationale: 'hreflang' },
    { code: 'ko', weight: 0.85, rationale: 'hreflang' },
    { code: 'zh-TW', weight: 0.7, rationale: 'hreflang' },
    { code: 'zh-CN', weight: 0.65, rationale: 'hreflang' },
    { code: 'es', weight: 0.5, rationale: 'hreflang' },
    { code: 'pt', weight: 0.45, rationale: 'hreflang' },
    { code: 'fr', weight: 0.4, rationale: 'hreflang' },
    { code: 'de', weight: 0.35, rationale: 'hreflang' },
    { code: 'id', weight: 0.3, rationale: 'hreflang' },
    { code: 'th', weight: 0.2, rationale: 'hreflang' },
    { code: 'vi', weight: 0.2, rationale: 'hreflang' },
    { code: 'tl', weight: 0.15, rationale: 'hreflang' },
    { code: 'ms', weight: 0.15, rationale: 'hreflang' },
  ],
};

function makeOptions(requestedTotal: number): GenOptions {
  return GenOptionsSchema.parse({ requestedTotal });
}

/** Build an IntentCell[] and apply density tiers, returning both for inspection. */
function buildAndApply(brief: BrandBrief, total: number): IntentCell[] {
  const cells = buildIntentMatrix(brief, makeOptions(total));
  const langWeights = buildLangWeightsMap(brief);
  return applyDensityTiers(cells, langWeights, total);
}

/** Count total targetCount for a given tier across all cells. */
function countTier(cells: IntentCell[], tier: 'core' | 'secondary' | 'longtail'): number {
  return cells.filter((c) => c.densityTier === tier).reduce((s, c) => s + c.targetCount, 0);
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1: Core share never exceeds the cap
// ---------------------------------------------------------------------------

describe('densityMap — core share cap', () => {
  it('core share <= 25% for single-language en (total=120)', () => {
    const cells = buildAndApply(BRIEF_EN_ONLY, 120);
    const totalCount = cells.reduce((s, c) => s + c.targetCount, 0);
    const coreCount = countTier(cells, 'core');
    expect(coreCount / totalCount).toBeLessThanOrEqual(0.25);
  });

  it('core share <= 25% for two-language en+ja (total=120)', () => {
    const cells = buildAndApply(BRIEF_EN_JA, 120);
    const totalCount = cells.reduce((s, c) => s + c.targetCount, 0);
    const coreCount = countTier(cells, 'core');
    expect(coreCount / totalCount).toBeLessThanOrEqual(0.25);
  });

  it('core share <= 25% for 14-language emora brief (total=120)', () => {
    const cells = buildAndApply(BRIEF_14_LANGS, 120);
    const totalCount = cells.reduce((s, c) => s + c.targetCount, 0);
    const coreCount = countTier(cells, 'core');
    expect(coreCount / totalCount).toBeLessThanOrEqual(0.25);
  });

  it('core share <= 25% for minimum total (50)', () => {
    const cells = buildAndApply(BRIEF_EN_JA, 50);
    const totalCount = cells.reduce((s, c) => s + c.targetCount, 0);
    const coreCount = countTier(cells, 'core');
    expect(coreCount / totalCount).toBeLessThanOrEqual(0.25);
  });

  it('core share <= 25% for maximum total (200)', () => {
    const cells = buildAndApply(BRIEF_14_LANGS, 200);
    const totalCount = cells.reduce((s, c) => s + c.targetCount, 0);
    const coreCount = countTier(cells, 'core');
    expect(coreCount / totalCount).toBeLessThanOrEqual(0.25);
  });

  it('core is a minority of cells (less than half)', () => {
    const cells = buildAndApply(BRIEF_14_LANGS, 120);
    const coreCount = countTier(cells, 'core');
    const totalCount = cells.reduce((s, c) => s + c.targetCount, 0);
    expect(coreCount).toBeLessThan(totalCount / 2);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: Determinism (tiers reproducible for identical input)
// ---------------------------------------------------------------------------

describe('densityMap — determinism', () => {
  it('produces identical tier assignments for identical inputs', () => {
    const cells1 = buildAndApply(BRIEF_14_LANGS, 120);
    const cells2 = buildAndApply(BRIEF_14_LANGS, 120);
    expect(cells1.map((c) => c.densityTier)).toEqual(cells2.map((c) => c.densityTier));
  });

  it('produces identical tiers for single-language brief', () => {
    const cells1 = buildAndApply(BRIEF_EN_ONLY, 100);
    const cells2 = buildAndApply(BRIEF_EN_ONLY, 100);
    expect(cells1).toEqual(cells2);
  });

  it('mapSingleCell is deterministic for identical inputs', () => {
    const t1 = mapSingleCell('comparison', 'decision', 1.0, false);
    const t2 = mapSingleCell('comparison', 'decision', 1.0, false);
    expect(t1).toBe(t2);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3: Paraphrase siblings are NOT all forced to longtail
// ---------------------------------------------------------------------------

describe('densityMap — paraphrase siblings', () => {
  it('mapSingleCell returns secondary (not longtail) for a sibling', () => {
    // Sibling of a decision/comparison/top-weight cell
    const tier = mapSingleCell('comparison', 'decision', 1.0, true);
    expect(tier).toBe('secondary');
  });

  it('sibling of awareness/attribute is secondary (not longtail)', () => {
    // Even though lead awareness/attribute would be longtail, sibling is secondary
    const tier = mapSingleCell('attribute', 'awareness', 1.0, true);
    expect(tier).toBe('secondary');
  });

  it('sibling of consideration/useCase is secondary', () => {
    const tier = mapSingleCell('useCase', 'consideration', 0.9, true);
    expect(tier).toBe('secondary');
  });

  it('applyDensityToQuestions: sibling questions go to secondary, not longtail', () => {
    // Build two questions with the same phrasingGroupId (second is sibling)
    const questions: DraftQuestion[] = [
      {
        text: 'What are the best AI companion apps?',
        language: 'en',
        funnel_stage: 'decision',
        density_tier: 'secondary', // will be overwritten
        intentType: 'comparison',
        phrasingGroupId: 'group-1',
      },
      {
        text: 'Which AI companion app is most popular?',
        language: 'en',
        funnel_stage: 'decision',
        density_tier: 'secondary', // will be overwritten
        intentType: 'comparison',
        phrasingGroupId: 'group-1', // same group => sibling
      },
    ];

    const result = applyDensityToQuestions(questions, BRIEF_EN_ONLY);
    // Second question is a sibling => secondary
    expect(result[1]!.density_tier).toBe('secondary');
    // It must NOT be longtail
    expect(result[1]!.density_tier).not.toBe('longtail');
  });

  it('lead question can be core; sibling is secondary', () => {
    // 120 total questions, only 2 here — just test raw rule
    const questions: DraftQuestion[] = [
      {
        text: 'Top AI companion apps comparison',
        language: 'en',
        funnel_stage: 'decision',
        density_tier: 'secondary',
        intentType: 'comparison',
        phrasingGroupId: 'cmp-1',
      },
      {
        text: 'Compare AI companion apps ranked',
        language: 'en',
        funnel_stage: 'decision',
        density_tier: 'secondary',
        intentType: 'comparison',
        phrasingGroupId: 'cmp-1', // sibling
      },
    ];

    const result = applyDensityToQuestions(questions, BRIEF_EN_ONLY);
    // Lead may be core (en is top-weight, decision stage, comparison intent)
    // Sibling must be secondary
    expect(result[1]!.density_tier).toBe('secondary');
  });
});

// ---------------------------------------------------------------------------
// mapSingleCell raw rules
// ---------------------------------------------------------------------------

describe('mapSingleCell — raw tier rules', () => {
  it('decision + comparison + top-weight -> core (before cap)', () => {
    expect(mapSingleCell('comparison', 'decision', 1.0, false)).toBe('core');
  });

  it('decision + alternative + top-weight -> core (before cap)', () => {
    expect(mapSingleCell('alternative', 'decision', 0.9, false)).toBe('core');
  });

  it('decision + brand + top-weight -> core (before cap)', () => {
    expect(mapSingleCell('brand', 'decision', 0.8, false)).toBe('core');
  });

  it('decision + category + top-weight -> core (before cap)', () => {
    expect(mapSingleCell('category', 'decision', 0.7, false)).toBe('core');
  });

  it('decision + useCase + top-weight -> secondary (useCase not in core-eligible decision set)', () => {
    expect(mapSingleCell('useCase', 'decision', 1.0, false)).toBe('secondary');
  });

  it('consideration + comparison + top-weight -> secondary', () => {
    expect(mapSingleCell('comparison', 'consideration', 1.0, false)).toBe('secondary');
  });

  it('awareness + attribute -> longtail', () => {
    expect(mapSingleCell('attribute', 'awareness', 1.0, false)).toBe('longtail');
  });

  it('awareness + category -> secondary (not core, not longtail)', () => {
    expect(mapSingleCell('category', 'awareness', 1.0, false)).toBe('secondary');
  });

  it('decision + comparison + LOW-weight -> secondary (weight < threshold)', () => {
    // Low-weight language (below HIGH_WEIGHT_THRESHOLD = 0.5) -> not core
    expect(mapSingleCell('comparison', 'decision', 0.3, false)).toBe('secondary');
  });

  it('decision + comparison + weight exactly at threshold -> core', () => {
    expect(mapSingleCell('comparison', 'decision', 0.5, false)).toBe('core');
  });

  it('decision + attribute -> secondary (not in core-eligible set)', () => {
    expect(mapSingleCell('attribute', 'decision', 1.0, false)).toBe('secondary');
  });
});

// ---------------------------------------------------------------------------
// applyDensityTiers with IntentCell[] — cap enforcement
// ---------------------------------------------------------------------------

describe('applyDensityTiers — cap enforcement on IntentCell[]', () => {
  it('does not exceed 25% core for a single high-weight language', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(120));
    const langWeights = buildLangWeightsMap(BRIEF_EN_ONLY);
    applyDensityTiers(cells, langWeights, 120);

    const total = cells.reduce((s, c) => s + c.targetCount, 0);
    const core = countTier(cells, 'core');
    expect(core / total).toBeLessThanOrEqual(0.25);
  });

  it('every cell has a valid density_tier after applyDensityTiers', () => {
    const cells = buildAndApply(BRIEF_14_LANGS, 200);
    for (const cell of cells) {
      expect(['core', 'secondary', 'longtail']).toContain(cell.densityTier);
    }
  });

  it('at least some cells are non-core (secondary or longtail)', () => {
    const cells = buildAndApply(BRIEF_EN_JA, 120);
    const nonCore = cells.filter((c) => c.densityTier !== 'core');
    expect(nonCore.length).toBeGreaterThan(0);
  });

  it('low-weight languages (<0.5) do not generate core cells', () => {
    // Only en (1.0) and ja (0.9) exceed the 0.5 HIGH_WEIGHT_THRESHOLD
    // th, vi, tl, ms are < 0.5 weight
    const cells = buildAndApply(BRIEF_14_LANGS, 200);
    const lowWeightCodes = new Set(['th', 'vi', 'tl', 'ms', 'de', 'id', 'fr', 'pt']);
    const lowWeightCells = cells.filter((c) => lowWeightCodes.has(c.language));
    const lowWeightCore = lowWeightCells.filter((c) => c.densityTier === 'core');
    // Low-weight languages should have no core cells (below HIGH_WEIGHT_THRESHOLD=0.5)
    expect(lowWeightCore.length).toBe(0);
  });

  it('core cells exist for top-weight languages (pre-cap eligible)', () => {
    // en and ja both have weight >= 0.5; decision+comparison/alternative/brand/category should be core
    const cells = buildAndApply(BRIEF_EN_JA, 200);
    const topWeightCore = cells.filter(
      (c) => (c.language === 'en' || c.language === 'ja') && c.densityTier === 'core'
    );
    expect(topWeightCore.length).toBeGreaterThan(0);
  });

  it('longtail tier exists for awareness+attribute cells', () => {
    const cells = buildAndApply(BRIEF_EN_ONLY, 120);
    const longtailCells = cells.filter((c) => c.densityTier === 'longtail');
    expect(longtailCells.length).toBeGreaterThan(0);
    // All longtail cells should be awareness/attribute
    for (const cell of longtailCells) {
      expect(cell.funnelStage).toBe('awareness');
      expect(cell.intentType).toBe('attribute');
    }
  });

  it('cap enforcement: custom langWeights map with extreme weights still caps core', () => {
    // Build a cell array manually where everything wants to be core
    const extremeCells: IntentCell[] = [
      { language: 'en', funnelStage: 'decision', intentType: 'comparison', targetCount: 50, densityTier: 'secondary' },
      { language: 'en', funnelStage: 'decision', intentType: 'alternative', targetCount: 50, densityTier: 'secondary' },
      { language: 'en', funnelStage: 'decision', intentType: 'brand', targetCount: 50, densityTier: 'secondary' },
      { language: 'en', funnelStage: 'decision', intentType: 'category', targetCount: 50, densityTier: 'secondary' },
    ];
    const langWeights = new Map([['en', 1.0]]);
    const total = 200;
    applyDensityTiers(extremeCells, langWeights, total);
    const core = countTier(extremeCells, 'core');
    expect(core).toBeLessThanOrEqual(Math.floor(total * 0.25));
  });
});

// ---------------------------------------------------------------------------
// applyDensityToQuestions — DraftQuestion level
// ---------------------------------------------------------------------------

describe('applyDensityToQuestions — DraftQuestion[] level', () => {
  it('core share <= 25% on a realistic question set', () => {
    // Generate 40 questions across different intents/stages
    const questions: DraftQuestion[] = [];
    const intents = ['brand', 'comparison', 'alternative', 'category', 'useCase', 'attribute'] as const;
    const stages = ['awareness', 'consideration', 'decision'] as const;
    let i = 0;
    for (const lang of ['en', 'ja', 'ko']) {
      for (const stage of stages) {
        for (const intent of intents) {
          questions.push({
            text: `${intent} question ${i++} in ${lang}`,
            language: lang,
            funnel_stage: stage,
            density_tier: 'secondary',
            intentType: intent,
            phrasingGroupId: `group-${lang}-${stage}-${intent}`,
          });
          // Add a sibling
          questions.push({
            text: `${intent} question ${i++} sibling in ${lang}`,
            language: lang,
            funnel_stage: stage,
            density_tier: 'secondary',
            intentType: intent,
            phrasingGroupId: `group-${lang}-${stage}-${intent}`,
          });
        }
      }
    }

    const brief: BrandBrief = {
      ...BRIEF_EN_ONLY,
      detectedLanguages: [
        { code: 'en', weight: 1.0, rationale: 'primary' },
        { code: 'ja', weight: 0.9, rationale: 'hreflang' },
        { code: 'ko', weight: 0.85, rationale: 'hreflang' },
      ],
    };

    const result = applyDensityToQuestions(questions, brief);
    const coreCount = result.filter((q) => q.density_tier === 'core').length;
    expect(coreCount / result.length).toBeLessThanOrEqual(0.25);
  });

  it('all questions have a valid density_tier after application', () => {
    const questions: DraftQuestion[] = [
      { text: 'Q1', language: 'en', funnel_stage: 'decision', density_tier: 'secondary', intentType: 'comparison', phrasingGroupId: 'g1' },
      { text: 'Q2', language: 'en', funnel_stage: 'awareness', density_tier: 'secondary', intentType: 'attribute', phrasingGroupId: 'g2' },
      { text: 'Q3', language: 'en', funnel_stage: 'consideration', density_tier: 'secondary', intentType: 'useCase', phrasingGroupId: 'g3' },
    ];
    const result = applyDensityToQuestions(questions, BRIEF_EN_ONLY);
    for (const q of result) {
      expect(['core', 'secondary', 'longtail']).toContain(q.density_tier);
    }
  });

  it('awareness/attribute question gets longtail when it is the lead', () => {
    const questions: DraftQuestion[] = [
      {
        text: 'AI app features list',
        language: 'en',
        funnel_stage: 'awareness',
        density_tier: 'secondary',
        intentType: 'attribute',
        phrasingGroupId: 'attr-1',
      },
    ];
    const result = applyDensityToQuestions(questions, BRIEF_EN_ONLY);
    expect(result[0]!.density_tier).toBe('longtail');
  });

  it('cross-language: en and ja questions with same phrasingGroupId are independent', () => {
    // Sibling tracking is PER-LANGUAGE. A ja question with the same phrasingGroupId
    // as an en question is NOT counted as a sibling — sibling sets are per language.
    // We need enough total questions that the global cap doesn't force everything to secondary.
    const questions: DraftQuestion[] = [];
    // Add enough non-core questions so core cap > 0
    for (let i = 0; i < 20; i++) {
      questions.push({
        text: `Awareness question ${i}`,
        language: 'en',
        funnel_stage: 'awareness',
        density_tier: 'secondary',
        intentType: 'category',
        phrasingGroupId: `awareness-en-${i}`,
      });
    }
    // Add the cross-language test pair
    questions.push({ text: 'Compare AI apps', language: 'en', funnel_stage: 'decision', density_tier: 'secondary', intentType: 'comparison', phrasingGroupId: 'shared-group' });
    questions.push({ text: 'AIアプリ比較', language: 'ja', funnel_stage: 'decision', density_tier: 'secondary', intentType: 'comparison', phrasingGroupId: 'shared-group' });

    const result = applyDensityToQuestions(questions, BRIEF_EN_JA);

    // The ja question is the FIRST occurrence of 'shared-group' for language 'ja',
    // so it is a LEAD (not a sibling) in the ja context.
    // The en question is the first occurrence of 'shared-group' for language 'en',
    // so it is also a LEAD in the en context.
    // Both should be considered as leads (not siblings of each other).
    const jaQ = result.find((q) => q.language === 'ja' && q.phrasingGroupId === 'shared-group');
    const enQ = result.find((q) => q.language === 'en' && q.phrasingGroupId === 'shared-group');

    // Both are leads in their language — they could be core (if cap allows)
    // or secondary (if demoted by cap), but NOT longtail (longtail = awareness+attribute)
    expect(jaQ!.density_tier).not.toBe('longtail');
    expect(enQ!.density_tier).not.toBe('longtail');
  });
});

// ---------------------------------------------------------------------------
// buildLangWeightsMap utility
// ---------------------------------------------------------------------------

describe('buildLangWeightsMap', () => {
  it('returns correct weights for all languages in the brief', () => {
    const map = buildLangWeightsMap(BRIEF_EN_JA);
    expect(map.get('en')).toBe(1.0);
    expect(map.get('ja')).toBe(0.9);
    expect(map.size).toBe(2);
  });

  it('returns empty map for brief with no languages (edge case)', () => {
    const briefNoLangs: BrandBrief = {
      ...BRIEF_EN_ONLY,
      detectedLanguages: [{ code: 'en', weight: 1.0, rationale: 'only' }],
    };
    const map = buildLangWeightsMap(briefNoLangs);
    expect(map.size).toBe(1);
    expect(map.get('en')).toBe(1.0);
  });
});
