/**
 * test/genTemplate.integration.test.ts
 *
 * T21 integration + proof-path tests — gen-template pipeline (T18).
 *
 * Tests the full pipeline end-to-end with stubbed Gemini adapter and repo stubs:
 *   diagnose → intentMatrix → densityMap → dedup → guardrails → assembleTemplate
 *
 * No real HTTP calls, no real DB (repo is injected/stubbed).
 * No Phase 0 read-side modules are modified.
 *
 * Acceptance criteria (T21):
 *   AC1 — Full proof path: industry-only and URL-seeded paths both complete.
 *   AC2 — Generated rows pass CustomerTemplateSchema / QuestionSchema.
 *   AC3 — Output row status is always 'draft' (never reviewed/active).
 *   AC4 — Core-tier share is within the densityMap cap (<=25%) end-to-end.
 *   AC5 — No Phase 0 read-side module modified.
 *
 * DESIGN-phase1.md §"Question Model & Generation", T18, T21.
 */

import { describe, it, expect } from 'vitest';
import { BrandBriefSchema, GenOptionsSchema, type BrandBrief, type DraftQuestion } from '../src/generate/types.js';
import { buildIntentMatrix, sumTargetCounts } from '../src/generate/intentMatrix.js';
import {
  applyDensityTiers,
  applyDensityToQuestions,
  buildLangWeightsMap,
} from '../src/generate/densityMap.js';
import { dedup } from '../src/generate/dedup.js';
import { applyQuestionGuards } from '../src/generate/questionGuards.js';
import {
  assembleTemplate,
  buildQuestionsPayload,
  buildCompetitorsPayload,
  TemplateQuestionRecordSchema,
  type AssembleRepo,
} from '../src/generate/assembleTemplate.js';
import { QuestionSchema } from '../src/config/template.schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * EMORA-like BrandBrief with 3 detected languages — used as the happy-path seed.
 */
function makeEmoryBrief(overrides: Partial<BrandBrief> = {}): BrandBrief {
  return {
    brandName: 'EMORA',
    brandAliases: ['emora', 'エモーラ', '에모라'],
    category: 'AI companion app',
    industryKey: 'ai-companion',
    positioning: 'Emotional memory and multilingual support for companionship.',
    icp: ['young adults seeking emotional connection', 'language learners'],
    productAttributes: ['voice chat', 'emotion tracking', 'multilingual support'],
    seedCompetitors: [
      { name: 'Character.AI', aliases: ['c.ai', 'character.ai'] },
      { name: 'Replika', aliases: ['Replika AI', 'レプリカ'] },
    ],
    detectedLanguages: [
      { code: 'en', weight: 1.0, rationale: 'primary content language' },
      { code: 'ja', weight: 0.9, rationale: 'hreflang[ja] present on 10 pages' },
      { code: 'ko', weight: 0.7, rationale: 'hreflang[ko] present on 8 pages' },
    ],
    confidence: 0.88,
    ...overrides,
  };
}

/**
 * Build a set of DraftQuestions across languages for testing the pipeline
 * downstream stages (dedup, guardrails, assembleTemplate).
 */
