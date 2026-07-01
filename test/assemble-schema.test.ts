/**
 * test/assemble-schema.test.ts
 *
 * T15 acceptance tests: assemble-schema
 *
 * Verifies that assembleTemplate():
 *   1. Builds a valid JSONB payload where every question's canonical subset
 *      passes QuestionSchema.
 *   2. Provenance fields (intentType, phrasingGroupId, source, briefSnapshot,
 *      generatedTotal, needsNativeReview) are present in the JSONB but are
 *      NOT part of the canonical QuestionSchema subset.
 *   3. Status of the inserted row is always 'draft' (generator never emits
 *      reviewed/active).
 *   4. Validation throws before any DB write when a question fails QuestionSchema.
 *   5. Validation throws before any DB write when a competitor fails schema.
 *   6. needsNativeReview=true for configured low-resource languages.
 *   7. Advisory columns (source_url, customer_slug, generated_total) are set.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  assembleTemplate,
  buildQuestionsPayload,
  buildCompetitorsPayload,
  validateCanonicalSubset,
  validateCompetitor,
  buildBriefSnapshot,
  TemplateQuestionRecordSchema,
  TemplateCompetitorRecordSchema,
  type AssembleRepo,
  type AssembleOptions,
  type TemplateQuestionRecord,
} from '../src/generate/assembleTemplate.js';
import { QuestionSchema } from '../src/config/template.schema.js';
import type { DraftQuestion, BrandBrief, SeedCompetitor } from '../src/generate/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBrief(overrides: Partial<BrandBrief> = {}): BrandBrief {
  return {
    brandName: 'EMORA',
    brandAliases: ['emora', 'エモーラ', '에모라'],
    category: 'AI companion app',
    industryKey: 'ai-companion',
    positioning: 'Emotional memory and multilingual support',
    icp: ['young adults seeking companionship'],
    productAttributes: ['voice chat', 'emotion tracking'],
    seedCompetitors: [
      { name: 'Replika', aliases: ['Replika AI', 'レプリカ'] },
      { name: 'Character.AI', aliases: [] },
    ],
    detectedLanguages: [
      { code: 'en', weight: 1.0, rationale: 'primary content language' },
      { code: 'ja', weight: 0.8, rationale: 'hreflang[ja] present' },
      { code: 'ko', weight: 0.6, rationale: 'hreflang[ko] present' },
      { code: 'tl', weight: 0.2, rationale: 'hreflang[tl] present' },
    ],
    confidence: 0.85,
    ...overrides,
  };
}

function makeDraftQuestion(overrides: Partial<DraftQuestion> & { text: string }): DraftQuestion {
  return {
    language: 'en',
    funnel_stage: 'consideration',
    density_tier: 'secondary',
    intentType: 'category',
    phrasingGroupId: 'pg-en-001',
    ...overrides,
  };
}

function makeSeedCompetitor(name: string, aliases: string[] = []): SeedCompetitor {
  return { name, aliases };
}

/**
 * Build a stub AssembleRepo that captures calls for assertions.
 */
function makeStubRepo(templateId = 'test-uuid-001', nextVersion = 1): {
  repo: AssembleRepo;
  insertedStatus: () => string | undefined;
  insertedVersion: () => number | undefined;
  advisoryCols: () => Parameters<AssembleRepo['updateAdvisoryCols']>[1] | undefined;
  versionCallCount: () => number;
} {
  let capturedStatus: string | undefined;
  let capturedVersion: number | undefined;
  let capturedAdvisory: Parameters<AssembleRepo['updateAdvisoryCols']>[1] | undefined;
  let versionCalls = 0;

  const repo: AssembleRepo = {
    async insertIndustryTemplate(t) {
      capturedStatus = t.status;
      capturedVersion = t.version;
      return { id: templateId };
    },
    async updateAdvisoryCols(_id, cols) {
      capturedAdvisory = cols;
    },
    async nextTemplateVersion(_industry) {
      versionCalls++;
      return nextVersion;
    },
  };

  return {
    repo,
    insertedStatus: () => capturedStatus,
    insertedVersion: () => capturedVersion,
    advisoryCols: () => capturedAdvisory,
    versionCallCount: () => versionCalls,
  };
}

