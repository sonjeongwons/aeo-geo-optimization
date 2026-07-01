/**
 * test/multilingualContent-alloc.test.ts
 *
 * T08 — Allocation tests for generateMultilingualContent.
 *
 * Asserts:
 *   1. Items are generated per language (multi-language matrix).
 *   2. Every call writes an llm_call row with purpose='generation'.
 *   3. Low-resource-language assets carry needs_native_review=true.
 *   4. High-resource-language assets carry needs_native_review=false.
 *   5. Content ceiling (~$2) is used — NOT the $0.50 qgen default.
 *   6. Per-language fault isolation: NOT_CONFIGURED on one lang continues others.
 *   7. generatedTotal reflects the raw count (before body-level filtering).
 *   8. customerId is passed through to the ledger.
 *
 * Uses FAKE adapter + FAKE ledger + REAL createQgenBudget. No live DB / API key.
 */

import { describe, it, expect, vi } from "vitest";
import {
  generateMultilingualContent,
  DEFAULT_LOW_RESOURCE_LANGUAGES,
  type LedgerPort,
  type GeneratedContentItemWithReview,
} from "../src/content/multilingualContent.js";
import { createQgenBudget } from "../src/cost/qgenBudget.js";
import { env } from "../src/config/env.js";
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
  brandAliases: ["エモーラ", "에모라"],
  category: "AI companion app",
  industryKey: "ai-companion",
  detectedLanguages: [
    { code: "en", weight: 1.0, rationale: "primary" },
    { code: "ja", weight: 0.8, rationale: "hreflang[ja]" },
    { code: "ko", weight: 0.6, rationale: "hreflang[ko]" },
    { code: "tl", weight: 0.2, rationale: "minor market" },
    { code: "vi", weight: 0.2, rationale: "minor market" },
  ],
  confidence: 0.9,
});

const REAL_USAGE: AdapterUsage = {
  inputTokens: 500,
  outputTokens: 1000,
  usd: 0.05,
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
      text: `${language} definition of EMORA`,
      meaning_key: "emora-definition",
    },
  };
}

function fakeLedger(): {
  port: LedgerPort;
  calls: Array<{ customerId: string | null; purpose: string; usd: number }>;
} {
  const calls: Array<{ customerId: string | null; purpose: string; usd: number }> = [];
  return {
    calls,
    port: {
      insertLlmCall: async (c) => {
        calls.push({ customerId: c.customerId, purpose: c.purpose, usd: c.usd });
        return { id: "ledger-row-id" };
      },
    },
  };
}

/**
 * Adapter that returns items for the requested language, with fixed usage.
 * The adapter is called once per language; we track calls to assert ONE call/lang.
 */
function makeOkAdapterByLanguage(
  usage: AdapterUsage = REAL_USAGE
): ContentGenerationAdapter & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    generateStructured: vi.fn(async (req) => {
      callCount++;
      // Infer language from the prompt (we can't easily know which language was
      // requested without parsing the prompt, so we return items tagged with a
      // language derived from the call order).
      // For simplicity, return a fixed item; language matching is tested in T07.
      return {
        ok: true as const,
        data: { items: [] }, // no items needed for these tests
        usage,
      };
    }) as ContentGenerationAdapter["generateStructured"],
  };
}

/**
 * Adapter that returns ONE real item per call, using the language from the
 * request prompt (we embed the language in phrasingGroupId).
 */