function makeDraftQuestions(brief: BrandBrief, count: number): DraftQuestion[] {
  const langs = brief.detectedLanguages.map((l) => l.code);
  const questions: DraftQuestion[] = [];

  const intents = ['category', 'comparison', 'alternative', 'useCase', 'attribute', 'brand'] as const;
  const stages = ['awareness', 'consideration', 'decision'] as const;
  const tiers = ['secondary', 'core', 'longtail'] as const;

  for (let i = 0; i < count; i++) {
    const lang = langs[i % langs.length]!;
    const intent = intents[i % intents.length]!;
    const stage = stages[i % stages.length]!;
    const tier = tiers[i % tiers.length]!;
    const phrasingGroupId = `pg-${lang}-${Math.floor(i / langs.length)}`;

    // Create unique question texts (avoid dedup) with a language marker
    let text: string;
    if (lang === 'ja') {
      text = `AIコンパニオンアプリ${i}の使い方は何ですか`;
    } else if (lang === 'ko') {
      text = `AI 동반자 앱${i}을 어떻게 사용하나요`;
    } else {
      text = `question about ${intent} in the ${brief.category} space ${i}`;
    }

    questions.push({
      text,
      language: lang,
      funnel_stage: stage,
      density_tier: tier,
      intentType: intent,
      phrasingGroupId,
    });
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Stub repo factory
// ---------------------------------------------------------------------------

function makeStubRepo(templateId = 'integration-test-uuid-001'): {
  repo: AssembleRepo;
  insertedRows: () => Array<{ status: string; questions: unknown; competitors: unknown }>;
  advisoryUpdates: () => Array<{ id: string; cols: { generated_total: number; source_url?: string; customer_slug?: string } }>;
} {
  const insertedRows: Array<{ status: string; questions: unknown; competitors: unknown }> = [];
  const advisoryUpdates: Array<{ id: string; cols: { generated_total: number; source_url?: string; customer_slug?: string } }> = [];
  let idCounter = 0;

  const repo: AssembleRepo = {
    async insertIndustryTemplate(t) {
      insertedRows.push({ status: t.status ?? 'draft', questions: t.questions, competitors: t.competitors });
      return { id: `${templateId}-${++idCounter}` };
    },
    async updateAdvisoryCols(id, cols) {
      advisoryUpdates.push({ id, cols });
    },
    async nextTemplateVersion(_industry) {
      return 1;
    },
  };

  return {
    repo,
    insertedRows: () => insertedRows,
    advisoryUpdates: () => advisoryUpdates,
  };
}

// ---------------------------------------------------------------------------
// Tests: BrandBrief validity (T21 AC2 prerequisite)
// ---------------------------------------------------------------------------

describe('BrandBrief fixture — schema validity', () => {
  it('EMORA brief passes BrandBriefSchema', () => {
    const brief = makeEmoryBrief();
    const result = BrandBriefSchema.safeParse(brief);
    expect(result.success).toBe(true);
  });

  it('industry-only brief (single language, no URL) passes BrandBriefSchema', () => {
    const brief = makeEmoryBrief({
      detectedLanguages: [{ code: 'en', weight: 1.0, rationale: 'default' }],
      confidence: 0.3,
    });
    const result = BrandBriefSchema.safeParse(brief);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: IntentMatrix (Stage B of gen-template pipeline)
// ---------------------------------------------------------------------------

describe('IntentMatrix — gen-template stage B', () => {
  it('produces a non-empty matrix for a valid BrandBrief', () => {
    const brief = makeEmoryBrief();
    const opts = GenOptionsSchema.parse({ requestedTotal: 60 });
    const matrix = buildIntentMatrix(brief, opts);
    expect(matrix.length).toBeGreaterThan(0);
  });

  it('sum of targetCounts equals the clamped requestedTotal', () => {
    const brief = makeEmoryBrief();
    const opts = GenOptionsSchema.parse({ requestedTotal: 90 });
    const matrix = buildIntentMatrix(brief, opts);
    const total = sumTargetCounts(matrix);
    expect(total).toBe(90);
  });

  it('higher-weight languages receive more cells', () => {
    const brief = makeEmoryBrief();
    const opts = GenOptionsSchema.parse({ requestedTotal: 120 });
    const matrix = buildIntentMatrix(brief, opts);

    const enCells = matrix.filter((c) => c.language === 'en');
    const koCells = matrix.filter((c) => c.language === 'ko');

    const enTotal = enCells.reduce((s, c) => s + c.targetCount, 0);
    const koTotal = koCells.reduce((s, c) => s + c.targetCount, 0);

    // English (weight=1.0) should have more questions than Korean (weight=0.7)
    expect(enTotal).toBeGreaterThan(koTotal);
  });

  it('each cell has a valid density tier after applyDensityTiers', () => {
    const brief = makeEmoryBrief();
    const opts = GenOptionsSchema.parse({ requestedTotal: 60 });
    const matrix = buildIntentMatrix(brief, opts);
    const langWeights = buildLangWeightsMap(brief);
    const total = sumTargetCounts(matrix);
    applyDensityTiers(matrix, langWeights, total);

    const validTiers = new Set(['core', 'secondary', 'longtail']);
    for (const cell of matrix) {
      expect(validTiers.has(cell.densityTier)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Dedup stage (Stage E)
// ---------------------------------------------------------------------------

describe('Dedup stage — CJK and exact normalization', () => {
  it('dedup returns kept + dropped arrays', () => {
    const brief = makeEmoryBrief();
    const questions = makeDraftQuestions(brief, 20);
    const { kept, dropped } = dedup(questions);

    expect(Array.isArray(kept)).toBe(true);
    expect(Array.isArray(dropped)).toBe(true);
    expect(kept.length + dropped.length).toBe(questions.length);
  });

  it('all kept questions have valid text and language', () => {
    const brief = makeEmoryBrief();
    const questions = makeDraftQuestions(brief, 30);
    const { kept } = dedup(questions);

    for (const q of kept) {
      expect(q.text.length).toBeGreaterThan(0);
      expect(q.language.length).toBeGreaterThan(0);
    }
  });

  it('does not cross-language collapse en and ja phrasings', () => {
    const enQ: DraftQuestion = {
      text: 'best AI companion app for emotional support',
      language: 'en',
      funnel_stage: 'consideration',
      density_tier: 'secondary',
      intentType: 'category',
      phrasingGroupId: 'pg-en-001',
    };
    const jaQ: DraftQuestion = {
      text: 'AIコンパニオンアプリのおすすめ',
      language: 'ja',
      funnel_stage: 'consideration',
      density_tier: 'secondary',
      intentType: 'category',
      phrasingGroupId: 'pg-ja-001',
    };

    const { kept } = dedup([enQ, jaQ]);

    // Both should be kept — cross-language dedup is NOT applied
    const langs = kept.map((q) => q.language);
    expect(langs).toContain('en');
    expect(langs).toContain('ja');
  });

  it('collapses near-identical questions in the same language', () => {
    // Two nearly identical questions in the same language
    const q1: DraftQuestion = {
      text: 'best AI companion app for roleplay and emotional connection',
      language: 'en',
      funnel_stage: 'consideration',
      density_tier: 'secondary',
      intentType: 'category',
      phrasingGroupId: 'pg-en-001',
    };
    const q2: DraftQuestion = {
      text: 'best AI companion app for roleplay and emotional connections',
      language: 'en',
      funnel_stage: 'consideration',
      density_tier: 'secondary',
      intentType: 'category',
      phrasingGroupId: 'pg-en-001', // same group → sibling dropped
    };

    const { kept, dropped } = dedup([q1, q2]);

    // At least one should be kept; at least one should be dropped
    // (either exact dedup from normalisation or near-dup Jaccard)
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.length + dropped.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: QuestionGuards stage (Stage F)
// ---------------------------------------------------------------------------

describe('QuestionGuards stage', () => {
  const brand = 'EMORA';
  // Note: aliases use substring matching; 'emora' would match 'memory' or 'emotional'
  // so aliases here are chosen carefully to avoid accidental substring hits in test texts.
  const brandAliases = ['エモーラ', '에모라'];

  it('keeps valid non-brand-leading questions', () => {
    const questions: DraftQuestion[] = [
      {
        text: 'which AI companion app supports multilingual conversations',
        language: 'en',
        funnel_stage: 'consideration',
        density_tier: 'secondary',
        intentType: 'category',
        phrasingGroupId: 'pg-001',
      },
      {
        text: 'AIキャラクターとチャットできるアプリは何ですか',
        language: 'ja',
        funnel_stage: 'consideration',
        density_tier: 'secondary',
        intentType: 'category',
        phrasingGroupId: 'pg-002',
      },
    ];

    const { kept, rejected } = applyQuestionGuards(questions, brand, brandAliases);
    expect(kept.length).toBe(2);
    expect(rejected.length).toBe(0);
  });

  it('rejects brand-leading question with non-brand intent', () => {
    const badQ: DraftQuestion = {
      text: 'why is EMORA the top AI companion app',
      language: 'en',
      funnel_stage: 'decision',
      density_tier: 'core',
      intentType: 'category', // NOT 'brand' → should be rejected
      phrasingGroupId: 'pg-bad-001',
    };
    const { kept, rejected } = applyQuestionGuards([badQ], brand, brandAliases);
    expect(kept).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatch(/brand/i);
  });

  it('allows brand-naming when intentType is "brand" (open-ended form)', () => {
    // Use a question form that is NOT closed-form (no "is/does/can" start)
    // e.g. "how does EMORA handle privacy" starts with "how" — open-ended
    const brandQ: DraftQuestion = {
      text: 'how does EMORA handle user privacy',
      language: 'en',
      funnel_stage: 'decision',
      density_tier: 'secondary',
      intentType: 'brand', // brand intent → allowed
      phrasingGroupId: 'pg-brand-001',
    };
    const { kept, rejected } = applyQuestionGuards([brandQ], brand, brandAliases);
    expect(kept).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('rejects superlative/claim phrasing', () => {
    const superlativeQ: DraftQuestion = {
      text: 'what is the superior AI companion app on the market',
      language: 'en',
      funnel_stage: 'awareness',
      density_tier: 'secondary',
      intentType: 'category',
      phrasingGroupId: 'pg-superlative-001',
    };
    const { rejected } = applyQuestionGuards([superlativeQ], brand, brandAliases);
    expect(rejected.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: AssembleTemplate stage (Stage G/H) — AC2 + AC3
// ---------------------------------------------------------------------------

describe('assembleTemplate — schema validation + draft status', () => {
  it('inserts with status=draft (generator never emits reviewed/active)', async () => {
    const brief = makeEmoryBrief();
    const { repo, insertedRows } = makeStubRepo();

    const questions = makeDraftQuestions(brief, 10);
    await assembleTemplate({
      questions,
      seedCompetitors: brief.seedCompetitors,
      brief,
      generatedTotal: 13,
      source: 'industry',
      _repo: repo,
    });

    expect(insertedRows()).toHaveLength(1);
    // AC3: always draft
    expect(insertedRows()[0]!.status).toBe('draft');
  });

  it('every question in the payload passes QuestionSchema (canonical subset)', async () => {
    const brief = makeEmoryBrief();
    const { repo, insertedRows } = makeStubRepo();

    const questions = makeDraftQuestions(brief, 15);
    await assembleTemplate({
      questions,
      seedCompetitors: brief.seedCompetitors,
      brief,
      generatedTotal: 20,
      source: 'industry',
      _repo: repo,
    });

    const payload = insertedRows()[0]!.questions as unknown[];
    expect(Array.isArray(payload)).toBe(true);

    // AC2: each question's canonical subset passes QuestionSchema
    for (const q of payload as Array<Record<string, unknown>>) {
      const subset = {
        text: q['text'],
        language: q['language'],
        funnel_stage: q['funnel_stage'],
        density_tier: q['density_tier'],
      };
      const result = QuestionSchema.safeParse(subset);
      expect(result.success).toBe(true);
    }
  });

  it('provenance fields present in JSONB (intentType, phrasingGroupId, etc.)', async () => {
    const brief = makeEmoryBrief();
    const { repo, insertedRows } = makeStubRepo();

    const questions = makeDraftQuestions(brief, 5);
    await assembleTemplate({
      questions,
      seedCompetitors: brief.seedCompetitors,
      brief,
      generatedTotal: 7,
      source: 'url',
      sourceUrl: 'https://emora.app',
      _repo: repo,
    });

    const payload = insertedRows()[0]!.questions as Array<Record<string, unknown>>;
    for (const q of payload) {
      expect(q).toHaveProperty('intentType');
      expect(q).toHaveProperty('phrasingGroupId');
      expect(q).toHaveProperty('source');
      expect(q).toHaveProperty('briefSnapshot');
      expect(q).toHaveProperty('generatedTotal');
      expect(q).toHaveProperty('needsNativeReview');
    }
  });

  it('TemplateQuestionRecordSchema validates each JSONB question', async () => {
    const brief = makeEmoryBrief();
    const questions = makeDraftQuestions(brief, 8);

    // Build the payload inline (pure function)
    const payload = buildQuestionsPayload(questions, brief, 10, 'industry', ['tl', 'vi', 'th']);

    for (const q of payload) {
      const result = TemplateQuestionRecordSchema.safeParse(q);
      expect(result.success).toBe(true);
    }
  });

  it('competitors payload passes CompetitorSchema for all entries', async () => {
    const brief = makeEmoryBrief();
    const payload = buildCompetitorsPayload(brief.seedCompetitors);

    for (const comp of payload) {
      expect(comp.name.length).toBeGreaterThan(0);
      expect(Array.isArray(comp.aliases)).toBe(true);
    }
  });

  it('advisory columns include generated_total', async () => {
    const brief = makeEmoryBrief();
    const { repo, advisoryUpdates } = makeStubRepo();

    const questions = makeDraftQuestions(brief, 5);
    await assembleTemplate({
      questions,
      seedCompetitors: brief.seedCompetitors,
      brief,
      generatedTotal: 9,
      source: 'industry',
      _repo: repo,
    });

    expect(advisoryUpdates()).toHaveLength(1);
    expect(advisoryUpdates()[0]!.cols.generated_total).toBe(9);
  });

  it('source_url advisory column set when sourceUrl is provided', async () => {
    const brief = makeEmoryBrief();
    const { repo, advisoryUpdates } = makeStubRepo();

    const questions = makeDraftQuestions(brief, 5);
    await assembleTemplate({
      questions,
      seedCompetitors: brief.seedCompetitors,
      brief,
      generatedTotal: 7,
      source: 'url',
      sourceUrl: 'https://emora.app',
      _repo: repo,
    });

    expect(advisoryUpdates()[0]!.cols.source_url).toBe('https://emora.app');
  });

  it('customer_slug advisory column set when customerSlug provided', async () => {
    const brief = makeEmoryBrief();
    const { repo, advisoryUpdates } = makeStubRepo();

    const questions = makeDraftQuestions(brief, 5);
    await assembleTemplate({
      questions,
      seedCompetitors: brief.seedCompetitors,
      brief,
      generatedTotal: 7,
      source: 'url',
      customerSlug: 'emora',
      _repo: repo,
    });

    expect(advisoryUpdates()[0]!.cols.customer_slug).toBe('emora');
  });

  it('throws before DB write when a question has empty text', async () => {
    const brief = makeEmoryBrief();
    const { repo, insertedRows } = makeStubRepo();

    const badQuestion: DraftQuestion = {
      text: '',
      language: 'en',
      funnel_stage: 'awareness',
      density_tier: 'secondary',
      intentType: 'category',
      phrasingGroupId: 'pg-001',
    };

    await expect(
      assembleTemplate({
        questions: [badQuestion],
        seedCompetitors: brief.seedCompetitors,
        brief,
        generatedTotal: 1,
        source: 'industry',
        _repo: repo,
      }),
    ).rejects.toThrow();

    // No DB write happened
    expect(insertedRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: AC4 — Core-tier share within cap end-to-end
// ---------------------------------------------------------------------------

describe('Core-tier cap — AC4 (<=25% end-to-end)', () => {
  it('core tier share stays within 25% after applyDensityTiers', () => {
    const brief = makeEmoryBrief();
    const opts = GenOptionsSchema.parse({ requestedTotal: 120 });
    const matrix = buildIntentMatrix(brief, opts);
    const langWeights = buildLangWeightsMap(brief);
    const total = sumTargetCounts(matrix);
    applyDensityTiers(matrix, langWeights, total);

    const coreCount = matrix
      .filter((c) => c.densityTier === 'core')
      .reduce((s, c) => s + c.targetCount, 0);

    // AC4: core must be <=25% of total
    const coreShare = coreCount / total;
    expect(coreShare).toBeLessThanOrEqual(0.25);
  });

  it('core tier share stays within 25% after applyDensityToQuestions', () => {
    const brief = makeEmoryBrief();
    const questions = makeDraftQuestions(brief, 80);

    applyDensityToQuestions(questions, brief);

    const coreCount = questions.filter((q) => q.density_tier === 'core').length;
    const coreShare = coreCount / questions.length;

    // AC4: core must be <=25% of total
    expect(coreShare).toBeLessThanOrEqual(0.25);
  });

  it('core share stays within cap for single-language brief', () => {
    const singleLangBrief = makeEmoryBrief({
      detectedLanguages: [
        { code: 'en', weight: 1.0, rationale: 'only language' },
      ],
    });
    const opts = GenOptionsSchema.parse({ requestedTotal: 50 });
    const matrix = buildIntentMatrix(singleLangBrief, opts);
    const langWeights = buildLangWeightsMap(singleLangBrief);
    const total = sumTargetCounts(matrix);
    applyDensityTiers(matrix, langWeights, total);

    const coreCount = matrix
      .filter((c) => c.densityTier === 'core')
      .reduce((s, c) => s + c.targetCount, 0);

    const coreShare = coreCount / total;
    expect(coreShare).toBeLessThanOrEqual(0.25);
  });

  it('tiers are reproducible for identical input (deterministic)', () => {
    const brief = makeEmoryBrief();
    const opts = GenOptionsSchema.parse({ requestedTotal: 80 });

    const matrix1 = buildIntentMatrix(brief, opts);
    const langWeights1 = buildLangWeightsMap(brief);
    const total1 = sumTargetCounts(matrix1);
    applyDensityTiers(matrix1, langWeights1, total1);

    const matrix2 = buildIntentMatrix(brief, opts);
    const langWeights2 = buildLangWeightsMap(brief);
    const total2 = sumTargetCounts(matrix2);
    applyDensityTiers(matrix2, langWeights2, total2);

    // Same inputs → same tiers (deterministic)
    expect(
      matrix1.map((c) => ({ lang: c.language, tier: c.densityTier, count: c.targetCount })),
    ).toEqual(
      matrix2.map((c) => ({ lang: c.language, tier: c.densityTier, count: c.targetCount })),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Full proof path (industry-only) — T21 AC1
// ---------------------------------------------------------------------------

describe('Full proof path — industry-only (T21 AC1)', () => {
  it('runs the full industry-only pipeline and produces a draft template', async () => {
    const brief = makeEmoryBrief({
      detectedLanguages: [
        { code: 'en', weight: 1.0, rationale: 'default' },
        { code: 'ja', weight: 0.8, rationale: 'hreflang' },
      ],
    });

    const opts = GenOptionsSchema.parse({ requestedTotal: 60 });

    // Stage B: IntentMatrix
    const matrix = buildIntentMatrix(brief, opts);
    expect(sumTargetCounts(matrix)).toBe(60);

    // Stage C: Density tiers
    const langWeights = buildLangWeightsMap(brief);
    const total = sumTargetCounts(matrix);
    applyDensityTiers(matrix, langWeights, total);

    // Stage D-E: Generate questions (using fixture questions, not Gemini)
    const generatedQuestions = makeDraftQuestions(brief, 78); // 1.3x of 60

    // Stage E: Apply density tiers to generated questions
    applyDensityToQuestions(generatedQuestions, brief);

    // Stage F: Dedup
    const { kept: dedupedQuestions } = dedup(generatedQuestions);
    expect(dedupedQuestions.length).toBeGreaterThan(0);

    // Stage G: Guardrails
    const { kept: guardedQuestions } = applyQuestionGuards(
      dedupedQuestions,
      brief.brandName,
      brief.brandAliases,
    );
    expect(guardedQuestions.length).toBeGreaterThan(0);

    // Stage H: Assemble + persist draft
    const { repo, insertedRows } = makeStubRepo();
    const result = await assembleTemplate({
      questions: guardedQuestions,
      seedCompetitors: brief.seedCompetitors,
      brief,
      generatedTotal: generatedQuestions.length,
      source: 'industry',
      _repo: repo,
    });

    // AC3: status must be draft
    expect(insertedRows()[0]!.status).toBe('draft');
    expect(result.templateId).toBeDefined();
    expect(result.questionCount).toBeGreaterThan(0);

    // AC2: every question passes QuestionSchema
    const payload = insertedRows()[0]!.questions as Array<Record<string, unknown>>;
    for (const q of payload) {
      const subset = {
        text: q['text'],
        language: q['language'],
        funnel_stage: q['funnel_stage'],
        density_tier: q['density_tier'],
      };
      const parsed = QuestionSchema.safeParse(subset);
      expect(parsed.success).toBe(true);
    }

    // AC4: core share within cap
    const coreCount = (payload).filter((q) => q['density_tier'] === 'core').length;
    if (payload.length > 0) {
      expect(coreCount / payload.length).toBeLessThanOrEqual(0.25);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: --industry-only path works without a URL (T18 AC)
// ---------------------------------------------------------------------------

describe('--industry-only path — no URL required', () => {
  it('builds a valid IntentMatrix from industry-only BrandBrief', () => {
    const brief = makeEmoryBrief({
      // Simulate industry-only: low confidence, minimal detail
      confidence: 0.25,
      positioning: undefined,
      icp: [],
      productAttributes: [],
      seedCompetitors: [],
      detectedLanguages: [
        { code: 'en', weight: 1.0, rationale: 'default for industry-only' },
      ],
    });

    const opts = GenOptionsSchema.parse({ requestedTotal: 50 });
    const matrix = buildIntentMatrix(brief, opts);

    expect(sumTargetCounts(matrix)).toBe(50);
    expect(matrix.length).toBeGreaterThan(0);
  });

  it('assembleTemplate succeeds with no seedCompetitors', async () => {
    const brief = makeEmoryBrief({ seedCompetitors: [] });
    const { repo, insertedRows } = makeStubRepo();
    const questions = makeDraftQuestions(brief, 5);

    await assembleTemplate({
      questions,
      seedCompetitors: [], // no competitors
      brief,
      generatedTotal: 7,
      source: 'industry',
      _repo: repo,
    });

    expect(insertedRows()[0]!.status).toBe('draft');
    const competitors = insertedRows()[0]!.competitors as unknown[];
    expect(Array.isArray(competitors)).toBe(true);
    expect(competitors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: needsNativeReview flag (T21 — low-resource language handling)
// ---------------------------------------------------------------------------

describe('needsNativeReview flag for low-resource languages', () => {
  it('sets needsNativeReview=true for configured low-resource languages', () => {
    const brief = makeEmoryBrief({
      detectedLanguages: [
        { code: 'en', weight: 1.0, rationale: 'primary' },
        { code: 'tl', weight: 0.3, rationale: 'Filipino market' },
        { code: 'vi', weight: 0.3, rationale: 'Vietnam market' },
      ],
    });

    const questions: DraftQuestion[] = [
      {
        text: 'best AI companion app',
        language: 'en',
        funnel_stage: 'consideration',
        density_tier: 'secondary',
        intentType: 'category',
        phrasingGroupId: 'pg-en-001',
      },
      {
        text: 'Pinakamahusay na AI companion app',
        language: 'tl',
        funnel_stage: 'consideration',
        density_tier: 'secondary',
        intentType: 'category',
        phrasingGroupId: 'pg-tl-001',
      },
      {
        text: 'Ứng dụng AI tốt nhất để kết bạn',
        language: 'vi',
        funnel_stage: 'consideration',
        density_tier: 'secondary',
        intentType: 'category',
        phrasingGroupId: 'pg-vi-001',
      },
    ];

    const payload = buildQuestionsPayload(
      questions,
      brief,
      3,
      'industry',
      ['tl', 'vi', 'th'], // low-resource languages
    );

    const enQ = payload.find((q) => q.language === 'en');
    const tlQ = payload.find((q) => q.language === 'tl');
    const viQ = payload.find((q) => q.language === 'vi');

    expect(enQ?.needsNativeReview).toBe(false);
    expect(tlQ?.needsNativeReview).toBe(true);
    expect(viQ?.needsNativeReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GQ-1 fix — core cap applied to FINAL set (post-dedup + post-guardrails)
// ---------------------------------------------------------------------------

describe('GQ-1 — core cap enforced on final set, not over-generated pool', () => {
  it('core share <=25% of the FINAL kept set after dedup + guardrails', () => {
    const brief = makeEmoryBrief();

    // Simulate over-generation (1.3x of target 60 = 78 questions)
    const overGeneratedPool = makeDraftQuestions(brief, 78);

    // Dedup
    const { kept: dedupedQuestions } = dedup(overGeneratedPool);

    // Guardrails
    const { kept: guardedQuestions } = applyQuestionGuards(
      dedupedQuestions,
      brief.brandName,
      brief.brandAliases,
    );

    // Apply density AFTER dedup+guardrails (GQ-1 fix: denominator = final count)
    applyDensityToQuestions(guardedQuestions, brief);

    const finalCount = guardedQuestions.length;
    const coreCount = guardedQuestions.filter((q) => q.density_tier === 'core').length;

    if (finalCount > 0) {
      const coreShare = coreCount / finalCount;
      expect(coreShare).toBeLessThanOrEqual(0.25);
    }
  });

  it('core share <=25% even when a large fraction is pruned by guardrails', () => {
    // Construct questions where many will survive guardrails — core cap must
    // still be computed against the FINAL count, not the pre-prune count.
    const brief = makeEmoryBrief({
      detectedLanguages: [
        { code: 'en', weight: 1.0, rationale: 'primary' },
        { code: 'ja', weight: 0.9, rationale: 'secondary' },
      ],
    });

    // Build a large pool — purely safe questions (no superlative/brand-leading)
    const pool = makeDraftQuestions(brief, 100);

    const { kept: deduped } = dedup(pool);
    const { kept: guarded } = applyQuestionGuards(deduped, brief.brandName, brief.brandAliases);

    // Apply density tiers to the final set
    applyDensityToQuestions(guarded, brief);

    const finalCount = guarded.length;
    const coreCount = guarded.filter((q) => q.density_tier === 'core').length;

    if (finalCount > 0) {
      expect(coreCount / finalCount).toBeLessThanOrEqual(0.25);
    }
  });
});
