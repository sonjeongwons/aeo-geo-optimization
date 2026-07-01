/**
 * test/multilingual.test.ts — T10 native multilingual generation.
 *
 * Uses a FAKE adapter + FAKE ledger + a REAL createQgenBudget. No live DB / API key.
 * Asserts: per-language generation, phrasingGroupId preserved, real-usage ledgering
 * (§11, not a $0 sentinel), budget-exhaustion stop-and-return, and per-language
 * fault isolation (NOT_CONFIGURED on one language does not crash the run).
 */
import { describe, it, expect } from 'vitest';
import { generateMultilingual } from '../src/generate/multilingual.js';
import { BrandBriefSchema, IntentCellSchema, GenOptionsSchema } from '../src/generate/types.js';
import type { BrandBrief, IntentCell, GenOptions } from '../src/generate/types.js';
import { createQgenBudget } from '../src/cost/qgenBudget.js';
import { NOT_CONFIGURED, type AdapterUsage } from '../src/providers/types.js';
import type { LedgerPort } from '../src/generate/diagnose.js';

type Opts = Parameters<typeof generateMultilingual>[0];

const BRIEF: BrandBrief = BrandBriefSchema.parse({
  brandName: 'EMORA',
  category: 'AI companion app',
  industryKey: 'ai-companion',
  detectedLanguages: [
    { code: 'en', weight: 1.0, rationale: 'primary content language' },
    { code: 'ja', weight: 0.6, rationale: 'hreflang[ja] present' },
  ],
  confidence: 0.8,
});

function cell(language: string, intentType: IntentCell['intentType'], funnelStage: IntentCell['funnelStage'], targetCount: number): IntentCell {
  return IntentCellSchema.parse({ language, funnelStage, intentType, targetCount, densityTier: 'core' });
}

const GEN: GenOptions = GenOptionsSchema.parse({ requestedTotal: 60 });

function rawItems(language: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    text: `${language} question ${i}`,
    intentType: 'category',
    funnelStage: 'consideration',
    phrasingGroupId: `${language}-grp-${Math.floor(i / 2)}`,
  }));
}

function fakeLedger(): { port: LedgerPort; calls: Array<{ usd: number; inputTokens: number }> } {
  const calls: Array<{ usd: number; inputTokens: number }> = [];
  return {
    calls,
    port: {
      insertLlmCall: async (c) => { calls.push({ usd: c.usd, inputTokens: c.inputTokens }); return { id: 'x' }; },
    },
  };
}

const USAGE: AdapterUsage = { inputTokens: 100, outputTokens: 200, usd: 0.02, cacheHit: false };

/**
 * Adapter that returns N raw items per call with fixed usage. The helper forces
 * each returned question's `language` to the call's language (matrix order is
 * preserved: en first, then ja), so the raw items' labels are cosmetic.
 */
function okAdapter(n: number): Opts['adapter'] {
  let i = 0;
  return {
    generateStructured: (async () => {
      const lang = i++ === 0 ? 'en' : 'ja';
      return { ok: true, data: { questions: rawItems(lang, n) }, usage: USAGE };
    }) as Opts['adapter']['generateStructured'],
  };
}

describe('generateMultilingual (T10)', () => {
  it('generates questions per language and preserves phrasingGroupId', async () => {
    const ledger = fakeLedger();
    const res = await generateMultilingual({
      adapter: okAdapter(4),
      brief: BRIEF,
      matrix: [cell('en', 'category', 'consideration', 4), cell('ja', 'category', 'consideration', 4)],
      genOptions: GEN,
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
    });
    expect(res.questions.length).toBeGreaterThan(0);
    const langs = new Set(res.questions.map((q) => q.language));
    expect(langs.has('en')).toBe(true);
    expect(langs.has('ja')).toBe(true);
    expect(res.questions.every((q) => typeof q.phrasingGroupId === 'string' && q.phrasingGroupId.length > 0)).toBe(true);
    expect(res.generatedTotal).toBe(8); // 4 raw per language x 2 languages
  });

  it('ledgers the REAL usage (not a $0 sentinel) for each language call (§11)', async () => {
    const ledger = fakeLedger();
    await generateMultilingual({
      adapter: okAdapter(3),
      brief: BRIEF,
      matrix: [cell('en', 'category', 'consideration', 3), cell('ja', 'category', 'consideration', 3)],
      genOptions: GEN,
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
    });
    expect(ledger.calls.length).toBe(2);
    expect(ledger.calls.every((c) => c.usd === USAGE.usd)).toBe(true);
    expect(ledger.calls.every((c) => c.inputTokens === USAGE.inputTokens)).toBe(true);
  });

  it('stops and returns partial results when the per-run budget ceiling is exceeded', async () => {
    const ledger = fakeLedger();
    // ceiling below a single call's usd => the FIRST language trips the ceiling.
    const res = await generateMultilingual({
      adapter: okAdapter(3),
      brief: BRIEF,
      matrix: [cell('en', 'category', 'consideration', 3), cell('ja', 'category', 'consideration', 3)],
      genOptions: GEN,
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 0.001 }),
    });
    // first language's questions are kept (already paid for), second never runs.
    expect(new Set(res.questions.map((q) => q.language)).size).toBe(1);
    expect(ledger.calls.length).toBe(1);
  });

  it('isolates a per-language failure (NOT_CONFIGURED) and continues other languages', async () => {
    const ledger = fakeLedger();
    let i = 0;
    const adapter: Opts['adapter'] = {
      // call 0 = en (ok), call 1 = ja (NOT_CONFIGURED) — matrix order is preserved.
      generateStructured: (async () => {
        if (i++ === 1) return { ok: false, code: NOT_CONFIGURED, message: 'no key' };
        return { ok: true, data: { questions: rawItems('en', 3) }, usage: USAGE };
      }) as Opts['adapter']['generateStructured'],
    };
    const res = await generateMultilingual({
      adapter,
      brief: BRIEF,
      matrix: [cell('en', 'category', 'consideration', 3), cell('ja', 'category', 'consideration', 3)],
      genOptions: GEN,
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
    });
    const langs = new Set(res.questions.map((q) => q.language));
    expect(langs.has('en')).toBe(true);
    expect(langs.has('ja')).toBe(false); // ja failed, did not crash the run
    expect(res.questions.length).toBeGreaterThan(0);
  });
});
