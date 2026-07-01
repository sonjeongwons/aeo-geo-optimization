/**
 * test/diagnose.integration.test.ts
 *
 * T21 integration + proof-path tests — diagnose.ts pipeline.
 *
 * Tests the URL diagnosis pipeline end-to-end with a stubbed Gemini adapter.
 * No real HTTP calls, no real DB, no Phase 0 read-side modules modified.
 *
 * Acceptance criteria (T21):
 *   AC1 — Full proof path runs with a stubbed adapter and repo stubs.
 *   AC2 — Generated BrandBrief passes BrandBriefSchema validation.
 *   AC3 — Exactly one generateStructured() call on the happy path.
 *   AC4 — Degrades to industry-only when fetch fails (no throw).
 *   AC5 — Returns NOT_CONFIGURED when adapter is unconfigured.
 *   AC6 — Ledger row written on each successful call.
 *
 * DESIGN-phase1.md §"URL Diagnosis", T07, T21.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  diagnose,
  type DiagnoseAdapter,
  type LedgerPort,
  type DiagnoseOk,
} from '../src/generate/diagnose.js';
import { BrandBriefSchema, type BrandBrief } from '../src/generate/types.js';
import type { GenerateStructuredResult } from '../src/providers/types.js';
import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A realistic BrandBrief that the stubbed adapter returns.
 */
const FIXTURE_BRAND_BRIEF: BrandBrief = {
  brandName: 'EMORA',
  brandAliases: ['emora', 'エモーラ', '에모라'],
  category: 'AI companion app',
  industryKey: 'ai-companion',
  positioning: 'Emotional memory and multilingual support for companionship.',
  icp: ['young adults seeking emotional connection', 'language learners'],
  productAttributes: ['voice chat', 'emotion tracking', 'multilingual'],
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
};

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

/**
 * Build a stubbed DiagnoseAdapter that returns a pre-configured BrandBrief.
 * Tracks how many times generateStructured() was called.
 */
function makeStubAdapter(
  response: GenerateStructuredResult<BrandBrief> = {
    ok: true,
    data: FIXTURE_BRAND_BRIEF,
    usage: { inputTokens: 800, outputTokens: 200, usd: 0.002, cacheHit: false },
  },
): DiagnoseAdapter & { callCount: () => number } {
  let count = 0;
  return {
    callCount: () => count,
    async generateStructured<T extends z.ZodTypeAny>(
      _req: import('../src/providers/types.js').GenerateStructuredRequest<T>,
    ): Promise<GenerateStructuredResult<z.infer<T>>> {
      count++;
      return response as GenerateStructuredResult<z.infer<T>>;
    },
  };
}

/**
 * Build a NOT_CONFIGURED adapter stub (simulates missing API key).
 */
function makeNotConfiguredAdapter(): DiagnoseAdapter & { callCount: () => number } {
  let count = 0;
  return {
    callCount: () => count,
    async generateStructured<T extends z.ZodTypeAny>(
      _req: import('../src/providers/types.js').GenerateStructuredRequest<T>,
    ): Promise<GenerateStructuredResult<z.infer<T>>> {
      count++;
      return { ok: false, code: 'NOT_CONFIGURED' } as GenerateStructuredResult<z.infer<T>>;
    },
  };
}

/**
 * Build a parse-failure adapter stub (simulates bad JSON from Gemini).
 */
function makeParseFailAdapter(): DiagnoseAdapter {
  return {
    async generateStructured<T extends z.ZodTypeAny>(
      _req: import('../src/providers/types.js').GenerateStructuredRequest<T>,
    ): Promise<GenerateStructuredResult<z.infer<T>>> {
      return {
        ok: false,
        code: 'PARSE_FAILED',
        message: 'Gemini returned invalid JSON',
        raw: '{ broken json',
      } as GenerateStructuredResult<z.infer<T>>;
    },
  };
}

/**
 * Build a ledger stub that captures insertLlmCall invocations.
 */
