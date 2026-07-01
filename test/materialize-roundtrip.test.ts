/**
 * test/materialize-roundtrip.test.ts
 *
 * T16 acceptance tests: materialize-roundtrip
 *
 * Verifies the materialize() function:
 *   AC1 — Refuses non-active templates (MaterializeStatusError).
 *   AC2 — Emits exactly one YAML; DB rows produced by loadTemplate (no double-write).
 *   AC3 — Resulting questions readable by findActiveQuestions with correct tiers/langs.
 *   AC4 — Re-running is idempotent.
 *   AC5 — Full round-trip: industry_template JSON → YAML → loadTemplate → question rows.
 *
 * All tests use injected ports (_fs, _loadTemplate) so no real FS / DB is touched.
 * The YAML content is captured in memory; loadTemplate is stubbed to parse and
 * validate it in-process (using the real CustomerTemplateSchema + js-yaml).
 */

import { describe, it, expect, vi } from 'vitest';
import { load as yamlLoad } from 'js-yaml';
import {
  materialize,
  parseJsonbQuestions,
  parseJsonbCompetitors,
  buildCustomerTemplate,
  serializeTemplateToYaml,
  deriveLanguagesFromParsedQuestions,
  MaterializeStatusError,
  MaterializePayloadError,
  type IndustryTemplateRow,
  type MaterializeContext,
  type FsPort,
  type LoadTemplatePort,
} from '../src/generate/materialize.js';
import { parseCustomerTemplate } from '../src/config/template.schema.js';
import type { CustomerTemplate } from '../src/config/template.schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal ACTIVE industry_template row with provenance-rich questions. */
function makeActiveRow(
  overrides: Partial<IndustryTemplateRow> = {},
): IndustryTemplateRow {
  return {
    id: 'template-uuid-001',
    industry: 'ai-companion',
    version: 1,
    status: 'active',
    questions: [
      {
        text: 'best Character AI alternative',
        language: 'en',
        funnel_stage: 'decision',
        density_tier: 'core',
        // provenance (should be ignored)
        intentType: 'alternative',
        phrasingGroupId: 'pg-en-001',
        source: 'url',
        briefSnapshot: { brandName: 'EMORA', category: 'AI companion app', industryKey: 'ai-companion' },
        generatedTotal: 120,
        needsNativeReview: false,
      },
      {
        text: 'AI companion app for roleplay',
        language: 'en',
        funnel_stage: 'consideration',
        density_tier: 'secondary',
        intentType: 'useCase',
        phrasingGroupId: 'pg-en-002',
        source: 'url',
        briefSnapshot: { brandName: 'EMORA', category: 'AI companion app', industryKey: 'ai-companion' },
        generatedTotal: 120,
        needsNativeReview: false,
      },
      {
        text: 'おすすめのAIキャラクターチャットアプリ',
        language: 'ja',
        funnel_stage: 'decision',
        density_tier: 'core',
        intentType: 'alternative',
        phrasingGroupId: 'pg-ja-001',
        source: 'url',
        briefSnapshot: { brandName: 'EMORA', category: 'AI companion app', industryKey: 'ai-companion' },
        generatedTotal: 120,
        needsNativeReview: false,
      },
      {
        text: 'AI 캐릭터 채팅 앱 추천',
        language: 'ko',
        funnel_stage: 'decision',
        density_tier: 'core',
        intentType: 'alternative',
        phrasingGroupId: 'pg-ko-001',
        source: 'url',
        briefSnapshot: { brandName: 'EMORA', category: 'AI companion app', industryKey: 'ai-companion' },
        generatedTotal: 120,
        needsNativeReview: false,
      },
      {
        text: 'multilingual AI character chat app',
        language: 'en',
        funnel_stage: 'awareness',
        density_tier: 'longtail',
        intentType: 'category',
        phrasingGroupId: 'pg-en-003',
        source: 'url',
        briefSnapshot: { brandName: 'EMORA', category: 'AI companion app', industryKey: 'ai-companion' },
        generatedTotal: 120,
        needsNativeReview: false,
      },
    ],
    competitors: [
      { name: 'Character.AI', aliases: ['character.ai', 'c.ai'] },
      { name: 'Replika', aliases: ['Replika AI', 'レプリカ'] },
    ],
    reviewed_by: 'reviewer@example.com',
    reviewed_at: new Date('2026-06-20T10:00:00Z'),
    created_at: new Date('2026-06-19T10:00:00Z'),
    source_url: 'https://emora.app',
    customer_slug: 'emora',
    generated_total: 150,
    ...overrides,
  };
}

