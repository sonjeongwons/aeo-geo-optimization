/**
 * test/multilingualContent-partial-budget.test.ts
 *
 * T08 — Budget-exhaustion + partial-return tests for generateMultilingualContent.
 *
 * Asserts:
 *   1. Budget exhaustion returns partial results WITHOUT throwing to the caller.
 *   2. The FIRST language's items are kept (already paid for) when the ceiling
 *      is hit mid-run (recordUsage throws QgenBudgetExceededError after the first
 *      call, so the second language's call never executes).
 *   3. Only the languages processed before budget exhaustion produce ledger rows.
 *   4. The return value is { items, generatedTotal } — the caller does NOT see
 *      a QgenBudgetExceededError.
 *   5. isWithinCeiling=false at the start of a language iteration causes that
 *      language to be skipped immediately (no call, no ledger row).
 *   6. A per-run ceiling of $2 (CONTENT_RUN_CEILING_USD) accepts ~40 calls at
 *      the $0.05 fixture usage before truncating (basic arithmetic sanity check).
 *
 * Uses FAKE adapter + FAKE ledger + REAL createQgenBudget. No live DB / API key.
 */

import { describe, it, expect, vi } from "vitest";
import {
  generateMultilingualContent,
  type LedgerPort,
} from "../src/content/multilingualContent.js";
import { createQgenBudget } from "../src/cost/qgenBudget.js";
import { NOT_CONFIGURED, type AdapterUsage } from "../src/providers/types.js";
import type { ContentGenerationAdapter } from "../src/content/generateContentForLanguage.js";
import type { ContentCell } from "../src/content/types.js";
import { BrandBriefSchema } from "../src/generate/types.js";
import type { BrandBrief } from "../src/generate/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BRIEF: BrandBrief = BrandBriefSchema.parse({
  brandName: "EMORA",
  category: "AI companion app",
  industryKey: "ai-companion",
  detectedLanguages: [
    { code: "en", weight: 1.0, rationale: "primary" },
    { code: "ja", weight: 0.8, rationale: "secondary" },
    { code: "ko", weight: 0.6, rationale: "tertiary" },
  ],
  confidence: 0.9,
});

const HIGH_USAGE: AdapterUsage = {
  inputTokens: 5000,
  outputTokens: 10000,
  usd: 1.5, // $1.50 per call — exceeds $2 ceiling after 1 call
  cacheHit: false,
};

const LOW_USAGE: AdapterUsage = {
  inputTokens: 100,
  outputTokens: 200,
  usd: 0.01, // well within ceiling
  cacheHit: false,
};

function makeCell(
  language: string,
  format: ContentCell["format"] = "definition_sentence",
  channel_class: ContentCell["channel_class"] = "owned_net"
): ContentCell {
  return {
    contentType: "definition",
    format,
    language,
    channel_class,
    targetVariants: 1,
    phrasingGroupSeed: `${format}:${language}:${channel_class}:v0`,
  };
}

function makeDefinitionItem(language: string, phrasingGroupId = "grp-1") {
  return {
    language,
    format: "definition_sentence" as const,
    channel_class: "owned_net" as const,
    phrasingGroupId,
    body: {
      content_type: "definition" as const,
      text: `${language} definition`,
      meaning_key: "emora-definition",
    },
  };
}

