/**
 * test/intentMatrix.test.ts
 *
 * Vitest tests for src/generate/intentMatrix.ts (T08).
 *
 * Acceptance criteria verified:
 *   1. Sum of cell targetCounts == clamped total (50-200).
 *   2. Higher-weight languages receive more cells/counts.
 *   3. Ordering matches sortByWeight tie-breaking (weight desc, code asc).
 *   4. No LLM/IO (pure function).
 *   5. Covers allocation + clamp + weight ordering.
 */

import { describe, it, expect } from 'vitest';
import { buildIntentMatrix, sumTargetCounts } from '../src/generate/intentMatrix.js';
import { GenOptionsSchema, type BrandBrief, type GenOptions } from '../src/generate/types.js';
import { IntentCellSchema } from '../src/generate/types.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOptions(requestedTotal: number): GenOptions {
  return GenOptionsSchema.parse({ requestedTotal });
}

/** Minimal valid BrandBrief for tests. */
const BRIEF_EN_ONLY: BrandBrief = {
  brandName: 'EMORA',
  brandAliases: [],
  category: 'AI companion app',
  industryKey: 'ai-companion',
  icp: [],
  productAttributes: [],
  seedCompetitors: [],
  detectedLanguages: [{ code: 'en', weight: 1.0, rationale: 'primary' }],
  confidence: 0.9,
};

/** Brief with two languages of different weights. */
const BRIEF_EN_JA: BrandBrief = {
  ...BRIEF_EN_ONLY,
  detectedLanguages: [
    { code: 'en', weight: 1.0, rationale: 'primary' },
    { code: 'ja', weight: 0.6, rationale: 'hreflang' },
  ],
};

/** Brief with three languages — tests tie-breaking on codes. */
const BRIEF_THREE_LANGS: BrandBrief = {
  ...BRIEF_EN_ONLY,
  detectedLanguages: [
    { code: 'ko', weight: 0.8, rationale: 'hreflang' },
    { code: 'en', weight: 1.0, rationale: 'primary' },
    { code: 'ja', weight: 0.8, rationale: 'hreflang' }, // same weight as ko — ties with ko
  ],
};