/** Minimal MaterializeContext for EMORA. */
function makeCtx(overrides: Partial<MaterializeContext> = {}): MaterializeContext {
  return {
    slug: 'emora',
    brandName: 'EMORA',
    brandAliases: ['Emora', 'エモーラ', '에모라'],
    languages: [
      { code: 'en', weight: 10.0 },
      { code: 'ja', weight: 9.0 },
      { code: 'ko', weight: 8.0 },
    ],
    budget: {
      max_models: 1,
      max_samples: 5,
      max_languages: 14,
      weekly_usd_cap: 10.0,
      monthly_usd_cap: 35.0,
    },
    outputDir: '/tmp/test-customers',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Port stubs
// ---------------------------------------------------------------------------

/**
 * Build an in-memory FS stub that captures the written YAML content.
 */
function makeFsStub(): {
  port: FsPort;
  writtenPaths: () => string[];
  writtenContent: (path: string) => string | undefined;
} {
  const written = new Map<string, string>();

  const port: FsPort = {
    writeFile(path: string, content: string): void {
      written.set(path, content);
    },
    mkdirRecursive(_dir: string): void {
      // no-op in tests
    },
  };

  return {
    port,
    writtenPaths: () => [...written.keys()],
    writtenContent: (path: string) => written.get(path),
  };
}

/**
 * Build a loadTemplate stub that:
 *   (a) Reads the YAML content from the FS stub's captured output (by path).
 *   (b) Parses + validates it against CustomerTemplateSchema (real validation).
 *   (c) Does NOT touch any DB (no kysely/pg imported).
 *   (d) Returns the validated CustomerTemplate.
 *
 * This proves the "YAML → loadTemplate → question rows" round-trip without
 * needing a real database, while still exercising real schema validation.
 */
function makeLoadTemplateStub(
  fsStub: ReturnType<typeof makeFsStub>,
): {
  port: LoadTemplatePort;
  callCount: () => number;
  lastLoadedPath: () => string | undefined;
} {
  let callCount = 0;
  let lastPath: string | undefined;

  const port: LoadTemplatePort = {
    async loadTemplate(filePath: string): Promise<CustomerTemplate> {
      callCount++;
      lastPath = filePath;
      // Read from the in-memory FS stub
      const content = fsStub.writtenContent(filePath);
      if (content === undefined) {
        throw new Error(`loadTemplate stub: no YAML written to path "${filePath}"`);
      }
      // Parse YAML + validate (real schema — no DB)
      const parsed = yamlLoad(content);
      return parseCustomerTemplate(parsed);
    },
  };

  return {
    port,
    callCount: () => callCount,
    lastLoadedPath: () => lastPath,
  };
}

// ---------------------------------------------------------------------------
// AC1 — Refuses non-active templates (MaterializeStatusError)
// ---------------------------------------------------------------------------

describe('T16 AC1 — refuses non-active templates', () => {
  it('throws MaterializeStatusError for status=draft', async () => {
    const row = makeActiveRow({ status: 'draft' });
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    await expect(
      materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port }),
    ).rejects.toThrow(MaterializeStatusError);
  });

  it('throws MaterializeStatusError for status=reviewed', async () => {
    const row = makeActiveRow({ status: 'reviewed' });
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    await expect(
      materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port }),
    ).rejects.toThrow(MaterializeStatusError);
  });

  it('MaterializeStatusError includes the template id and actual status', async () => {
    const row = makeActiveRow({ id: 'bad-uuid', status: 'draft' });
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    let err: MaterializeStatusError | undefined;
    try {
      await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });
    } catch (e: unknown) {
      if (e instanceof MaterializeStatusError) err = e;
    }

    expect(err).toBeDefined();
    expect(err!.templateId).toBe('bad-uuid');
    expect(err!.actualStatus).toBe('draft');
    expect(err!.message).toContain("status='draft'");
  });

  it('does NOT throw for status=active', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    await expect(
      materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port }),
    ).resolves.toBeDefined();
  });

  it('emits no YAML file when the status gate throws', async () => {
    const row = makeActiveRow({ status: 'reviewed' });
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    try {
      await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });
    } catch { /* expected */ }

    expect(fs.writtenPaths()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Emits exactly one YAML; loadTemplate called exactly once
// ---------------------------------------------------------------------------

describe('T16 AC2 — emits exactly one YAML, loadTemplate called once', () => {
  it('writes exactly one YAML file', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    expect(fs.writtenPaths()).toHaveLength(1);
  });

  it('YAML path is config/customers/<slug>.yaml under outputDir', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx({ outputDir: '/tmp/test-output', slug: 'emora' });
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    // On any platform the resolved path will end with emora.yaml
    expect(result.yamlPath).toMatch(/emora\.yaml$/);
    expect(result.yamlPath).toMatch(/test-output/);
  });

  it('loadTemplate is called exactly once (no double-write)', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    expect(lt.callCount()).toBe(1);
  });

  it('loadTemplate receives the same path that was written', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx({ outputDir: '/tmp/emora-out', slug: 'emora' });
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    const writtenPath = fs.writtenPaths()[0]!;
    expect(lt.lastLoadedPath()).toBe(writtenPath);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Questions readable with correct tiers/langs
// ---------------------------------------------------------------------------

describe('T16 AC3 — question rows have correct tiers and languages', () => {
  it('all 5 fixture questions are in the materialized CustomerTemplate', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    expect(result.questionCount).toBe(5);
    expect(result.customerTemplate.questions).toHaveLength(5);
  });

  it('core-tier questions are marked core', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    const coreQs = result.customerTemplate.questions.filter(
      (q) => q.density_tier === 'core',
    );
    // 3 core questions in fixture: en-decision, ja-decision, ko-decision
    expect(coreQs).toHaveLength(3);
    expect(coreQs.every((q) => q.density_tier === 'core')).toBe(true);
  });

  it('secondary-tier questions are marked secondary', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    const secondaryQs = result.customerTemplate.questions.filter(
      (q) => q.density_tier === 'secondary',
    );
    expect(secondaryQs).toHaveLength(1);
    expect(secondaryQs[0]!.text).toBe('AI companion app for roleplay');
  });

  it('longtail-tier questions are marked longtail', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    const longtailQs = result.customerTemplate.questions.filter(
      (q) => q.density_tier === 'longtail',
    );
    expect(longtailQs).toHaveLength(1);
    expect(longtailQs[0]!.text).toBe('multilingual AI character chat app');
  });

  it('questions span multiple languages (en, ja, ko)', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    const langs = new Set(result.customerTemplate.questions.map((q) => q.language));
    expect(langs).toContain('en');
    expect(langs).toContain('ja');
    expect(langs).toContain('ko');
  });

  it('funnel_stage values are preserved', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    const decisionQs = result.customerTemplate.questions.filter(
      (q) => q.funnel_stage === 'decision',
    );
    const considerationQs = result.customerTemplate.questions.filter(
      (q) => q.funnel_stage === 'consideration',
    );
    const awarenessQs = result.customerTemplate.questions.filter(
      (q) => q.funnel_stage === 'awareness',
    );

    expect(decisionQs.length).toBeGreaterThanOrEqual(1);
    expect(considerationQs.length).toBeGreaterThanOrEqual(1);
    expect(awarenessQs.length).toBeGreaterThanOrEqual(1);
  });

  it('provenance fields (intentType, phrasingGroupId) are NOT present in questions', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    for (const q of result.customerTemplate.questions) {
      // The question table type does NOT have intentType or phrasingGroupId
      expect(q).not.toHaveProperty('intentType');
      expect(q).not.toHaveProperty('phrasingGroupId');
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — Re-running is idempotent
// ---------------------------------------------------------------------------

describe('T16 AC4 — idempotency', () => {
  it('calling materialize twice produces the same question count', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();

    // First run
    const fs1 = makeFsStub();
    const lt1 = makeLoadTemplateStub(fs1);
    const result1 = await materialize(row, ctx, { _fs: fs1.port, _loadTemplate: lt1.port });

    // Second run (same inputs)
    const fs2 = makeFsStub();
    const lt2 = makeLoadTemplateStub(fs2);
    const result2 = await materialize(row, ctx, { _fs: fs2.port, _loadTemplate: lt2.port });

    expect(result1.questionCount).toBe(result2.questionCount);
    expect(result1.competitorCount).toBe(result2.competitorCount);
  });

  it('calling materialize twice produces identical YAML content', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();

    const fs1 = makeFsStub();
    const lt1 = makeLoadTemplateStub(fs1);
    await materialize(row, ctx, { _fs: fs1.port, _loadTemplate: lt1.port });

    const fs2 = makeFsStub();
    const lt2 = makeLoadTemplateStub(fs2);
    await materialize(row, ctx, { _fs: fs2.port, _loadTemplate: lt2.port });

    const yaml1 = fs1.writtenContent(fs1.writtenPaths()[0]!);
    const yaml2 = fs2.writtenContent(fs2.writtenPaths()[0]!);

    expect(yaml1).toBe(yaml2);
  });

  it('second materialize does NOT create extra YAML files', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();

    const fs1 = makeFsStub();
    const lt1 = makeLoadTemplateStub(fs1);
    await materialize(row, ctx, { _fs: fs1.port, _loadTemplate: lt1.port });

    const fs2 = makeFsStub();
    const lt2 = makeLoadTemplateStub(fs2);
    await materialize(row, ctx, { _fs: fs2.port, _loadTemplate: lt2.port });

    expect(fs1.writtenPaths()).toHaveLength(1);
    expect(fs2.writtenPaths()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC5 — Full round-trip: JSONB → YAML → CustomerTemplateSchema parse
// ---------------------------------------------------------------------------

describe('T16 AC5 — full round-trip (JSONB → YAML → schema validation)', () => {
  it('the emitted YAML parses to a valid CustomerTemplate', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    // The returned customerTemplate was produced by parseCustomerTemplate()
    // (inside the loadTemplate stub), so it IS a valid CustomerTemplate.
    expect(result.customerTemplate.slug).toBe('emora');
    expect(result.customerTemplate.brand.name).toBe('EMORA');
    expect(result.customerTemplate.questions.length).toBeGreaterThan(0);
    expect(result.customerTemplate.competitors.length).toBeGreaterThan(0);
  });

  it('round-tripped questions all have valid density_tier values', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    const validTiers = new Set(['core', 'secondary', 'longtail']);
    for (const q of result.customerTemplate.questions) {
      expect(validTiers.has(q.density_tier)).toBe(true);
    }
  });

  it('round-tripped competitors have name and aliases', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    for (const comp of result.customerTemplate.competitors) {
      expect(typeof comp.name).toBe('string');
      expect(comp.name.length).toBeGreaterThan(0);
      expect(Array.isArray(comp.aliases)).toBe(true);
    }
  });

  it('brand aliases are preserved in round-trip', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    expect(result.customerTemplate.brand.aliases).toContain('Emora');
    expect(result.customerTemplate.brand.aliases).toContain('エモーラ');
    expect(result.customerTemplate.brand.aliases).toContain('에모라');
  });

  it('CJK question text survives YAML serialization and re-parse', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    const jaQuestion = result.customerTemplate.questions.find(
      (q) => q.language === 'ja',
    );
    expect(jaQuestion).toBeDefined();
    expect(jaQuestion!.text).toBe('おすすめのAIキャラクターチャットアプリ');

    const koQuestion = result.customerTemplate.questions.find(
      (q) => q.language === 'ko',
    );
    expect(koQuestion).toBeDefined();
    expect(koQuestion!.text).toBe('AI 캐릭터 채팅 앱 추천');
  });

  it('budget values are preserved in round-trip', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    expect(result.customerTemplate.budget.max_models).toBe(1);
    expect(result.customerTemplate.budget.max_samples).toBe(5);
    expect(result.customerTemplate.budget.weekly_usd_cap).toBe(10.0);
    expect(result.customerTemplate.budget.monthly_usd_cap).toBe(35.0);
  });

  it('language weights are preserved in round-trip', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    const enLang = result.customerTemplate.languages.find((l) => l.code === 'en');
    const jaLang = result.customerTemplate.languages.find((l) => l.code === 'ja');
    const koLang = result.customerTemplate.languages.find((l) => l.code === 'ko');

    expect(enLang?.weight).toBe(10.0);
    expect(jaLang?.weight).toBe(9.0);
    expect(koLang?.weight).toBe(8.0);
  });
});