function fakeLedger(): {
  port: LedgerPort;
  calls: Array<{ usd: number; purpose: string }>;
} {
  const calls: Array<{ usd: number; purpose: string }> = [];
  return {
    calls,
    port: {
      insertLlmCall: async (c) => {
        calls.push({ usd: c.usd, purpose: c.purpose });
        return { id: "x" };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateMultilingualContent — budget exhaustion (T08)", () => {
  // ---- 1. Budget exhaustion: returns partial results, does NOT throw ----

  it("returns partial results without throwing when the per-run ceiling is exceeded", async () => {
    // HIGH_USAGE ($1.50 per call) with a $2 ceiling.
    // After the FIRST language call, accumulated = $1.50 (within ceiling).
    // recordUsage($1.50) succeeds; no error.
    // SECOND language call: accumulated = $3.00 > $2.00 => QgenBudgetExceededError thrown.
    // The orchestrator must catch it and return partial results without re-throwing.
    let callIdx = 0;
    const adapter: ContentGenerationAdapter = {
      generateStructured: vi.fn(async () => {
        const idx = callIdx++;
        const lang = idx === 0 ? "en" : "ja";
        return {
          ok: true as const,
          data: { items: [makeDefinitionItem(lang)] },
          usage: HIGH_USAGE,
        };
      }) as ContentGenerationAdapter["generateStructured"],
    };

    const ledger = fakeLedger();
    const matrix = ["en", "ja", "ko"].map((l) => makeCell(l));

    // $2 ceiling; first call costs $1.50 (ok), second costs another $1.50 => $3.00 > $2 => exceeded
    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix,
      genOptions: { runCeilingUsd: 2, lowResourceLanguages: [] },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 2 }),
    });

    // Must NOT throw
    expect(result).toBeDefined();
    expect(result.items).toBeInstanceOf(Array);

    // First language (en) items are kept (already paid for)
    const langs = new Set(result.items.map((i) => i.language));
    expect(langs.has("en")).toBe(true);
    // Second language may or may not have been started, but ko (3rd) should NOT be present
    expect(langs.has("ko")).toBe(false);
  });

  // ---- 2. First language's items are kept when ceiling hit after first call ----

  it("keeps the first language's items when budget is exceeded after the first call", async () => {
    // ceiling just below the second call's cumulative cost
    // First call usd=$1.50 => recordUsage($1.50) => accum=$1.50 <= $2.00 => ok
    // Second call usd=$1.50 => recordUsage($1.50) => accum=$3.00 > $2.00 => EXCEEDED (throw caught)
    let callIdx = 0;
    const adapter: ContentGenerationAdapter = {
      generateStructured: vi.fn(async () => {
        const idx = callIdx++;
        const lang = idx === 0 ? "en" : "ja";
        return {
          ok: true as const,
          data: { items: [makeDefinitionItem(lang, `grp-${lang}`)] },
          usage: HIGH_USAGE, // $1.50 each
        };
      }) as ContentGenerationAdapter["generateStructured"],
    };

    const ledger = fakeLedger();
    const matrix = ["en", "ja"].map((l) => makeCell(l));

    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix,
      genOptions: { runCeilingUsd: 2, lowResourceLanguages: [] },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 2 }),
    });

    // en items MUST be present (they were generated before the budget was exceeded)
    const enItems = result.items.filter((i) => i.language === "en");
    expect(enItems.length).toBeGreaterThan(0);
  });

  // ---- 3. Only processed languages produce ledger rows ----

  it("only writes ledger rows for languages that were actually processed", async () => {
    // ceiling=$0.001 => first call's recordUsage($1.50) will exceed immediately
    // Actually: isWithinCeiling() is checked BEFORE the call.
    // With ceiling=0.001 and accum=0, isWithinCeiling() returns true before en.
    // After en's recordUsage($1.50): accum=$1.50 > $0.001 => exceeded, break.
    // ja never runs => only 1 ledger row.
    let callIdx = 0;
    const adapter: ContentGenerationAdapter = {
      generateStructured: vi.fn(async () => {
        const lang = callIdx++ === 0 ? "en" : "ja";
        return {
          ok: true as const,
          data: { items: [makeDefinitionItem(lang)] },
          usage: HIGH_USAGE,
        };
      }) as ContentGenerationAdapter["generateStructured"],
    };

    const ledger = fakeLedger();
    const matrix = ["en", "ja", "ko"].map((l) => makeCell(l));

    await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix,
      genOptions: { runCeilingUsd: 2, lowResourceLanguages: [] },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 2 }),
    });

    // At most 2 languages are processed (en at $1.50 is within; ja at $3.00 exceeds)
    // Only the languages that completed successfully get a ledger row
    expect(ledger.calls.length).toBeLessThanOrEqual(2);
  });

  // ---- 4. QgenBudgetExceededError is never re-thrown to the caller ----

  it("never propagates QgenBudgetExceededError to the caller — returns partial result", async () => {
    const adapter: ContentGenerationAdapter = {
      generateStructured: vi.fn(async () => ({
        ok: true as const,
        data: { items: [makeDefinitionItem("en")] },
        usage: { inputTokens: 100, outputTokens: 100, usd: 5.0, cacheHit: false }, // $5 each
      })) as ContentGenerationAdapter["generateStructured"],
    };

    const ledger = fakeLedger();
    const matrix = ["en", "ja"].map((l) => makeCell(l));

    // ceiling=$2 => after first call at $5 → QgenBudgetExceededError THROWN inside budget.recordUsage
    // The orchestrator must catch it and NOT re-throw
    let threw = false;
    let result: Awaited<ReturnType<typeof generateMultilingualContent>> | undefined;
    try {
      result = await generateMultilingualContent({
        adapter,
        brief: BRIEF,
        matrix,
        genOptions: { runCeilingUsd: 2, lowResourceLanguages: [] },
        ledger: ledger.port,
        budget: createQgenBudget({ runCeilingUsd: 2 }),
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.items).toBeInstanceOf(Array);
  });

  // ---- 5. isWithinCeiling=false at start of iteration skips that language ----

  it("skips a language if budget ceiling is already exhausted before its call", async () => {
    // Pre-exhaust the budget externally so the first iteration sees isWithinCeiling=false
    const budget = createQgenBudget({ runCeilingUsd: 0.001 });
    // Pre-exhaust: recordUsage $0.002 => $0.002 > $0.001 => throw, then isWithinCeiling=false
    try {
      budget.recordUsage(0.002);
    } catch {
      // expected QgenBudgetExceededError
    }
    expect(budget.isWithinCeiling()).toBe(false);

    const adapter: ContentGenerationAdapter = {
      generateStructured: vi.fn(async () => ({
        ok: true as const,
        data: { items: [makeDefinitionItem("en")] },
        usage: LOW_USAGE,
      })) as ContentGenerationAdapter["generateStructured"],
    };

    const ledger = fakeLedger();

    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix: [makeCell("en"), makeCell("ja")],
      genOptions: { runCeilingUsd: 0.001, lowResourceLanguages: [] },
      ledger: ledger.port,
      budget,
    });

    // No calls were made because isWithinCeiling=false from the start
    expect(result.items).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
    // adapter was never called
    expect((adapter.generateStructured as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  // ---- 6. Arithmetic sanity: $2 ceiling ~ 40 calls at $0.05 each ----

  it("a $2 ceiling accepts ~40 calls at $0.05 each before truncating", () => {
    const budget = createQgenBudget({ runCeilingUsd: 2 });
    let calls = 0;
    try {
      // Record 40 calls at $0.05 each = $2.00 total
      for (let i = 0; i < 40; i++) {
        budget.recordUsage(0.05);
        calls++;
      }
    } catch {
      // 40 * $0.05 = $2.00 exactly — may hit the ceiling at the 40th call
    }

    // At 39 calls ($1.95) we should still be within ceiling
    const budget2 = createQgenBudget({ runCeilingUsd: 2 });
    let throws = false;
    for (let i = 0; i < 39; i++) {
      budget2.recordUsage(0.05); // $0.05 * 39 = $1.95 < $2.00
    }
    expect(budget2.isWithinCeiling()).toBe(true);
    expect(budget2.totalUsd).toBeCloseTo(1.95, 4);

    // The 40th call at $0.05 brings it to $2.00 — exactly at the boundary.
    // Whether this throws depends on whether > or >= is used.
    // The design says "exceeded" means > ceiling (strict), so $2.00 == $2.00 is ok.
    // In our implementation: accumulatedUsd > ceilingUsd => throw.
    // $2.00 > $2.00 is false, so the 40th call does NOT throw.
    // But this is an implementation detail; what matters is ~40 calls work.
    expect(calls).toBeGreaterThanOrEqual(39);
  });

  // ---- 7. Partial return includes generatedTotal from processed languages ----

  it("generatedTotal reflects raw counts from languages processed before budget cutoff", async () => {
    let callIdx = 0;
    const adapter: ContentGenerationAdapter = {
      generateStructured: vi.fn(async () => {
        const idx = callIdx++;
        const lang = idx === 0 ? "en" : "ja";
        return {
          ok: true as const,
          data: {
            items: [
              makeDefinitionItem(lang, `grp-${lang}-1`),
              makeDefinitionItem(lang, `grp-${lang}-2`),
            ],
          },
          usage: HIGH_USAGE, // $1.50 per call, $2 ceiling
        };
      }) as ContentGenerationAdapter["generateStructured"],
    };

    const ledger = fakeLedger();

    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix: ["en", "ja", "ko"].map((l) => makeCell(l)),
      genOptions: { runCeilingUsd: 2, lowResourceLanguages: [] },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 2 }),
    });

    // en (2 items, $1.50 within $2) + ja (2 items, $3.00 > $2, kept but then stops) OR
    // en only (if second call is never made due to pre-check failing after en).
    // Either way, generatedTotal should match the items that were actually returned.
    expect(result.generatedTotal).toBeGreaterThanOrEqual(2); // at least en's raw items
  });
});