const QUESTIONS_EN: DraftQuestion[] = [
  makeDraftQuestion({ text: 'What are the best AI companion apps in 2024?', phrasingGroupId: 'pg-en-001' }),
  makeDraftQuestion({ text: 'How do AI companions help with emotional support?', phrasingGroupId: 'pg-en-002', intentType: 'useCase', funnel_stage: 'awareness' }),
  makeDraftQuestion({ text: 'Compare AI companion apps for daily use', phrasingGroupId: 'pg-en-003', intentType: 'comparison', funnel_stage: 'decision', density_tier: 'core' }),
];

const QUESTIONS_JA: DraftQuestion[] = [
  makeDraftQuestion({ text: 'AIコンパニオンアプリの比較', language: 'ja', phrasingGroupId: 'pg-ja-001', intentType: 'comparison', funnel_stage: 'decision' }),
  makeDraftQuestion({ text: 'AIコンパニオンで感情サポートはできますか', language: 'ja', phrasingGroupId: 'pg-ja-002', intentType: 'useCase', funnel_stage: 'consideration' }),
];

const QUESTIONS_TL: DraftQuestion[] = [
  makeDraftQuestion({
    text: 'Anong mga AI companion app ang pinaka-popular?',
    language: 'tl',
    phrasingGroupId: 'pg-tl-001',
    funnel_stage: 'awareness',
    density_tier: 'longtail',
  }),
];

const ALL_QUESTIONS = [...QUESTIONS_EN, ...QUESTIONS_JA, ...QUESTIONS_TL];

const SEED_COMPETITORS: SeedCompetitor[] = [
  { name: 'Replika', aliases: ['Replika AI', 'レプリカ'] },
  { name: 'Character.AI', aliases: [] },
];

// ---------------------------------------------------------------------------
// Acceptance criterion 1: Every question's canonical subset passes QuestionSchema
// ---------------------------------------------------------------------------