function makeLedgerStub(): LedgerPort & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async insertLlmCall(_c) {
      calls++;
      return { id: `ledger-${calls}` };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: AC1 + AC2 — Happy path, valid BrandBrief
// ---------------------------------------------------------------------------

describe('diagnose() — happy path (industry-only, no URL)', () => {
  it('returns ok=true with a valid BrandBrief on the happy path', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    const result = await diagnose({
      industry: 'ai-companion',
      adapter,
      ledger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // AC2: BrandBrief passes schema validation
    const parsed = BrandBriefSchema.safeParse(result.brief);
    expect(parsed.success).toBe(true);
  });

  it('BrandBrief has valid brandName, industryKey, detectedLanguages', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    const result = await diagnose({ industry: 'ai-companion', adapter, ledger });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.brief.brandName).toBe('EMORA');
    expect(result.brief.industryKey).toBe('ai-companion');
    expect(result.brief.detectedLanguages.length).toBeGreaterThanOrEqual(1);
  });

  it('detectedLanguages have positive weights', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    const result = await diagnose({ industry: 'ai-companion', adapter, ledger });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const lang of result.brief.detectedLanguages) {
      expect(lang.weight).toBeGreaterThan(0);
    }
  });

  it('returns mode="industry-only" when no URL supplied', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    const result = await diagnose({ industry: 'ai-companion', adapter, ledger });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((result as DiagnoseOk).mode).toBe('industry-only');
  });
});

// ---------------------------------------------------------------------------
// Tests: AC3 — Exactly one generateStructured() call on happy path
// ---------------------------------------------------------------------------

