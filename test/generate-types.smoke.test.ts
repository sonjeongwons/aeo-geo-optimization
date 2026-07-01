/**
 * test/generate-types.smoke.test.ts
 *
 * Vitest type/parse smoke test for src/generate/types.ts (T01).
 *
 * Acceptance criteria verified:
 *   1. All schemas exported with inferred TS types (compile-time via import).
 *   2. DraftQuestion's {text,language,funnel_stage,density_tier} subset
 *      validates against template.schema.ts QuestionSchema.
 *   3. requestedTotal clamps to [50,200].
 *   4. This smoke test passes.
 */

import { describe, it, expect } from 'vitest';
import {
  BrandBriefSchema,
  IntentTypeSchema,
  FunnelStageSchema,
  IntentCellSchema,
  DraftQuestionSchema,
  GenOptionsSchema,
  clampTotal,
  type BrandBrief,
  type IntentType,
  type FunnelStage,
  type IntentCell,
  type DraftQuestion,
  type GenOptions,
} from '../src/generate/types.js';
import { QuestionSchema } from '../src/config/template.schema.js';

// ---------------------------------------------------------------------------
// IntentTypeSchema
// ---------------------------------------------------------------------------

describe('IntentTypeSchema', () => {
  it('accepts all six intent types', () => {
    const values: IntentType[] = [
      'brand', 'category', 'comparison', 'alternative', 'useCase', 'attribute',
    ];
    for (const v of values) {
      expect(IntentTypeSchema.parse(v)).toBe(v);
    }
  });

  it('rejects unknown intent types', () => {
    expect(() => IntentTypeSchema.parse('unknown')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// FunnelStageSchema
// ---------------------------------------------------------------------------

describe('FunnelStageSchema', () => {
  it('accepts all three funnel stages', () => {
    const values: FunnelStage[] = ['awareness', 'consideration', 'decision'];
    for (const v of values) {
      expect(FunnelStageSchema.parse(v)).toBe(v);
    }
  });

  it('rejects unknown funnel stages', () => {
    expect(() => FunnelStageSchema.parse('purchase')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// BrandBriefSchema
// ---------------------------------------------------------------------------

describe('BrandBriefSchema', () => {
  const validBrief: BrandBrief = {
    brandName: 'EMORA',
    brandAliases: ['Emora', 'エモーラ', '에모라'],
    category: 'AI companion app',
    industryKey: 'ai-companion',
    positioning: 'EMORA differentiates via long-term emotional memory and multilingual support.',
    icp: ['lonely adults 18-35', 'language learners'],
    productAttributes: ['voice chat', 'emotion tracking'],
    seedCompetitors: [
      { name: 'Replika', aliases: ['レプリカ'] },
    ],
    detectedLanguages: [
      { code: 'en', weight: 1.0, rationale: 'Primary content language' },
      { code: 'ja', weight: 0.8, rationale: 'hreflang[ja] present with 8 pages' },
    ],
    confidence: 0.85,
  };

  it('parses a valid BrandBrief', () => {
    const result = BrandBriefSchema.parse(validBrief);
    expect(result.brandName).toBe('EMORA');
    expect(result.detectedLanguages).toHaveLength(2);
    expect(result.confidence).toBe(0.85);
  });

  it('applies defaults for optional array fields', () => {
    const minimal = {
      brandName: 'ACME',
      category: 'widgets',
      industryKey: 'widgets',
      detectedLanguages: [{ code: 'en', weight: 1.0, rationale: 'only language' }],
      confidence: 0.5,
    };
    const result = BrandBriefSchema.parse(minimal);
    expect(result.brandAliases).toEqual([]);
    expect(result.icp).toEqual([]);
    expect(result.productAttributes).toEqual([]);
    expect(result.seedCompetitors).toEqual([]);
  });

  it('rejects industryKey with spaces or uppercase', () => {
    expect(() =>
      BrandBriefSchema.parse({
        ...validBrief,
        industryKey: 'AI Companion',
      })
    ).toThrow();
  });

  it('requires at least one detectedLanguage', () => {
    expect(() =>
      BrandBriefSchema.parse({ ...validBrief, detectedLanguages: [] })
    ).toThrow();
  });

  it('rejects confidence outside [0,1]', () => {
    expect(() =>
      BrandBriefSchema.parse({ ...validBrief, confidence: 1.1 })
    ).toThrow();
    expect(() =>
      BrandBriefSchema.parse({ ...validBrief, confidence: -0.1 })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// IntentCellSchema
// ---------------------------------------------------------------------------

describe('IntentCellSchema', () => {
  it('parses a valid IntentCell', () => {
    const cell: IntentCell = {
      language: 'ja',
      funnelStage: 'decision',
      intentType: 'comparison',
      targetCount: 10,
      densityTier: 'core',
    };
    expect(IntentCellSchema.parse(cell)).toMatchObject(cell);
  });
});

// ---------------------------------------------------------------------------
// DraftQuestionSchema — canonical subset compatibility
// ---------------------------------------------------------------------------

describe('DraftQuestionSchema', () => {
  const validDraft: DraftQuestion = {
    text: 'AIコンパニオンアプリの中でEMORAはどのような位置づけですか？',
    language: 'ja',
    funnel_stage: 'consideration',
    density_tier: 'secondary',
    intentType: 'comparison',
    phrasingGroupId: 'pg-001',
  };

  it('parses a valid DraftQuestion', () => {
    const result = DraftQuestionSchema.parse(validDraft);
    expect(result.text).toContain('EMORA');
    expect(result.intentType).toBe('comparison');
    expect(result.phrasingGroupId).toBe('pg-001');
  });

  it('canonical {text,language,funnel_stage,density_tier} subset passes QuestionSchema', () => {
    const parsed = DraftQuestionSchema.parse(validDraft);
    // Extract the 4-field canonical subset and validate against QuestionSchema
    const canonical = {
      text: parsed.text,
      language: parsed.language,
      funnel_stage: parsed.funnel_stage,
      density_tier: parsed.density_tier,
    };
    // Must not throw
    const q = QuestionSchema.parse(canonical);
    expect(q.text).toBe(parsed.text);
    expect(q.language).toBe(parsed.language);
    expect(q.density_tier).toBe(parsed.density_tier);
  });

  it('accepts null funnel_stage (nullable per QuestionSchema)', () => {
    const withNullStage = { ...validDraft, funnel_stage: null };
    const result = DraftQuestionSchema.parse(withNullStage);
    expect(result.funnel_stage).toBeNull();
    // Canonical subset still passes QuestionSchema
    const q = QuestionSchema.parse({
      text: result.text,
      language: result.language,
      funnel_stage: result.funnel_stage,
      density_tier: result.density_tier,
    });
    expect(q.funnel_stage).toBeNull();
  });

  it('rejects unknown density_tier', () => {
    expect(() =>
      DraftQuestionSchema.parse({ ...validDraft, density_tier: 'ultra' })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// GenOptionsSchema — requestedTotal clamping
// ---------------------------------------------------------------------------

describe('GenOptionsSchema', () => {
  it('defaults requestedTotal to 120', () => {
    const result: GenOptions = GenOptionsSchema.parse({});
    expect(result.requestedTotal).toBe(120);
  });

  it('clamps requestedTotal below 50 to 50', () => {
    const result = GenOptionsSchema.parse({ requestedTotal: 10 });
    expect(result.requestedTotal).toBe(50);
  });

  it('clamps requestedTotal above 200 to 200', () => {
    const result = GenOptionsSchema.parse({ requestedTotal: 999 });
    expect(result.requestedTotal).toBe(200);
  });

  it('passes through values in [50,200] unchanged', () => {
    expect(GenOptionsSchema.parse({ requestedTotal: 50 }).requestedTotal).toBe(50);
    expect(GenOptionsSchema.parse({ requestedTotal: 120 }).requestedTotal).toBe(120);
    expect(GenOptionsSchema.parse({ requestedTotal: 200 }).requestedTotal).toBe(200);
  });

  it('defaults lowResourceLanguages to [tl, vi, th]', () => {
    const result = GenOptionsSchema.parse({});
    expect(result.lowResourceLanguages).toEqual(['tl', 'vi', 'th']);
  });
});

// ---------------------------------------------------------------------------
// clampTotal utility
// ---------------------------------------------------------------------------

describe('clampTotal', () => {
  it('clamps below 50', () => expect(clampTotal(0)).toBe(50));
  it('clamps above 200', () => expect(clampTotal(300)).toBe(200));
  it('passes through 50-200', () => {
    expect(clampTotal(50)).toBe(50);
    expect(clampTotal(120)).toBe(120);
    expect(clampTotal(200)).toBe(200);
  });
});