// ---------------------------------------------------------------------------
// Helpers: parseJsonbQuestions / parseJsonbCompetitors (pure unit tests)
// ---------------------------------------------------------------------------

describe('parseJsonbQuestions', () => {
  it('extracts canonical 4 fields and discards provenance', () => {
    const raw = [
      {
        text: 'best AI app',
        language: 'en',
        funnel_stage: 'decision',
        density_tier: 'core',
        intentType: 'alternative',   // provenance — should be ignored
        phrasingGroupId: 'pg-001',   // provenance — should be ignored
      },
    ];

    const result = parseJsonbQuestions(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe('best AI app');
    expect(result[0]!.language).toBe('en');
    expect(result[0]!.funnel_stage).toBe('decision');
    expect(result[0]!.density_tier).toBe('core');
    // Provenance fields should not be in the returned canonical object
    expect(result[0]!).not.toHaveProperty('intentType');
    expect(result[0]!).not.toHaveProperty('phrasingGroupId');
  });

  it('throws MaterializePayloadError for non-array input', () => {
    expect(() => parseJsonbQuestions({ not: 'an array' })).toThrow(MaterializePayloadError);
    expect(() => parseJsonbQuestions(null)).toThrow(MaterializePayloadError);
    expect(() => parseJsonbQuestions('string')).toThrow(MaterializePayloadError);
  });

  it('throws MaterializePayloadError for invalid density_tier', () => {
    const raw = [
      {
        text: 'valid',
        language: 'en',
        funnel_stage: 'decision',
        density_tier: 'ultra', // invalid
      },
    ];
    expect(() => parseJsonbQuestions(raw)).toThrow(MaterializePayloadError);
  });

  it('throws MaterializePayloadError for empty question text', () => {
    const raw = [
      {
        text: '',
        language: 'en',
        funnel_stage: 'awareness',
        density_tier: 'secondary',
      },
    ];
    expect(() => parseJsonbQuestions(raw)).toThrow(MaterializePayloadError);
  });

  it('handles null funnel_stage gracefully', () => {
    const raw = [
      {
        text: 'some question',
        language: 'en',
        funnel_stage: null,
        density_tier: 'secondary',
      },
    ];
    const result = parseJsonbQuestions(raw);
    expect(result[0]!.funnel_stage).toBeNull();
  });

  it('handles missing funnel_stage gracefully', () => {
    const raw = [
      {
        text: 'some question',
        language: 'en',
        density_tier: 'longtail',
        // funnel_stage absent
      },
    ];
    const result = parseJsonbQuestions(raw);
    // funnel_stage is null (from ?? null coercion)
    expect(result[0]!.funnel_stage).toBeNull();
  });

  it('returns empty array for empty input', () => {
    expect(parseJsonbQuestions([])).toHaveLength(0);
  });
});

describe('parseJsonbCompetitors', () => {
  it('parses valid competitors correctly', () => {
    const raw = [
      { name: 'Character.AI', aliases: ['c.ai', 'character.ai'] },
      { name: 'Replika', aliases: [] },
    ];

    const result = parseJsonbCompetitors(raw);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('Character.AI');
    expect(result[0]!.aliases).toEqual(['c.ai', 'character.ai']);
    expect(result[1]!.name).toBe('Replika');
    expect(result[1]!.aliases).toEqual([]);
  });

  it('defaults missing aliases to empty array', () => {
    const raw = [{ name: 'Talkie' }]; // no aliases field
    const result = parseJsonbCompetitors(raw);
    expect(result[0]!.aliases).toEqual([]);
  });

  it('throws MaterializePayloadError for non-array', () => {
    expect(() => parseJsonbCompetitors(null)).toThrow(MaterializePayloadError);
    expect(() => parseJsonbCompetitors({})).toThrow(MaterializePayloadError);
  });

  it('throws MaterializePayloadError for empty competitor name', () => {
    const raw = [{ name: '', aliases: [] }];
    expect(() => parseJsonbCompetitors(raw)).toThrow(MaterializePayloadError);
  });

  it('returns empty array for empty input', () => {
    expect(parseJsonbCompetitors([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildCustomerTemplate (pure)
// ---------------------------------------------------------------------------

describe('buildCustomerTemplate', () => {
  it('uses context slug, brandName, brandAliases', () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const questions = parseJsonbQuestions(row.questions);
    const competitors = parseJsonbCompetitors(row.competitors);

    const template = buildCustomerTemplate(row, ctx, questions, competitors);

    expect(template.slug).toBe('emora');
    expect(template.brand.name).toBe('EMORA');
    expect(template.brand.aliases).toContain('エモーラ');
  });

  it('uses context languages', () => {
    const row = makeActiveRow();
    const ctx = makeCtx({
      languages: [
        { code: 'en', weight: 10.0 },
        { code: 'ja', weight: 9.0 },
      ],
    });
    const questions = parseJsonbQuestions(row.questions);
    const competitors = parseJsonbCompetitors(row.competitors);

    const template = buildCustomerTemplate(row, ctx, questions, competitors);

    expect(template.languages).toHaveLength(2);
    expect(template.languages.find((l) => l.code === 'en')?.weight).toBe(10.0);
  });

  it('derives languages from parsedQuestions when no languages in context (TLI-03 fix)', () => {
    const row = makeActiveRow();
    // Use a ctx with no languages and no budget so we can observe the
    // derived-language behaviour without the budget override masking it.
    const ctx: MaterializeContext = {
      slug: 'emora',
      brandName: 'EMORA',
      // languages intentionally omitted
      // budget intentionally omitted — max_languages should default to derived count
    };
    const questions = parseJsonbQuestions(row.questions);
    const competitors = parseJsonbCompetitors(row.competitors);

    const template = buildCustomerTemplate(row, ctx, questions, competitors);

    // The fixture has questions in en, ja, ko — all three must appear.
    // (Previously hard-coded to [{en,1.0}] which silently collapsed multilingual.)
    const codes = template.languages.map((l) => l.code);
    expect(codes).toContain('en');
    expect(codes).toContain('ja');
    expect(codes).toContain('ko');
    // When no explicit max_languages budget is given, it defaults to derived count
    expect(template.budget.max_languages).toBe(template.languages.length);
  });

  it('strips provenance fields from questions', () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const questions = parseJsonbQuestions(row.questions);
    const competitors = parseJsonbCompetitors(row.competitors);

    const template = buildCustomerTemplate(row, ctx, questions, competitors);

    for (const q of template.questions) {
      expect(q).not.toHaveProperty('intentType');
      expect(q).not.toHaveProperty('phrasingGroupId');
      expect(q).not.toHaveProperty('source');
      expect(q).not.toHaveProperty('briefSnapshot');
    }
  });
});

// ---------------------------------------------------------------------------
// serializeTemplateToYaml (pure)
// ---------------------------------------------------------------------------

describe('serializeTemplateToYaml', () => {
  it('produces valid YAML that round-trips through js-yaml', () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const questions = parseJsonbQuestions(row.questions);
    const competitors = parseJsonbCompetitors(row.competitors);
    const template = buildCustomerTemplate(row, ctx, questions, competitors);

    const yaml = serializeTemplateToYaml(template);
    const parsed = yamlLoad(yaml) as Record<string, unknown>;

    expect(parsed['slug']).toBe('emora');
    expect((parsed['brand'] as { name: string })['name']).toBe('EMORA');
  });

  it('handles CJK characters without escaping them beyond readability', () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const questions = parseJsonbQuestions(row.questions);
    const competitors = parseJsonbCompetitors(row.competitors);
    const template = buildCustomerTemplate(row, ctx, questions, competitors);

    const yaml = serializeTemplateToYaml(template);

    // After round-trip, CJK characters survive
    const parsed = yamlLoad(yaml);
    const parsed2 = parseCustomerTemplate(parsed);
    const jaQ = parsed2.questions.find((q) => q.language === 'ja');
    expect(jaQ?.text).toBe('おすすめのAIキャラクターチャットアプリ');
  });

  it('produces a string (not null/undefined)', () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const questions = parseJsonbQuestions(row.questions);
    const competitors = parseJsonbCompetitors(row.competitors);
    const template = buildCustomerTemplate(row, ctx, questions, competitors);

    const yaml = serializeTemplateToYaml(template);
    expect(typeof yaml).toBe('string');
    expect(yaml.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// MaterializeResult shape
// ---------------------------------------------------------------------------

describe('T16 — MaterializeResult shape', () => {
  it('returns all expected fields', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    expect(result).toHaveProperty('customerTemplate');
    expect(result).toHaveProperty('yamlPath');
    expect(result).toHaveProperty('questionCount');
    expect(result).toHaveProperty('competitorCount');
  });

  it('questionCount matches fixture question array length', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    // Fixture has 5 questions
    expect(result.questionCount).toBe(5);
  });

  it('competitorCount matches fixture competitors array length', async () => {
    const row = makeActiveRow();
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    const result = await materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port });

    // Fixture has 2 competitors
    expect(result.competitorCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TLI-03 — deriveLanguagesFromParsedQuestions (pure, exported for testing)
// ---------------------------------------------------------------------------

describe('TLI-03 — deriveLanguagesFromParsedQuestions', () => {
  it('returns distinct languages in insertion order', () => {
    const questions = [
      { language: 'en', text: 'q1', funnel_stage: null, density_tier: 'core' as const },
      { language: 'ja', text: 'q2', funnel_stage: null, density_tier: 'core' as const },
      { language: 'ko', text: 'q3', funnel_stage: null, density_tier: 'core' as const },
      { language: 'en', text: 'q4', funnel_stage: null, density_tier: 'secondary' as const }, // dup en
    ];

    const result = deriveLanguagesFromParsedQuestions(questions, []);

    expect(result.map((l) => l.code)).toEqual(['en', 'ja', 'ko']);
    expect(result).toHaveLength(3);
  });

  it('assigns weight 1.0 to all languages when no weight hints in rawJsonb', () => {
    const questions = [
      { language: 'en', text: 'q1', funnel_stage: null, density_tier: 'core' as const },
      { language: 'ja', text: 'q2', funnel_stage: null, density_tier: 'core' as const },
    ];

    const result = deriveLanguagesFromParsedQuestions(questions, []);

    expect(result.every((l) => l.weight === 1.0)).toBe(true);
  });

  it('picks up weight hints from briefSnapshot.detectedLanguages in rawJsonb', () => {
    const questions = [
      { language: 'en', text: 'q1', funnel_stage: null, density_tier: 'core' as const },
      { language: 'ja', text: 'q2', funnel_stage: null, density_tier: 'core' as const },
    ];

    const rawJsonb = [
      {
        text: 'q1',
        language: 'en',
        density_tier: 'core',
        briefSnapshot: {
          detectedLanguages: [
            { code: 'en', weight: 10.0, rationale: 'primary' },
            { code: 'ja', weight: 9.0, rationale: 'secondary' },
          ],
        },
      },
    ];

    const result = deriveLanguagesFromParsedQuestions(questions, rawJsonb);

    expect(result.find((l) => l.code === 'en')?.weight).toBe(10.0);
    expect(result.find((l) => l.code === 'ja')?.weight).toBe(9.0);
  });

  it('returns empty array for empty parsedQuestions', () => {
    expect(deriveLanguagesFromParsedQuestions([], [])).toEqual([]);
  });

  it('handles malformed rawJsonb gracefully', () => {
    const questions = [
      { language: 'en', text: 'q1', funnel_stage: null, density_tier: 'core' as const },
    ];

    // Various malformed inputs should not throw
    expect(() => deriveLanguagesFromParsedQuestions(questions, null)).not.toThrow();
    expect(() => deriveLanguagesFromParsedQuestions(questions, 'bad')).not.toThrow();
    expect(() => deriveLanguagesFromParsedQuestions(questions, [null, 42, { briefSnapshot: null }])).not.toThrow();

    // Should still return [en, 1.0] despite malformed rawJsonb
    const result = deriveLanguagesFromParsedQuestions(questions, null);
    expect(result).toHaveLength(1);
    expect(result[0]!.code).toBe('en');
    expect(result[0]!.weight).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// TLI-03 — CustomerTemplateSchema superRefine: language declared in languages
// ---------------------------------------------------------------------------

describe('TLI-03 — CustomerTemplateSchema language-declared guard (superRefine)', () => {
  it('rejects a question whose language is not in the languages array', async () => {
    const row = makeActiveRow({
      questions: [
        {
          text: 'best AI companion app',
          language: 'fr', // declared in neither ctx.languages nor fixture languages
          funnel_stage: 'decision',
          density_tier: 'core',
        },
      ],
    });
    // ctx only declares en/ja/ko
    const ctx = makeCtx();
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    // materialize() calls loadTemplate() which calls parseCustomerTemplate()
    // with the emitted YAML — superRefine should throw a ZodError here.
    await expect(
      materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port }),
    ).rejects.toThrow(/fr.*not declared|not declared.*fr/i);
  });

  it('accepts all question languages when they are all declared', async () => {
    const row = makeActiveRow(); // en/ja/ko questions
    const ctx = makeCtx(); // declares en/ja/ko
    const fs = makeFsStub();
    const lt = makeLoadTemplateStub(fs);

    await expect(
      materialize(row, ctx, { _fs: fs.port, _loadTemplate: lt.port }),
    ).resolves.toBeDefined();
  });
});