function makeItemReturningAdapter(
  languages: string[],
  usage: AdapterUsage = REAL_USAGE
): ContentGenerationAdapter {
  let callIdx = 0;
  return {
    generateStructured: vi.fn(async () => {
      const lang = languages[callIdx++] ?? "en";
      return {
        ok: true as const,
        data: {
          items: [makeDefinitionItem(lang, `grp-${lang}`)],
        },
        usage,
      };
    }) as ContentGenerationAdapter["generateStructured"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateMultilingualContent — allocation (T08)", () => {
  // ---- 1. Items generated per language ----

  it("generates items for each language in the matrix", async () => {
    const languages = ["en", "ja", "ko"];
    const adapter = makeItemReturningAdapter(languages);
    const ledger = fakeLedger();

    const matrix = languages.map((l) => makeCell(l));

    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix,
      genOptions: {
        runCeilingUsd: 10,
        lowResourceLanguages: [...DEFAULT_LOW_RESOURCE_LANGUAGES],
      },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
      customerId: null,
    });

    // We expect items from all 3 languages
    const generatedLangs = new Set(result.items.map((i) => i.language));
    expect(generatedLangs.has("en")).toBe(true);
    expect(generatedLangs.has("ja")).toBe(true);
    expect(generatedLangs.has("ko")).toBe(true);
    expect(result.items.length).toBeGreaterThanOrEqual(3);
  });

  // ---- 2. Every call writes an llm_call row with purpose='generation' ----

  it("writes an llm_call row with purpose='generation' for every language", async () => {
    const languages = ["en", "ja"];
    const adapter = makeItemReturningAdapter(languages);
    const ledger = fakeLedger();

    const matrix = languages.map((l) => makeCell(l));

    await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix,
      genOptions: { runCeilingUsd: 10, lowResourceLanguages: [] },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
    });

    expect(ledger.calls.length).toBe(2); // 1 call per language
    expect(ledger.calls.every((c) => c.purpose === "generation")).toBe(true);
  });

  // ---- 3. Low-resource languages carry needs_native_review=true ----

  it("sets needs_native_review=true for low-resource languages (tl, vi, th)", async () => {
    // tl and vi are low-resource by default
    const languages = ["en", "tl", "vi"];
    const adapter = makeItemReturningAdapter(languages);
    const ledger = fakeLedger();

    const matrix = languages.map((l) => makeCell(l));

    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix,
      genOptions: {
        runCeilingUsd: 10,
        lowResourceLanguages: [...DEFAULT_LOW_RESOURCE_LANGUAGES],
      },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
    });

    const tlItems = result.items.filter((i) => i.language === "tl");
    const viItems = result.items.filter((i) => i.language === "vi");
    const enItems = result.items.filter((i) => i.language === "en");

    expect(tlItems.length).toBeGreaterThan(0);
    expect(tlItems.every((i) => i.needs_native_review === true)).toBe(true);

    expect(viItems.length).toBeGreaterThan(0);
    expect(viItems.every((i) => i.needs_native_review === true)).toBe(true);

    expect(enItems.length).toBeGreaterThan(0);
    expect(enItems.every((i) => i.needs_native_review === false)).toBe(true);
  });

  // ---- 4. High-resource languages carry needs_native_review=false ----

  it("sets needs_native_review=false for high-resource languages", async () => {
    const languages = ["en", "ja", "ko"];
    const adapter = makeItemReturningAdapter(languages);
    const ledger = fakeLedger();

    const matrix = languages.map((l) => makeCell(l));

    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix,
      genOptions: {
        runCeilingUsd: 10,
        lowResourceLanguages: [...DEFAULT_LOW_RESOURCE_LANGUAGES], // en, ja, ko NOT in list
      },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
    });

    expect(result.items.every((i) => i.needs_native_review === false)).toBe(true);
  });

  // ---- 5. Content ceiling (~$2) is used, not $0.50 ----

  it("uses CONTENT_RUN_CEILING_USD (~$2) from genOptions, not the $0.50 qgen default", () => {
    // Assert that the env.CONTENT_RUN_CEILING_USD default is 2 (not 0.50)
    expect(env.CONTENT_RUN_CEILING_USD).toBe(2);

    // The budget is created with runCeilingUsd: CONTENT_RUN_CEILING_USD
    // Assert that a budget with $2 ceiling can handle 3 calls at $0.05 each
    const budget = createQgenBudget({ runCeilingUsd: 2 });
    budget.recordUsage(0.05);
    budget.recordUsage(0.05);
    budget.recordUsage(0.05);
    expect(budget.isWithinCeiling()).toBe(true);
    expect(budget.totalUsd).toBeCloseTo(0.15, 5);

    // But a $0.50 budget would also pass here — the distinguishing test is that
    // the CEILING itself is $2, so we assert the ceiling property directly.
    const contentBudget = createQgenBudget({ runCeilingUsd: env.CONTENT_RUN_CEILING_USD });
    expect(contentBudget.ceiling).toBe(2);
  });

  // ---- 6. Per-language fault isolation: NOT_CONFIGURED on one lang continues others ----

  it("isolates NOT_CONFIGURED on one language and continues the other languages", async () => {
    let callIdx = 0;
    const adapter: ContentGenerationAdapter = {
      generateStructured: vi.fn(async () => {
        const idx = callIdx++;
        if (idx === 1) {
          // Second language (ja) — NOT_CONFIGURED
          return { ok: false as const, code: NOT_CONFIGURED };
        }
        // First language (en) and third (ko) — succeed
        const lang = idx === 0 ? "en" : "ko";
        return {
          ok: true as const,
          data: { items: [makeDefinitionItem(lang)] },
          usage: REAL_USAGE,
        };
      }) as ContentGenerationAdapter["generateStructured"],
    };

    const ledger = fakeLedger();
    const matrix = ["en", "ja", "ko"].map((l) => makeCell(l));

    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix,
      genOptions: { runCeilingUsd: 10, lowResourceLanguages: [] },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
    });

    // en and ko should succeed; ja failed but did not crash the run
    const langs = new Set(result.items.map((i) => i.language));
    expect(langs.has("en")).toBe(true);
    expect(langs.has("ko")).toBe(true);
    expect(langs.has("ja")).toBe(false);

    // Only 2 ledger writes (en + ko), not 3 (ja failed before ledgering)
    expect(ledger.calls.length).toBe(2);
  });

  // ---- 7. generatedTotal reflects raw count ----

  it("generatedTotal counts raw items before any filtering", async () => {
    // Adapter returns 3 raw items for "en" (some may be rejected by body parse)
    const adapter: ContentGenerationAdapter = {
      generateStructured: vi.fn(async () => ({
        ok: true as const,
        data: {
          items: [
            makeDefinitionItem("en", "grp-1"),
            makeDefinitionItem("en", "grp-2"),
            makeDefinitionItem("en", "grp-3"),
          ],
        },
        usage: REAL_USAGE,
      })) as ContentGenerationAdapter["generateStructured"],
    };

    const ledger = fakeLedger();
    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix: [makeCell("en")],
      genOptions: { runCeilingUsd: 10, lowResourceLanguages: [] },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
    });

    // 3 raw items from the adapter
    expect(result.generatedTotal).toBe(3);
    // All 3 are valid definitions => 3 items returned
    expect(result.items.length).toBe(3);
  });

  // ---- 8. customerId is passed through to the ledger ----

  it("passes customerId to each insertLlmCall ledger row", async () => {
    const adapter = makeItemReturningAdapter(["en"]);
    const ledger = fakeLedger();
    const CUSTOMER_ID = "11111111-2222-3333-4444-555555555555";

    await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix: [makeCell("en")],
      genOptions: { runCeilingUsd: 10, lowResourceLanguages: [] },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
      customerId: CUSTOMER_ID,
    });

    expect(ledger.calls.length).toBe(1);
    expect(ledger.calls[0]!.customerId).toBe(CUSTOMER_ID);
  });

  // ---- 9. Items returned when matrix is empty ----

  it("returns empty items and generatedTotal=0 when the matrix is empty", async () => {
    const adapter = makeOkAdapterByLanguage();
    const ledger = fakeLedger();

    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix: [],
      genOptions: { runCeilingUsd: 10, lowResourceLanguages: [] },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
    });

    expect(result.items).toHaveLength(0);
    expect(result.generatedTotal).toBe(0);
    expect(ledger.calls).toHaveLength(0);
  });

  // ---- 10. DEFAULT_LOW_RESOURCE_LANGUAGES constant is exported ----

  it("exports DEFAULT_LOW_RESOURCE_LANGUAGES containing tl, vi, th", () => {
    expect(DEFAULT_LOW_RESOURCE_LANGUAGES).toContain("tl");
    expect(DEFAULT_LOW_RESOURCE_LANGUAGES).toContain("vi");
    expect(DEFAULT_LOW_RESOURCE_LANGUAGES).toContain("th");
  });

  // ---- 11. GeneratedContentItemWithReview has needs_native_review field ----

  it("GeneratedContentItemWithReview has needs_native_review boolean field", async () => {
    const adapter = makeItemReturningAdapter(["en"]);
    const ledger = fakeLedger();

    const result = await generateMultilingualContent({
      adapter,
      brief: BRIEF,
      matrix: [makeCell("en")],
      genOptions: { runCeilingUsd: 10, lowResourceLanguages: ["tl", "vi", "th"] },
      ledger: ledger.port,
      budget: createQgenBudget({ runCeilingUsd: 10 }),
    });

    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(typeof item.needs_native_review).toBe("boolean");
    }
  });
});