/** Emora-like brief with 14 languages. */
const BRIEF_14_LANGS: BrandBrief = {
  ...BRIEF_EN_ONLY,
  detectedLanguages: [
    { code: 'en', weight: 1.0,  rationale: 'primary' },
    { code: 'ja', weight: 0.9,  rationale: 'hreflang' },
    { code: 'ko', weight: 0.85, rationale: 'hreflang' },
    { code: 'zh-TW', weight: 0.7, rationale: 'hreflang' },
    { code: 'zh-CN', weight: 0.65, rationale: 'hreflang' },
    { code: 'es', weight: 0.5,  rationale: 'hreflang' },
    { code: 'pt', weight: 0.45, rationale: 'hreflang' },
    { code: 'fr', weight: 0.4,  rationale: 'hreflang' },
    { code: 'de', weight: 0.35, rationale: 'hreflang' },
    { code: 'id', weight: 0.3,  rationale: 'hreflang' },
    { code: 'th', weight: 0.2,  rationale: 'hreflang' },
    { code: 'vi', weight: 0.2,  rationale: 'hreflang' },
    { code: 'tl', weight: 0.15, rationale: 'hreflang' },
    { code: 'ms', weight: 0.15, rationale: 'hreflang' },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sum targetCounts for a specific language. */
function sumForLang(cells: ReturnType<typeof buildIntentMatrix>, lang: string): number {
  return cells.filter((c) => c.language === lang).reduce((s, c) => s + c.targetCount, 0);
}

/** Languages present in cell list, in order of first appearance. */
function langOrder(cells: ReturnType<typeof buildIntentMatrix>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const c of cells) {
    if (!seen.has(c.language)) {
      seen.add(c.language);
      order.push(c.language);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1: Sum of cell targetCounts == clamped total
// ---------------------------------------------------------------------------

describe('buildIntentMatrix — sum(targetCount) == clamped total', () => {
  const totals = [50, 60, 100, 120, 150, 200];

  for (const t of totals) {
    it(`requestedTotal=${t} → sum == ${t}`, () => {
      const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(t));
      expect(sumTargetCounts(cells)).toBe(t);
    });
  }

  it('requestedTotal below 50 is clamped to 50', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(10));
    expect(sumTargetCounts(cells)).toBe(50);
  });

  it('requestedTotal above 200 is clamped to 200', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(999));
    expect(sumTargetCounts(cells)).toBe(200);
  });

  it('multi-language brief sums correctly to requestedTotal', () => {
    for (const t of totals) {
      const cells = buildIntentMatrix(BRIEF_EN_JA, makeOptions(t));
      expect(sumTargetCounts(cells)).toBe(t);
    }
  });

  it('14-language emora brief sums correctly', () => {
    const cells = buildIntentMatrix(BRIEF_14_LANGS, makeOptions(120));
    expect(sumTargetCounts(cells)).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: Higher-weight languages receive more counts
// ---------------------------------------------------------------------------

describe('buildIntentMatrix — language allocation weight ordering', () => {
  it('en (weight=1.0) gets more than ja (weight=0.6) in two-language brief', () => {
    const cells = buildIntentMatrix(BRIEF_EN_JA, makeOptions(120));
    const enCount = sumForLang(cells, 'en');
    const jaCount = sumForLang(cells, 'ja');
    expect(enCount).toBeGreaterThan(jaCount);
  });

  it('en gets more than each of ko and ja in three-language brief', () => {
    const cells = buildIntentMatrix(BRIEF_THREE_LANGS, makeOptions(120));
    const enCount = sumForLang(cells, 'en');
    const koCount = sumForLang(cells, 'ko');
    const jaCount = sumForLang(cells, 'ja');
    // en (1.0) > ko (0.8) and en (1.0) > ja (0.8)
    expect(enCount).toBeGreaterThan(koCount);
    expect(enCount).toBeGreaterThan(jaCount);
  });

  it('all languages have non-zero counts when total is large enough', () => {
    // With 120 total and 14 languages, all should get at least 1
    const cells = buildIntentMatrix(BRIEF_14_LANGS, makeOptions(120));
    const langs = BRIEF_14_LANGS.detectedLanguages.map((l) => l.code);
    for (const lang of langs) {
      const count = sumForLang(cells, lang);
      expect(count).toBeGreaterThan(0);
    }
  });

  it('higher-weight languages get strictly more cells than lower-weight (large total)', () => {
    // en (1.0) > ja (0.9) > ko (0.85) in emora-like brief with enough total
    const cells = buildIntentMatrix(BRIEF_14_LANGS, makeOptions(200));
    const enCount = sumForLang(cells, 'en');
    const jaCount = sumForLang(cells, 'ja');
    const koCount = sumForLang(cells, 'ko');
    const tlCount = sumForLang(cells, 'tl');
    const msCount = sumForLang(cells, 'ms');
    // Top languages should exceed lower ones
    expect(enCount).toBeGreaterThan(jaCount);
    expect(jaCount).toBeGreaterThan(koCount);
    // tl and ms both have weight 0.15 — lowest tier — less than en
    expect(enCount).toBeGreaterThan(tlCount);
    expect(enCount).toBeGreaterThan(msCount);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3: Ordering matches sortByWeight tie-breaking
// ---------------------------------------------------------------------------

describe('buildIntentMatrix — language ordering matches sortByWeight', () => {
  it('single language: en comes first', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(60));
    const order = langOrder(cells);
    expect(order[0]).toBe('en');
  });

  it('two languages: higher weight en before lower weight ja', () => {
    const cells = buildIntentMatrix(BRIEF_EN_JA, makeOptions(60));
    const order = langOrder(cells);
    expect(order[0]).toBe('en');
    expect(order[1]).toBe('ja');
  });

  it('three languages: en (1.0) first; then ko (0.8) before ja (0.8) by code asc', () => {
    // ko < ja lexicographically? No: 'ja' < 'ko' alphabetically.
    // sortByWeight: weight desc then code asc => en(1.0) > ko(0.8) > ja(0.8)
    // code asc: 'ja' < 'ko' => ja comes first among tied weights.
    const cells = buildIntentMatrix(BRIEF_THREE_LANGS, makeOptions(120));
    const order = langOrder(cells);
    expect(order[0]).toBe('en');
    // ja and ko are tied at weight 0.8; 'ja' < 'ko' alphabetically => ja first
    expect(order[1]).toBe('ja');
    expect(order[2]).toBe('ko');
  });

  it('14-language brief: first language is en (highest weight)', () => {
    const cells = buildIntentMatrix(BRIEF_14_LANGS, makeOptions(120));
    const order = langOrder(cells);
    expect(order[0]).toBe('en');
  });

  it('14-language brief: tl and ms (both 0.15) appear in code-asc order', () => {
    const cells = buildIntentMatrix(BRIEF_14_LANGS, makeOptions(200));
    const order = langOrder(cells);
    const tlIdx = order.indexOf('tl');
    const msIdx = order.indexOf('ms');
    // 'ms' < 'tl' alphabetically => ms comes before tl
    expect(msIdx).toBeLessThan(tlIdx);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 4: All cells are valid IntentCells (no LLM/IO)
// ---------------------------------------------------------------------------

describe('buildIntentMatrix — cell schema validity', () => {
  it('every cell validates against IntentCellSchema', () => {
    const cells = buildIntentMatrix(BRIEF_EN_JA, makeOptions(120));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const result = IntentCellSchema.safeParse(cell);
      expect(result.success).toBe(true);
    }
  });

  it('all cells have positive targetCount', () => {
    const cells = buildIntentMatrix(BRIEF_14_LANGS, makeOptions(120));
    for (const cell of cells) {
      expect(cell.targetCount).toBeGreaterThan(0);
    }
  });

  it('densityTier is a valid value (secondary default)', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(60));
    for (const cell of cells) {
      expect(['core', 'secondary', 'longtail']).toContain(cell.densityTier);
    }
  });
});

// ---------------------------------------------------------------------------
// Funnel-stage distribution
// ---------------------------------------------------------------------------

describe('buildIntentMatrix — funnel-stage distribution', () => {
  it('all three funnel stages are represented (single language, large total)', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(120));
    const stages = new Set(cells.map((c) => c.funnelStage));
    expect(stages.has('awareness')).toBe(true);
    expect(stages.has('consideration')).toBe(true);
    expect(stages.has('decision')).toBe(true);
  });

  it('consideration+decision together get more than awareness (35+35 > 30)', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(120));
    const awareness = cells.filter((c) => c.funnelStage === 'awareness' && c.language === 'en')
      .reduce((s, c) => s + c.targetCount, 0);
    const consideration = cells.filter((c) => c.funnelStage === 'consideration' && c.language === 'en')
      .reduce((s, c) => s + c.targetCount, 0);
    const decision = cells.filter((c) => c.funnelStage === 'decision' && c.language === 'en')
      .reduce((s, c) => s + c.targetCount, 0);
    expect(consideration + decision).toBeGreaterThan(awareness);
  });
});

// ---------------------------------------------------------------------------
// Intent-type distribution — bias toward category/comparison/alternative/useCase
// ---------------------------------------------------------------------------

describe('buildIntentMatrix — intent-type distribution', () => {
  it('comparison + alternative + category + useCase get more than brand alone', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(120));
    const enCells = cells.filter((c) => c.language === 'en');
    const brandCount = enCells.filter((c) => c.intentType === 'brand')
      .reduce((s, c) => s + c.targetCount, 0);
    const biasCount = enCells
      .filter((c) => ['comparison', 'alternative', 'category', 'useCase'].includes(c.intentType))
      .reduce((s, c) => s + c.targetCount, 0);
    expect(biasCount).toBeGreaterThan(brandCount);
  });

  it('all 6 intent types appear across the full matrix', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(120));
    const types = new Set(cells.map((c) => c.intentType));
    expect(types.has('brand')).toBe(true);
    expect(types.has('category')).toBe(true);
    expect(types.has('comparison')).toBe(true);
    expect(types.has('alternative')).toBe(true);
    expect(types.has('useCase')).toBe(true);
    expect(types.has('attribute')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('buildIntentMatrix — determinism', () => {
  it('produces identical output for identical inputs', () => {
    const opts = makeOptions(120);
    const cells1 = buildIntentMatrix(BRIEF_14_LANGS, opts);
    const cells2 = buildIntentMatrix(BRIEF_14_LANGS, opts);
    expect(cells1).toEqual(cells2);
  });

  it('produces different totals for different requestedTotals', () => {
    const cells50 = buildIntentMatrix(BRIEF_EN_JA, makeOptions(50));
    const cells200 = buildIntentMatrix(BRIEF_EN_JA, makeOptions(200));
    expect(sumTargetCounts(cells50)).toBe(50);
    expect(sumTargetCounts(cells200)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('buildIntentMatrix — edge cases', () => {
  it('minimum total (50) still produces valid cells summing to 50', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(50));
    expect(sumTargetCounts(cells)).toBe(50);
    expect(cells.length).toBeGreaterThan(0);
  });

  it('maximum total (200) produces valid cells summing to 200', () => {
    const cells = buildIntentMatrix(BRIEF_14_LANGS, makeOptions(200));
    expect(sumTargetCounts(cells)).toBe(200);
  });

  it('single language with minimum total covers multiple cells', () => {
    const cells = buildIntentMatrix(BRIEF_EN_ONLY, makeOptions(50));
    // With 50 questions in 3 stages × 6 types = potentially 18 cells; all positive
    expect(cells.length).toBeGreaterThan(1);
    for (const cell of cells) {
      expect(cell.targetCount).toBeGreaterThan(0);
    }
  });
});