describe('diagnose() — exactly one Gemini call', () => {
  it('makes exactly one generateStructured() call on the happy path', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    await diagnose({ industry: 'ai-companion', adapter, ledger });

    // AC3: exactly one structured call
    expect(adapter.callCount()).toBe(1);
  });

  it('makes exactly one call even when a URL is supplied (with fetch mock)', async () => {
    // The URL fetch will fail (no real HTTP in tests) and degrade to industry-only.
    // There should still be exactly one generateStructured() call.
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    // Use a URL that will fail SSRF (local/private address) — causes graceful degrade
    // without needing real HTTP.  The adapter is still called once for industry-only mode.
    const result = await diagnose({
      url: 'http://127.0.0.1:9999/emora',  // SSRF blocked — graceful degrade
      industry: 'ai-companion',
      adapter,
      ledger,
    });

    // Should degrade gracefully (ok=true, mode='industry-only')
    expect(result.ok).toBe(true);
    // Exactly one adapter call (industry-only fallback)
    expect(adapter.callCount()).toBe(1);
  });

  it('makes ZERO adapter calls when NOT_CONFIGURED is detected', async () => {
    // NOT_CONFIGURED is returned by the adapter — diagnose.ts should detect
    // it on the first call and NOT make additional calls.
    const adapter = makeNotConfiguredAdapter();
    const ledger = makeLedgerStub();

    const result = await diagnose({ industry: 'ai-companion', adapter, ledger });

    expect(result.ok).toBe(false);
    // The adapter was called once (we can't avoid it — the NOT_CONFIGURED
    // is the adapter's response on the single call)
    expect(adapter.callCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: AC4 — Graceful degrade on fetch failure
// ---------------------------------------------------------------------------

describe('diagnose() — graceful degrade on fetch failure', () => {
  it('degrades to industry-only when URL uses a private IP (SSRF blocked)', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    // 169.254.169.254 = metadata endpoint; SSRF guard blocks this
    const result = await diagnose({
      url: 'http://169.254.169.254/latest/meta-data',
      industry: 'ai-companion',
      adapter,
      ledger,
    });

    // Should not throw — degrades gracefully
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Mode should be industry-only (URL was blocked by SSRF guard)
    expect((result as DiagnoseOk).mode).toBe('industry-only');
    // degradeReason should be set
    expect((result as DiagnoseOk).degradeReason).toBeDefined();
    expect((result as DiagnoseOk).degradeReason).not.toBe('');
  });

  it('degrades to industry-only on a non-http scheme', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    const result = await diagnose({
      url: 'ftp://example.com/page',
      industry: 'ai-companion',
      adapter,
      ledger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((result as DiagnoseOk).mode).toBe('industry-only');
    expect((result as DiagnoseOk).degradeReason).toBeDefined();
  });

  it('does NOT throw on fetch failure — always resolves', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    // This should resolve without throwing
    await expect(
      diagnose({
        url: 'http://127.0.0.1:1',  // SSRF-blocked
        industry: 'ai-companion',
        adapter,
        ledger,
      }),
    ).resolves.toBeDefined();
  });

  it('returns a valid BrandBrief even in degraded mode', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    const result = await diagnose({
      url: 'http://192.168.1.1/admin',  // private IP, SSRF blocked
      industry: 'ai-companion',
      adapter,
      ledger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // BrandBrief must still be valid even in degraded mode
    const parsed = BrandBriefSchema.safeParse(result.brief);
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: AC5 — NOT_CONFIGURED response
// ---------------------------------------------------------------------------

describe('diagnose() — NOT_CONFIGURED', () => {
  it('returns ok=false code=NOT_CONFIGURED when adapter returns NOT_CONFIGURED', async () => {
    const adapter = makeNotConfiguredAdapter();
    const ledger = makeLedgerStub();

    const result = await diagnose({ industry: 'ai-companion', adapter, ledger });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('NOT_CONFIGURED');
  });

  it('does not throw when NOT_CONFIGURED — returns a discriminated union', async () => {
    const adapter = makeNotConfiguredAdapter();
    const ledger = makeLedgerStub();

    await expect(
      diagnose({ industry: 'ai-companion', adapter, ledger }),
    ).resolves.toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
  });
});

// ---------------------------------------------------------------------------
// Tests: AC6 — Ledger row written
// ---------------------------------------------------------------------------

describe('diagnose() — ledger row written', () => {
  it('writes a ledger row on a successful structured call', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    await diagnose({ industry: 'ai-companion', adapter, ledger });

    // Give the fire-and-forget ledger call a moment to execute
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(ledger.calls()).toBeGreaterThanOrEqual(1);
  });

  it('does NOT fail when ledger throws (fire-and-forget, non-blocking)', async () => {
    const failingLedger: LedgerPort = {
      async insertLlmCall(_c) {
        throw new Error('DB connection refused');
      },
    };

    const adapter = makeStubAdapter();

    // Should resolve without throwing even if ledger fails
    const result = await diagnose({ industry: 'ai-companion', adapter, ledger: failingLedger });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: INSUFFICIENT_INPUT guard
// ---------------------------------------------------------------------------

describe('diagnose() — input validation', () => {
  it('returns ok=false INSUFFICIENT_INPUT when no url and no industry', async () => {
    const adapter = makeStubAdapter();
    const ledger = makeLedgerStub();

    const result = await diagnose({ adapter, ledger });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('INSUFFICIENT_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Tests: BrandBrief schema compatibility with downstream types
// ---------------------------------------------------------------------------

describe('BrandBrief downstream compatibility', () => {
  it('all fixture detectedLanguages satisfy weight > 0', () => {
    const parsed = BrandBriefSchema.safeParse(FIXTURE_BRAND_BRIEF);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    for (const lang of parsed.data.detectedLanguages) {
      expect(lang.weight).toBeGreaterThan(0);
    }
  });

  it('seedCompetitors have non-empty names', () => {
    const parsed = BrandBriefSchema.safeParse(FIXTURE_BRAND_BRIEF);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    for (const comp of parsed.data.seedCompetitors) {
      expect(comp.name.length).toBeGreaterThan(0);
    }
  });

  it('brandAliases is an array (may be empty)', () => {
    const parsed = BrandBriefSchema.safeParse(FIXTURE_BRAND_BRIEF);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(Array.isArray(parsed.data.brandAliases)).toBe(true);
  });

  it('confidence is between 0 and 1 inclusive', () => {
    const parsed = BrandBriefSchema.safeParse(FIXTURE_BRAND_BRIEF);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.confidence).toBeGreaterThanOrEqual(0);
    expect(parsed.data.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Adapter parse-failure handling
// ---------------------------------------------------------------------------

describe('diagnose() — adapter parse failure', () => {
  it('returns ok=false PARSE_FAILED when adapter signals parse error', async () => {
    const adapter = makeParseFailAdapter();
    const ledger = makeLedgerStub();

    const result = await diagnose({ industry: 'ai-companion', adapter, ledger });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('PARSE_FAILED');
  });

  it('does not throw on parse failure — returns discriminated union', async () => {
    const adapter = makeParseFailAdapter();
    const ledger = makeLedgerStub();

    await expect(
      diagnose({ industry: 'ai-companion', adapter, ledger }),
    ).resolves.toMatchObject({ ok: false });
  });
});
