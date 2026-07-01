/**
 * test/templateLifecycle.test.ts
 *
 * T19 — Unit tests for the review-template lifecycle:
 *   - draft -> reviewed (actionReviewed)
 *   - reviewed -> active (actionActive) — partial-unique-safe atomic txn + materialize
 *   - active-from-draft refused (structural §5.5 gate)
 *   - edit creates a NEW draft version without touching the source row
 *   - JSONB payload validation on each transition
 *
 * All tests use stub repos + materialize ports — no pg/kysely needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  actionReviewed,
  actionActive,
  actionEdit,
  validateQuestionsPayload,
  validateCompetitorsPayload,
  InvalidStatusTransitionError,
  PayloadValidationError,
  type ReviewRepo,
  type MaterializePort,
  type TemplateRow,
  type MaterializeCtx,
} from '../src/cli/reviewTemplate.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_QUESTIONS = [
  {
    text: 'Which AI companion app has the best emotional memory?',
    language: 'en',
    funnel_stage: 'consideration',
    density_tier: 'core',
    intentType: 'category',
    phrasingGroupId: 'pg-001',
    source: 'url',
    briefSnapshot: { brandName: 'EMORA', category: 'AI companion app', industryKey: 'ai-companion' },
    generatedTotal: 120,
    needsNativeReview: false,
  },
  {
    text: 'AIコンパニオンアプリはどれが一番良いですか？',
    language: 'ja',
    funnel_stage: 'consideration',
    density_tier: 'secondary',
    intentType: 'category',
    phrasingGroupId: 'pg-002',
    source: 'url',
    briefSnapshot: { brandName: 'EMORA', category: 'AI companion app', industryKey: 'ai-companion' },
    generatedTotal: 120,
    needsNativeReview: false,
  },
];

const VALID_COMPETITORS = [
  { name: 'Replika', aliases: ['レプリカ'] },
  { name: 'Character.AI', aliases: ['Character AI'] },
];

function makeDraftRow(overrides?: Partial<TemplateRow>): TemplateRow {
  return {
    id: 'template-uuid-001',
    industry: 'ai-companion',
    version: 1,
    status: 'draft',
    questions: VALID_QUESTIONS,
    competitors: VALID_COMPETITORS,
    reviewed_by: null,
    reviewed_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_url: 'https://emora.app',
    customer_slug: 'emora',
    generated_total: 120,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub repo factory
// ---------------------------------------------------------------------------

interface StubRepoState {
  rows: Map<string, TemplateRow>;
  transactionCalls: number;
  demoteCalls: string[];
}

function makeStubRepo(initialRows: TemplateRow[] = []): ReviewRepo & { state: StubRepoState } {
  const state: StubRepoState = {
    rows: new Map(initialRows.map((r) => [r.id, { ...r }])),
    transactionCalls: 0,
    demoteCalls: [],
  };

  let nextVersion = initialRows.length + 1;

  const repo: ReviewRepo & { state: StubRepoState } = {
    state,

    async getIndustryTemplate(id) {
      return state.rows.get(id) ?? null;
    },

    async updateTemplateStatus(id, status, reviewedBy) {
      const row = state.rows.get(id);
      if (!row) throw new Error(`Stub: row not found: ${id}`);
      row.status = status;
      if (status === 'reviewed' || status === 'active') {
        row.reviewed_by = reviewedBy ?? null;
        row.reviewed_at = new Date();
      } else {
        row.reviewed_by = null;
        row.reviewed_at = null;
      }
    },

    async demoteActiveTemplate(industry) {
      state.demoteCalls.push(industry);
      for (const row of state.rows.values()) {
        if (row.industry === industry && row.status === 'active') {
          row.status = 'reviewed';
        }
      }
    },

    async nextTemplateVersion(industry) {
      let max = 0;
      for (const row of state.rows.values()) {
        if (row.industry === industry && row.version > max) {
          max = row.version;
        }
      }
      return max + 1;
    },

    async insertIndustryTemplate(t) {
      const id = `new-template-${++nextVersion}`;
      const row: TemplateRow = {
        id,
        industry: t.industry,
        version: t.version ?? 1,
        status: t.status ?? 'draft',
        questions: t.questions,
        competitors: t.competitors,
        reviewed_by: null,
        reviewed_at: null,
        created_at: new Date(),
      };
      state.rows.set(id, row);
      return { id };
    },

    async withTransaction(fn) {
      state.transactionCalls++;
      // Simulate a transaction: pass self as the txRepo so that demote+activate
      // are recorded against this stub (mirrors the production pattern where the
      // txRepo is bound to the Kysely transaction connection — TLI-01 fix).
      await fn(repo);
    },
  };

  return repo;
}

// ---------------------------------------------------------------------------
// Stub materialize port
// ---------------------------------------------------------------------------

function makeStubMaterializePort(
  result?: Partial<{ yamlPath: string; questionCount: number; competitorCount: number }>,
): MaterializePort & { calls: Array<{ row: TemplateRow; ctx: MaterializeCtx }> } {
  const calls: Array<{ row: TemplateRow; ctx: MaterializeCtx }> = [];
  return {
    calls,
    async materialize(row, ctx) {
      calls.push({ row, ctx });
      return {
        yamlPath: result?.yamlPath ?? `/tmp/customers/${ctx.slug}.yaml`,
        questionCount: result?.questionCount ?? VALID_QUESTIONS.length,
        competitorCount: result?.competitorCount ?? VALID_COMPETITORS.length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: validateQuestionsPayload
// ---------------------------------------------------------------------------

describe('validateQuestionsPayload', () => {
  it('accepts valid questions array', () => {
    expect(() => validateQuestionsPayload(VALID_QUESTIONS)).not.toThrow();
  });

  it('rejects non-array input', () => {
    expect(() => validateQuestionsPayload('not-an-array')).toThrow(PayloadValidationError);
    expect(() => validateQuestionsPayload(null)).toThrow(PayloadValidationError);
  });

  it('rejects a question missing density_tier', () => {
    const bad = [{ text: 'hello?', language: 'en', funnel_stage: null }];
    expect(() => validateQuestionsPayload(bad)).toThrow(PayloadValidationError);
  });

  it('rejects a question with invalid density_tier', () => {
    const bad = [{ text: 'hello?', language: 'en', funnel_stage: null, density_tier: 'invalid' }];
    expect(() => validateQuestionsPayload(bad)).toThrow(PayloadValidationError);
  });

  it('rejects a question with empty text', () => {
    const bad = [{ text: '', language: 'en', funnel_stage: null, density_tier: 'core' }];
    expect(() => validateQuestionsPayload(bad)).toThrow(PayloadValidationError);
  });

  it('accepts questions with valid density tiers', () => {
    const qs = [
      { text: 'q1?', language: 'en', density_tier: 'core' },
      { text: 'q2?', language: 'ja', density_tier: 'secondary' },
      { text: 'q3?', language: 'ko', density_tier: 'longtail' },
    ];
    expect(() => validateQuestionsPayload(qs)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: validateCompetitorsPayload
// ---------------------------------------------------------------------------

describe('validateCompetitorsPayload', () => {
  it('accepts valid competitors', () => {
    expect(() => validateCompetitorsPayload(VALID_COMPETITORS)).not.toThrow();
  });

  it('accepts empty array', () => {
    expect(() => validateCompetitorsPayload([])).not.toThrow();
  });

  it('rejects non-array input', () => {
    expect(() => validateCompetitorsPayload({ name: 'foo' })).toThrow(PayloadValidationError);
  });

  it('rejects a competitor with empty name', () => {
    const bad = [{ name: '', aliases: [] }];
    expect(() => validateCompetitorsPayload(bad)).toThrow(PayloadValidationError);
  });
});

// ---------------------------------------------------------------------------
// Tests: actionReviewed
// ---------------------------------------------------------------------------

describe('actionReviewed', () => {
  it('transitions draft -> reviewed, stamps reviewer', async () => {
    const repo = makeStubRepo([makeDraftRow()]);
    const result = await actionReviewed('template-uuid-001', 'reviewer@example.com', repo);

    expect(result.templateId).toBe('template-uuid-001');
    expect(result.industry).toBe('ai-companion');
    expect(result.version).toBe(1);

    const row = repo.state.rows.get('template-uuid-001');
    expect(row?.status).toBe('reviewed');
    expect(row?.reviewed_by).toBe('reviewer@example.com');
    expect(row?.reviewed_at).toBeInstanceOf(Date);
  });

  it('rejects transition from reviewed (not draft)', async () => {
    const repo = makeStubRepo([makeDraftRow({ status: 'reviewed' })]);
    await expect(
      actionReviewed('template-uuid-001', 'reviewer@example.com', repo),
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it('rejects transition from active (not draft)', async () => {
    const repo = makeStubRepo([makeDraftRow({ status: 'active' })]);
    await expect(
      actionReviewed('template-uuid-001', 'reviewer@example.com', repo),
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it('throws on unknown template id', async () => {
    const repo = makeStubRepo([]);
    await expect(
      actionReviewed('does-not-exist', 'reviewer@example.com', repo),
    ).rejects.toThrow('not found');
  });

  it('validates payload before transition — bad density_tier fails at review time', async () => {
    const badQuestions = [
      { text: 'q?', language: 'en', funnel_stage: null, density_tier: 'invalid-tier' },
    ];
    const repo = makeStubRepo([makeDraftRow({ questions: badQuestions })]);

    await expect(
      actionReviewed('template-uuid-001', 'reviewer@example.com', repo),
    ).rejects.toThrow(PayloadValidationError);

    // Ensure the row was NOT mutated
    const row = repo.state.rows.get('template-uuid-001');
    expect(row?.status).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// Tests: actionActive
// ---------------------------------------------------------------------------

describe('actionActive', () => {
  it('transitions reviewed -> active, demotes prior active in same txn', async () => {
    const priorActive = makeDraftRow({
      id: 'prior-active-001',
      industry: 'ai-companion',
      version: 0,
      status: 'active',
    });
    const targetRow = makeDraftRow({
      id: 'target-uuid-001',
      industry: 'ai-companion',
      version: 1,
      status: 'reviewed',
    });

    const repo = makeStubRepo([priorActive, targetRow]);
    const materializePort = makeStubMaterializePort();

    const ctx: MaterializeCtx = { slug: 'emora', brandName: 'EMORA' };
    const result = await actionActive('target-uuid-001', 'activator@example.com', repo, materializePort, ctx);

    expect(result.templateId).toBe('target-uuid-001');
    expect(result.yamlPath).toBe('/tmp/customers/emora.yaml');
    expect(result.questionCount).toBe(VALID_QUESTIONS.length);

    // The target row should now be active
    const updated = repo.state.rows.get('target-uuid-001');
    expect(updated?.status).toBe('active');
    expect(updated?.reviewed_by).toBe('activator@example.com');

    // The prior active row must have been demoted to reviewed
    const demoted = repo.state.rows.get('prior-active-001');
    expect(demoted?.status).toBe('reviewed');

    // Transaction was used
    expect(repo.state.transactionCalls).toBe(1);

    // demoteActiveTemplate was called for the correct industry
    expect(repo.state.demoteCalls).toContain('ai-companion');

    // materialize was called exactly once
    expect(materializePort.calls).toHaveLength(1);
    expect(materializePort.calls[0]?.ctx).toMatchObject({ slug: 'emora', brandName: 'EMORA' });
  });

  it('refuses active-directly-from-draft (§5.5 structural gate)', async () => {
    const draftRow = makeDraftRow({ id: 'draft-id', status: 'draft' });
    const repo = makeStubRepo([draftRow]);
    const materializePort = makeStubMaterializePort();

    await expect(
      actionActive('draft-id', 'activator@example.com', repo, materializePort),
    ).rejects.toThrow(InvalidStatusTransitionError);

    // No demote, no materialize
    expect(repo.state.demoteCalls).toHaveLength(0);
    expect(materializePort.calls).toHaveLength(0);
  });

  it('refuses active-from-active (idempotency guard)', async () => {
    const alreadyActive = makeDraftRow({ status: 'active' });
    const repo = makeStubRepo([alreadyActive]);
    const materializePort = makeStubMaterializePort();

    await expect(
      actionActive('template-uuid-001', 'activator@example.com', repo, materializePort),
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it('validates payload before activation — bad question rejected', async () => {
    const badRow = makeDraftRow({
      status: 'reviewed',
      questions: [{ text: '', language: 'en', density_tier: 'core' }], // empty text
    });
    const repo = makeStubRepo([badRow]);
    const materializePort = makeStubMaterializePort();

    await expect(
      actionActive('template-uuid-001', 'activator@example.com', repo, materializePort),
    ).rejects.toThrow(PayloadValidationError);

    // No activation happened
    const row = repo.state.rows.get('template-uuid-001');
    expect(row?.status).toBe('reviewed');
    expect(repo.state.transactionCalls).toBe(0);
    expect(materializePort.calls).toHaveLength(0);
  });

  it('derives default materialize context from customer_slug when not supplied', async () => {
    const row = makeDraftRow({
      status: 'reviewed',
      customer_slug: 'emora',
    });
    const repo = makeStubRepo([row]);
    const materializePort = makeStubMaterializePort();

    await actionActive('template-uuid-001', 'activator@example.com', repo, materializePort);

    expect(materializePort.calls).toHaveLength(1);
    // Should use customer_slug as slug
    expect(materializePort.calls[0]?.ctx.slug).toBe('emora');
  });

  it('works with no prior active template for the industry', async () => {
    const row = makeDraftRow({ status: 'reviewed' });
    const repo = makeStubRepo([row]);
    const materializePort = makeStubMaterializePort();

    const result = await actionActive(
      'template-uuid-001',
      'activator@example.com',
      repo,
      materializePort,
      { slug: 'emora', brandName: 'EMORA' },
    );

    expect(result.templateId).toBe('template-uuid-001');
    expect(repo.state.demoteCalls).toContain('ai-companion');
    // No prior active: demote is a no-op — existing active row count stays 0
    const activeRows = [...repo.state.rows.values()].filter(
      (r) => r.industry === 'ai-companion' && r.status === 'active',
    );
    expect(activeRows).toHaveLength(1); // only the newly activated one
    expect(activeRows[0]?.id).toBe('template-uuid-001');
  });
});

// ---------------------------------------------------------------------------
// Tests: actionEdit (version bump + immutability)
// ---------------------------------------------------------------------------

describe('actionEdit', () => {
  function writeTmpJson(obj: unknown): string {
    const dir = join(tmpdir(), 'review-template-test');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `edit-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(obj), 'utf-8');
    return path;
  }

  it('creates a NEW draft version, leaves the original row immutable', async () => {
    const original = makeDraftRow({ id: 'orig-id', status: 'reviewed', version: 1 });
    const repo = makeStubRepo([original]);

    const editPayload = {
      questions: VALID_QUESTIONS,
      competitors: VALID_COMPETITORS,
    };
    const filePath = writeTmpJson(editPayload);

    const result = await actionEdit('orig-id', filePath, repo, 'editor@example.com');

    // A new row was created
    expect(result.newTemplateId).not.toBe('orig-id');
    expect(result.industry).toBe('ai-companion');
    expect(result.newVersion).toBe(2); // max existing = 1, next = 2

    // New row is a draft
    const newRow = repo.state.rows.get(result.newTemplateId);
    expect(newRow?.status).toBe('draft');
    expect(newRow?.version).toBe(2);

    // Original row is UNCHANGED
    const origRow = repo.state.rows.get('orig-id');
    expect(origRow?.status).toBe('reviewed'); // still reviewed
    expect(origRow?.version).toBe(1);
  });

  it('accepts a plain array as the edit payload (questions only)', async () => {
    const original = makeDraftRow({ id: 'orig-id', version: 1 });
    const repo = makeStubRepo([original]);

    const filePath = writeTmpJson(VALID_QUESTIONS);
    const result = await actionEdit('orig-id', filePath, repo);

    expect(result.newVersion).toBe(2);
    const newRow = repo.state.rows.get(result.newTemplateId);
    expect(Array.isArray(newRow?.questions)).toBe(true);
    // Competitors should be inherited from the original
    expect(newRow?.competitors).toEqual(VALID_COMPETITORS);
  });

  it('version bump is monotonically increasing (max+1)', async () => {
    const rows = [
      makeDraftRow({ id: 'v1', version: 1, status: 'reviewed' }),
      makeDraftRow({ id: 'v2', version: 2, status: 'active' }),
      makeDraftRow({ id: 'v3', version: 3, status: 'reviewed' }),
    ];
    const repo = makeStubRepo(rows);

    const filePath = writeTmpJson({ questions: VALID_QUESTIONS, competitors: VALID_COMPETITORS });
    const result = await actionEdit('v3', filePath, repo);

    expect(result.newVersion).toBe(4); // max existing = 3
  });

  it('rejects edited payload with invalid question (fails at import)', async () => {
    const original = makeDraftRow({ id: 'orig-id', version: 1 });
    const repo = makeStubRepo([original]);

    const badPayload = {
      questions: [{ text: '', language: 'en', density_tier: 'core' }], // empty text
      competitors: [],
    };
    const filePath = writeTmpJson(badPayload);

    await expect(actionEdit('orig-id', filePath, repo)).rejects.toThrow(PayloadValidationError);

    // No new row was inserted
    expect(repo.state.rows.size).toBe(1);
    expect(repo.state.rows.get('orig-id')?.status).toBe('draft');
  });

  it('rejects a file that is not valid JSON', async () => {
    const original = makeDraftRow({ id: 'orig-id', version: 1 });
    const repo = makeStubRepo([original]);

    const dir = join(tmpdir(), 'review-template-test');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `bad-json-${Date.now()}.json`);
    writeFileSync(path, 'not { valid json }', 'utf-8');

    await expect(actionEdit('orig-id', path, repo)).rejects.toThrow('is not valid JSON');
  });

  it('rejects a file with an invalid envelope shape', async () => {
    const original = makeDraftRow({ id: 'orig-id', version: 1 });
    const repo = makeStubRepo([original]);

    const filePath = writeTmpJson(42); // a number
    await expect(actionEdit('orig-id', filePath, repo)).rejects.toThrow(PayloadValidationError);
  });

  it('throws when template is not found', async () => {
    const repo = makeStubRepo([]);
    const filePath = writeTmpJson({ questions: [], competitors: [] });
    await expect(actionEdit('nonexistent', filePath, repo)).rejects.toThrow('not found');
  });
});

// ---------------------------------------------------------------------------
// Tests: full lifecycle sequence (draft -> reviewed -> active -> edit -> new draft)
// ---------------------------------------------------------------------------

describe('full lifecycle sequence', () => {
  it('can complete the full draft->reviewed->active->edit cycle', async () => {
    const draft = makeDraftRow({ id: 'tpl-v1', status: 'draft', version: 1 });
    const repo = makeStubRepo([draft]);
    const materializePort = makeStubMaterializePort();

    // Step 1: draft -> reviewed
    await actionReviewed('tpl-v1', 'alice@example.com', repo);
    expect(repo.state.rows.get('tpl-v1')?.status).toBe('reviewed');

    // Step 2: reviewed -> active (with materialize)
    await actionActive(
      'tpl-v1',
      'bob@example.com',
      repo,
      materializePort,
      { slug: 'emora', brandName: 'EMORA' },
    );
    expect(repo.state.rows.get('tpl-v1')?.status).toBe('active');
    expect(materializePort.calls).toHaveLength(1);

    // Step 3: edit -> new draft v2 (prior active row unchanged)
    const dir = join(tmpdir(), 'review-template-test');
    mkdirSync(dir, { recursive: true });
    const editPath = join(dir, `lifecycle-edit-${Date.now()}.json`);
    writeFileSync(editPath, JSON.stringify({
      questions: VALID_QUESTIONS,
      competitors: VALID_COMPETITORS,
    }), 'utf-8');

    const editResult = await actionEdit('tpl-v1', editPath, repo, 'carol@example.com');
    expect(editResult.newVersion).toBe(2);

    // The active row remains active
    expect(repo.state.rows.get('tpl-v1')?.status).toBe('active');

    // The new draft is inserted
    const newRow = repo.state.rows.get(editResult.newTemplateId);
    expect(newRow?.status).toBe('draft');
    expect(newRow?.version).toBe(2);

    // Step 4: refused to activate-from-draft on the new row
    await expect(
      actionActive(editResult.newTemplateId, 'dave@example.com', repo, materializePort),
    ).rejects.toThrow(InvalidStatusTransitionError);
  });
});

// ---------------------------------------------------------------------------
// TLI-01 — atomic demote+activate via transaction-bound repo
// ---------------------------------------------------------------------------

describe('TLI-01 — withTransaction passes txRepo, not global repo', () => {
  it('actionActive calls demote+activate on the txRepo received in withTransaction', async () => {
    // Track which repo's demoteActiveTemplate and updateTemplateStatus are called
    const txRepoCalls: string[] = [];

    const targetRow = makeDraftRow({
      id: 'target',
      status: 'reviewed',
      industry: 'ai-companion',
      version: 2,
    });

    const innerRepo = makeStubRepo([targetRow]);

    // Replace withTransaction with a spy that verifies the fn argument
    // receives a repo and records calls on THAT repo (not innerRepo directly).
    const spyRepo: ReviewRepo & { state: StubRepoState } = {
      ...innerRepo,
      async withTransaction(fn) {
        innerRepo.state.transactionCalls++;
        // Create a tx-bound sub-repo that records calls
        const txRepo: ReviewRepo = {
          async getIndustryTemplate(id) {
            return innerRepo.getIndustryTemplate(id);
          },
          async updateTemplateStatus(id, status, reviewedBy) {
            txRepoCalls.push(`updateTemplateStatus:${id}:${status}`);
            return innerRepo.updateTemplateStatus(id, status, reviewedBy);
          },
          async demoteActiveTemplate(industry) {
            txRepoCalls.push(`demoteActiveTemplate:${industry}`);
            return innerRepo.demoteActiveTemplate(industry);
          },
          async nextTemplateVersion(industry) {
            return innerRepo.nextTemplateVersion(industry);
          },
          async insertIndustryTemplate(t) {
            return innerRepo.insertIndustryTemplate(t);
          },
          async withTransaction(innerFn) {
            await innerFn(txRepo);
          },
        };
        await fn(txRepo);
      },
    };

    const materializePort = makeStubMaterializePort();
    await actionActive('target', 'activator@example.com', spyRepo, materializePort, {
      slug: 'emora',
      brandName: 'EMORA',
    });

    // Both demote and activate should have been called on the TX-BOUND repo
    expect(txRepoCalls).toContain('demoteActiveTemplate:ai-companion');
    expect(txRepoCalls).toContain('updateTemplateStatus:target:active');
    // Transaction was invoked exactly once
    expect(innerRepo.state.transactionCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TLI-03 — buildDefaultMaterializeCtx populates languages from questions JSONB
// ---------------------------------------------------------------------------

describe('TLI-03 — buildDefaultMaterializeCtx derives languages from template questions', () => {
  it('derives languages from multilingual questions when no explicit ctx is supplied', async () => {
    const multilingualQuestions = [
      { text: 'q_en?', language: 'en', funnel_stage: null, density_tier: 'core' },
      { text: '日本語?', language: 'ja', funnel_stage: null, density_tier: 'secondary' },
      { text: '한국어?', language: 'ko', funnel_stage: null, density_tier: 'longtail' },
    ];

    const row = makeDraftRow({
      status: 'reviewed',
      questions: multilingualQuestions,
      customer_slug: 'emora',
    });

    const repo = makeStubRepo([row]);
    const materializePort = makeStubMaterializePort();

    // actionActive without explicit ctx — buildDefaultMaterializeCtx is called
    await actionActive('template-uuid-001', 'activator@example.com', repo, materializePort);

    // The default ctx must include languages derived from the questions
    expect(materializePort.calls).toHaveLength(1);
    const derivedCtx = materializePort.calls[0]!.ctx;
    expect(derivedCtx.languages).toBeDefined();
    const codes = (derivedCtx.languages ?? []).map((l) => l.code);
    expect(codes).toContain('en');
    expect(codes).toContain('ja');
    expect(codes).toContain('ko');
  });

  it('still works when all questions share a single language', async () => {
    const enOnlyQuestions = [
      { text: 'q1?', language: 'en', funnel_stage: null, density_tier: 'core' },
      { text: 'q2?', language: 'en', funnel_stage: null, density_tier: 'secondary' },
    ];

    const row = makeDraftRow({
      status: 'reviewed',
      questions: enOnlyQuestions,
      customer_slug: 'eng-only',
    });

    const repo = makeStubRepo([row]);
    const materializePort = makeStubMaterializePort();

    await actionActive('template-uuid-001', 'activator@example.com', repo, materializePort);

    const derivedCtx = materializePort.calls[0]!.ctx;
    expect(derivedCtx.languages).toBeDefined();
    expect((derivedCtx.languages ?? []).map((l) => l.code)).toEqual(['en']);
  });
});