describe('T15 AC1 — canonical subset validity', () => {
  it('buildQuestionsPayload produces records whose canonical subset passes QuestionSchema', () => {
    const brief = makeBrief();
    const payload = buildQuestionsPayload(ALL_QUESTIONS, brief, 20, 'url', ['tl', 'vi', 'th']);

    for (const record of payload) {
      const canonical = {
        text: record.text,
        language: record.language,
        funnel_stage: record.funnel_stage,
        density_tier: record.density_tier,
      };
      const result = QuestionSchema.safeParse(canonical);
      expect(result.success, `QuestionSchema failed for text="${record.text}": ${!result.success ? result.error.message : ''}`).toBe(true);
    }
  });

  it('validateCanonicalSubset accepts all fixture questions without throwing', () => {
    for (let i = 0; i < ALL_QUESTIONS.length; i++) {
      expect(() => validateCanonicalSubset(ALL_QUESTIONS[i]!, i)).not.toThrow();
    }
  });

  it('validateCanonicalSubset throws on invalid density_tier', () => {
    const bad = makeDraftQuestion({ text: 'valid text', density_tier: 'invalid' as 'core' });
    expect(() => validateCanonicalSubset(bad, 0)).toThrow(/canonical QuestionSchema/);
  });

  it('validateCanonicalSubset throws on empty text', () => {
    const bad = makeDraftQuestion({ text: '' });
    expect(() => validateCanonicalSubset(bad, 0)).toThrow(/canonical QuestionSchema/);
  });

  it('validateCanonicalSubset throws on empty language', () => {
    const bad = makeDraftQuestion({ text: 'some text', language: '' });
    expect(() => validateCanonicalSubset(bad, 0)).toThrow(/canonical QuestionSchema/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: Provenance fields present in JSONB but not in canonical
// ---------------------------------------------------------------------------

describe('T15 AC2 — provenance fields in JSONB, absent from canonical subset', () => {
  it('every TemplateQuestionRecord has provenance fields', () => {
    const brief = makeBrief();
    const payload = buildQuestionsPayload(ALL_QUESTIONS, brief, 20, 'url', ['tl']);

    for (const record of payload) {
      // Provenance fields MUST be present in JSONB
      expect(record).toHaveProperty('intentType');
      expect(record).toHaveProperty('phrasingGroupId');
      expect(record).toHaveProperty('source');
      expect(record).toHaveProperty('briefSnapshot');
      expect(record).toHaveProperty('generatedTotal');
      expect(record).toHaveProperty('needsNativeReview');
    }
  });

  it('canonical QuestionSchema does NOT include provenance fields', () => {
    // QuestionSchema must NOT validate records with extra provenance fields
    // by strict parsing — but since it uses .object() (non-strict), we verify
    // the fields are truly EXTRA (not in QuestionSchema's shape).
    const record: TemplateQuestionRecord = {
      text: 'test question',
      language: 'en',
      funnel_stage: 'awareness',
      density_tier: 'secondary',
      intentType: 'category',
      phrasingGroupId: 'pg-test',
      source: 'url',
      briefSnapshot: { brandName: 'EMORA', category: 'AI app', industryKey: 'ai-companion' },
      generatedTotal: 100,
      needsNativeReview: false,
    };

    // The canonical subset does parse successfully
    const canonical = {
      text: record.text,
      language: record.language,
      funnel_stage: record.funnel_stage,
      density_tier: record.density_tier,
    };
    expect(QuestionSchema.safeParse(canonical).success).toBe(true);

    // The provenance fields are clearly NOT in QuestionSchema's inferred type
    // (structural proof: QuestionSchema has no intentType/phrasingGroupId)
    const schemaKeys = Object.keys(QuestionSchema.shape);
    expect(schemaKeys).not.toContain('intentType');
    expect(schemaKeys).not.toContain('phrasingGroupId');
    expect(schemaKeys).not.toContain('source');
    expect(schemaKeys).not.toContain('briefSnapshot');
    expect(schemaKeys).not.toContain('generatedTotal');
    expect(schemaKeys).not.toContain('needsNativeReview');
  });

  it('TemplateQuestionRecordSchema validates the full JSONB record', () => {
    const brief = makeBrief();
    const payload = buildQuestionsPayload(QUESTIONS_EN, brief, 30, 'industry', []);

    for (const record of payload) {
      const result = TemplateQuestionRecordSchema.safeParse(record);
      expect(result.success, `TemplateQuestionRecordSchema failed: ${!result.success ? result.error.message : ''}`).toBe(true);
    }
  });

  it('briefSnapshot contains brandName, category, industryKey from the brief', () => {
    const brief = makeBrief({ brandName: 'EMORA', category: 'AI app', industryKey: 'ai-companion' });
    const payload = buildQuestionsPayload(QUESTIONS_EN, brief, 10, 'url', []);

    for (const record of payload) {
      expect(record.briefSnapshot.brandName).toBe('EMORA');
      expect(record.briefSnapshot.category).toBe('AI app');
      expect(record.briefSnapshot.industryKey).toBe('ai-companion');
    }
  });

  it('briefSnapshot includes positioning when present in brief', () => {
    const brief = makeBrief({ positioning: 'Emotional memory platform' });
    const payload = buildQuestionsPayload(QUESTIONS_EN, brief, 10, 'url', []);
    expect(payload[0]!.briefSnapshot.positioning).toBe('Emotional memory platform');
  });

  it('briefSnapshot omits positioning key when absent from brief', () => {
    const brief = makeBrief();
    delete (brief as Partial<BrandBrief>).positioning;
    const payload = buildQuestionsPayload(QUESTIONS_EN, brief, 10, 'url', []);
    expect(payload[0]!.briefSnapshot).not.toHaveProperty('positioning');
  });

  it('source field reflects the input source param', () => {
    const brief = makeBrief();
    const urlPayload = buildQuestionsPayload(QUESTIONS_EN, brief, 10, 'url', []);
    const industryPayload = buildQuestionsPayload(QUESTIONS_EN, brief, 10, 'industry', []);

    expect(urlPayload.every((r) => r.source === 'url')).toBe(true);
    expect(industryPayload.every((r) => r.source === 'industry')).toBe(true);
  });

  it('generatedTotal matches the input value', () => {
    const brief = makeBrief();
    const payload = buildQuestionsPayload(QUESTIONS_EN, brief, 42, 'url', []);
    expect(payload.every((r) => r.generatedTotal === 42)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3: status='draft', never reviewed/active
// ---------------------------------------------------------------------------

describe('T15 AC3 — status is always draft', () => {
  it('assembleTemplate inserts with status=draft', async () => {
    const { repo, insertedStatus } = makeStubRepo();
    const brief = makeBrief();

    await assembleTemplate({
      questions: QUESTIONS_EN,
      seedCompetitors: SEED_COMPETITORS,
      brief,
      generatedTotal: 30,
      source: 'url',
      _repo: repo,
    });

    expect(insertedStatus()).toBe('draft');
  });

  it('assembleTemplate always inserts draft even when source is industry', async () => {
    const { repo, insertedStatus } = makeStubRepo();
    const brief = makeBrief();

    await assembleTemplate({
      questions: QUESTIONS_EN,
      seedCompetitors: [],
      brief,
      generatedTotal: 10,
      source: 'industry',
      _repo: repo,
    });

    expect(insertedStatus()).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 4: Validation throws before DB write on bad questions
// ---------------------------------------------------------------------------

describe('T15 AC4 — pre-insert validation throws on bad questions', () => {
  it('throws before DB write when a question has empty text', async () => {
    const { repo } = makeStubRepo();
    const insertSpy = vi.spyOn(repo, 'insertIndustryTemplate');

    const badQuestion = makeDraftQuestion({ text: '' });
    const brief = makeBrief();

    await expect(
      assembleTemplate({
        questions: [badQuestion],
        seedCompetitors: [],
        brief,
        generatedTotal: 1,
        source: 'url',
        _repo: repo,
      }),
    ).rejects.toThrow(/canonical QuestionSchema/);

    // DB must NOT have been called
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('throws before DB write when a question has invalid density_tier', async () => {
    const { repo } = makeStubRepo();
    const insertSpy = vi.spyOn(repo, 'insertIndustryTemplate');

    const badQuestion = makeDraftQuestion({
      text: 'valid text',
      density_tier: 'ultra' as 'core',
    });
    const brief = makeBrief();

    await expect(
      assembleTemplate({
        questions: [badQuestion],
        seedCompetitors: [],
        brief,
        generatedTotal: 1,
        source: 'url',
        _repo: repo,
      }),
    ).rejects.toThrow(/canonical QuestionSchema/);

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('throws on the first invalid question (index is reported)', async () => {
    const { repo } = makeStubRepo();

    const questions = [
      makeDraftQuestion({ text: 'valid question one', phrasingGroupId: 'pg-001' }),
      makeDraftQuestion({ text: '', phrasingGroupId: 'pg-002' }), // index 1
      makeDraftQuestion({ text: 'valid question three', phrasingGroupId: 'pg-003' }),
    ];

    await expect(
      assembleTemplate({
        questions,
        seedCompetitors: [],
        brief: makeBrief(),
        generatedTotal: 3,
        source: 'url',
        _repo: repo,
      }),
    ).rejects.toThrow(/Question\[1\]/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 5: Competitor validation
// ---------------------------------------------------------------------------

describe('T15 AC5 — competitor validation', () => {
  it('validateCompetitor accepts valid competitor', () => {
    expect(() => validateCompetitor({ name: 'Replika', aliases: [] }, 0)).not.toThrow();
  });

  it('validateCompetitor throws on empty name', () => {
    expect(() => validateCompetitor({ name: '', aliases: [] }, 0)).toThrow(/CompetitorSchema/);
  });

  it('assembleTemplate throws before DB write on invalid competitor', async () => {
    const { repo } = makeStubRepo();
    const insertSpy = vi.spyOn(repo, 'insertIndustryTemplate');

    await expect(
      assembleTemplate({
        questions: QUESTIONS_EN,
        seedCompetitors: [{ name: '', aliases: [] }],
        brief: makeBrief(),
        generatedTotal: 5,
        source: 'url',
        _repo: repo,
      }),
    ).rejects.toThrow(/CompetitorSchema/);

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('buildCompetitorsPayload maps competitors correctly', () => {
    const payload = buildCompetitorsPayload(SEED_COMPETITORS);
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({ name: 'Replika', aliases: ['Replika AI', 'レプリカ'] });
    expect(payload[1]).toMatchObject({ name: 'Character.AI', aliases: [] });
  });

  it('TemplateCompetitorRecordSchema validates competitor records', () => {
    const payload = buildCompetitorsPayload(SEED_COMPETITORS);
    for (const c of payload) {
      expect(TemplateCompetitorRecordSchema.safeParse(c).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 6: needsNativeReview for low-resource languages
// ---------------------------------------------------------------------------

describe('T15 AC6 — needsNativeReview for low-resource languages', () => {
  it('sets needsNativeReview=true for configured low-resource languages', () => {
    const brief = makeBrief();
    const payload = buildQuestionsPayload(
      [...QUESTIONS_EN, ...QUESTIONS_TL],
      brief,
      20,
      'url',
      ['tl', 'vi', 'th'],
    );

    const enRecords = payload.filter((r) => r.language === 'en');
    const tlRecords = payload.filter((r) => r.language === 'tl');

    expect(enRecords.every((r) => r.needsNativeReview === false)).toBe(true);
    expect(tlRecords.every((r) => r.needsNativeReview === true)).toBe(true);
  });

  it('sets needsNativeReview=false when low-resource list is empty', () => {
    const brief = makeBrief();
    const payload = buildQuestionsPayload(QUESTIONS_TL, brief, 5, 'url', []);
    expect(payload.every((r) => r.needsNativeReview === false)).toBe(true);
  });

  it('is case-insensitive for language code comparison', () => {
    const brief = makeBrief();
    const questions = [makeDraftQuestion({ text: 'Tagalog question', language: 'TL' })];
    const payload = buildQuestionsPayload(questions, brief, 5, 'url', ['tl']);
    expect(payload[0]!.needsNativeReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 7: Advisory columns set
// ---------------------------------------------------------------------------

describe('T15 AC7 — advisory columns', () => {
  it('sets generated_total in advisory cols', async () => {
    const { repo, advisoryCols } = makeStubRepo();
    await assembleTemplate({
      questions: QUESTIONS_EN,
      seedCompetitors: [],
      brief: makeBrief(),
      generatedTotal: 99,
      source: 'url',
      _repo: repo,
    });
    expect(advisoryCols()?.generated_total).toBe(99);
  });

  it('sets source_url when provided', async () => {
    const { repo, advisoryCols } = makeStubRepo();
    await assembleTemplate({
      questions: QUESTIONS_EN,
      seedCompetitors: [],
      brief: makeBrief(),
      generatedTotal: 10,
      source: 'url',
      sourceUrl: 'https://emora.app',
      _repo: repo,
    });
    expect(advisoryCols()?.source_url).toBe('https://emora.app');
  });

  it('sets customer_slug when provided', async () => {
    const { repo, advisoryCols } = makeStubRepo();
    await assembleTemplate({
      questions: QUESTIONS_EN,
      seedCompetitors: [],
      brief: makeBrief(),
      generatedTotal: 10,
      source: 'url',
      customerSlug: 'emora',
      _repo: repo,
    });
    expect(advisoryCols()?.customer_slug).toBe('emora');
  });

  it('does not set source_url when not provided', async () => {
    const { repo, advisoryCols } = makeStubRepo();
    await assembleTemplate({
      questions: QUESTIONS_EN,
      seedCompetitors: [],
      brief: makeBrief(),
      generatedTotal: 10,
      source: 'industry',
      _repo: repo,
    });
    expect(advisoryCols()?.source_url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full assembleTemplate result shape
// ---------------------------------------------------------------------------

describe('T15 — assembleTemplate result shape', () => {
  it('returns templateId, questionsPayload, competitorsPayload, questionCount', async () => {
    const { repo } = makeStubRepo('mock-template-id');
    const brief = makeBrief();

    const result = await assembleTemplate({
      questions: ALL_QUESTIONS,
      seedCompetitors: SEED_COMPETITORS,
      brief,
      generatedTotal: 50,
      source: 'url',
      sourceUrl: 'https://emora.app',
      customerSlug: 'emora',
      _repo: repo,
    });

    expect(result.templateId).toBe('mock-template-id');
    expect(result.questionCount).toBe(ALL_QUESTIONS.length);
    expect(result.questionsPayload).toHaveLength(ALL_QUESTIONS.length);
    expect(result.competitorsPayload).toHaveLength(SEED_COMPETITORS.length);
  });

  it('all returned questionsPayload entries pass TemplateQuestionRecordSchema', async () => {
    const { repo } = makeStubRepo();
    const brief = makeBrief();

    const result = await assembleTemplate({
      questions: ALL_QUESTIONS,
      seedCompetitors: SEED_COMPETITORS,
      brief,
      generatedTotal: 50,
      source: 'url',
      _repo: repo,
    });

    for (const record of result.questionsPayload) {
      const parsed = TemplateQuestionRecordSchema.safeParse(record);
      expect(parsed.success, `Record failed: ${!parsed.success ? parsed.error.message : ''}`).toBe(true);
    }
  });

  it('all canonical subsets in questionsPayload pass QuestionSchema', async () => {
    const { repo } = makeStubRepo();
    const brief = makeBrief();

    const result = await assembleTemplate({
      questions: ALL_QUESTIONS,
      seedCompetitors: SEED_COMPETITORS,
      brief,
      generatedTotal: 50,
      source: 'url',
      _repo: repo,
    });

    for (const record of result.questionsPayload) {
      const canonical = {
        text: record.text,
        language: record.language,
        funnel_stage: record.funnel_stage,
        density_tier: record.density_tier,
      };
      expect(QuestionSchema.safeParse(canonical).success).toBe(true);
    }
  });

  it('handles empty questions array without error', async () => {
    const { repo } = makeStubRepo();
    const brief = makeBrief();

    const result = await assembleTemplate({
      questions: [],
      seedCompetitors: [],
      brief,
      generatedTotal: 0,
      source: 'industry',
      _repo: repo,
    });

    expect(result.questionCount).toBe(0);
    expect(result.questionsPayload).toHaveLength(0);
    expect(result.competitorsPayload).toHaveLength(0);
  });

  it('multilingual questions retain their language codes', async () => {
    const { repo } = makeStubRepo();
    const brief = makeBrief();

    const result = await assembleTemplate({
      questions: ALL_QUESTIONS,
      seedCompetitors: [],
      brief,
      generatedTotal: ALL_QUESTIONS.length,
      source: 'url',
      _repo: repo,
    });

    const langs = result.questionsPayload.map((r) => r.language);
    expect(langs).toContain('en');
    expect(langs).toContain('ja');
    expect(langs).toContain('tl');
  });
});

// ---------------------------------------------------------------------------
// buildBriefSnapshot
// ---------------------------------------------------------------------------

describe('buildBriefSnapshot', () => {
  it('builds snapshot with all required fields', () => {
    const brief = makeBrief();
    const snapshot = buildBriefSnapshot(brief);
    expect(snapshot.brandName).toBe('EMORA');
    expect(snapshot.category).toBe('AI companion app');
    expect(snapshot.industryKey).toBe('ai-companion');
  });

  it('includes positioning when present', () => {
    const brief = makeBrief({ positioning: 'Emotional memory platform' });
    const snapshot = buildBriefSnapshot(brief);
    expect(snapshot.positioning).toBe('Emotional memory platform');
  });

  it('omits positioning when not present', () => {
    const brief = makeBrief();
    delete (brief as Partial<BrandBrief>).positioning;
    const snapshot = buildBriefSnapshot(brief);
    expect(Object.keys(snapshot)).not.toContain('positioning');
  });
});

// ---------------------------------------------------------------------------
// TLI-02 — version collision fix: nextTemplateVersion called, version forwarded
// ---------------------------------------------------------------------------

describe('TLI-02 — version collision prevention', () => {
  it('calls nextTemplateVersion exactly once before insert', async () => {
    const { repo, versionCallCount } = makeStubRepo('ver-test-001', 1);
    const brief = makeBrief();

    await assembleTemplate({
      questions: QUESTIONS_EN,
      seedCompetitors: SEED_COMPETITORS,
      brief,
      generatedTotal: 10,
      source: 'url',
      _repo: repo,
    });

    expect(versionCallCount()).toBe(1);
  });

  it('passes the version returned by nextTemplateVersion to insertIndustryTemplate', async () => {
    const { repo, insertedVersion } = makeStubRepo('ver-test-002', 3);
    const brief = makeBrief();

    await assembleTemplate({
      questions: QUESTIONS_EN,
      seedCompetitors: SEED_COMPETITORS,
      brief,
      generatedTotal: 10,
      source: 'url',
      _repo: repo,
    });

    expect(insertedVersion()).toBe(3);
  });

  it('second template for same industry uses version 2 (no collision)', async () => {
    // Simulate a second template: nextTemplateVersion returns 2
    const { repo, insertedVersion } = makeStubRepo('ver-test-003', 2);
    const brief = makeBrief();

    await assembleTemplate({
      questions: QUESTIONS_EN,
      seedCompetitors: SEED_COMPETITORS,
      brief,
      generatedTotal: 10,
      source: 'url',
      _repo: repo,
    });

    expect(insertedVersion()).toBe(2);
  });
});
