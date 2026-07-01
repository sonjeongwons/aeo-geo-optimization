/**
 * test/generateContentForLanguage.test.ts
 *
 * T07 — Tests for generateContentForLanguage and buildContentPrompt.
 *
 * Uses a FAKE adapter — no live API key / DB required.
 *
 * After the lean-schema fix the adapter should return LEAN bodies
 * (only author-visible fields, no UUIDs/derived counts), and
 * generateContentForLanguage constructs full STORAGE bodies via
 * buildStorageBodyWithLength() before returning.
 *
 * Asserts:
 *   1. ONE generateStructured call PER LLM-GENERATABLE FORMAT (jsonld_* skipped).
 *   2. jsonld_* cells are SKIPPED — no LLM call issued for those formats.
 *   3. Per-format call uses the LEAN body schema (LEAN_GEN_SCHEMA_MAP) so the
 *      responseSchema never requires UUID fields or derived counts.
 *   4. Output language-tag mismatch is rejected (native-gen structural guard).
 *   5. NOT_CONFIGURED returns ok:false and does NOT throw.
 *   6. Returns real AdapterUsage (summed across per-format calls) for ledger/budget.
 *   7. buildContentPrompt produces a native-language instruction that mentions
 *      the language, avoids UUID fields in the body shape instruction, and
 *      includes format + channel descriptors.
 *   8. buildContentPromptForFormat produces a single-format lean prompt.
 *   9. Empty cells returns ok:true with zero items.
 *  10. Lean body parse failure on a per-item basis drops the item (not the call).
 *  11. definition_sentence: LEAN body {content_type,text} → constructed storage
 *      body has meaning_key = phrasingGroupId; validates ContentBodySchema.
 *  12. answer_block: LEAN body {content_type,text} → constructed storage body
 *      has length_units (computed), numeric_claim_ids=[], source_ids=[];
 *      validates ContentBodySchema.
 *  13. faq_table: LEAN body {content_type,rows:[{q,a}]} → constructed storage
 *      body rows have answer_claim_ids=[]; validates ContentBodySchema.
 *  14. comparison_table: LEAN body → constructed storage cells have claim_id=null.
 *  15. case_study: LEAN body → constructed storage metrics have claim_id=null.
 *  16. One format's failure does NOT abort the other formats (partial-return).
 *  17. LEAN_GEN_SCHEMA_MAP schemas produce type:"object" in zodToGeminiSchema
 *      (no "string" fallback that caused the original bug).
 */

import { describe, it, expect, vi } from "vitest";
import {
  generateContentForLanguage,
  overGenTotal,
  OVER_GEN_FACTOR,
  type ContentGenerationAdapter,
  type GeneratedContentItem,
} from "../src/content/generateContentForLanguage.js";
import {
  buildContentPrompt,
  buildContentPromptForFormat,
} from "../src/content/generationPromptContent.js";
import { zodToGeminiSchema } from "../src/domain/mention.schema.js";
import {
  LEAN_GEN_SCHEMA_MAP,
  ContentBodySchema,
  buildStorageBodyWithLength,
  LeanContentBodySchema,
} from "../src/content/types.js";
import { BrandBriefSchema } from "../src/generate/types.js";
import type { BrandBrief } from "../src/generate/types.js";
import type { ContentCell } from "../src/content/types.js";
import { NOT_CONFIGURED, type AdapterUsage } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BRIEF: BrandBrief = BrandBriefSchema.parse({
  brandName: "EMORA",
  brandAliases: ["エモーラ", "에모라"],
  category: "AI companion app",
  industryKey: "ai-companion",
  positioning: "Long-term emotional memory and multilingual AI companion.",
  icp: ["young adults seeking emotional support", "language learners"],
  productAttributes: ["voice chat", "emotion tracking", "multilingual support"],
  seedCompetitors: [
    { name: "Character.AI", aliases: ["character.ai"] },
    { name: "Replika", aliases: ["Replika", "レプリカ"] },
  ],
  detectedLanguages: [
    { code: "en", weight: 1.0, rationale: "primary content language" },
    { code: "ja", weight: 0.8, rationale: "hreflang[ja] present" },
    { code: "ko", weight: 0.6, rationale: "hreflang[ko] present" },
  ],
  confidence: 0.9,
});

/**
 * Build a minimal ContentCell for testing.
 */
function makeCell(
  language: string,
  format: ContentCell["format"],
  channel_class: ContentCell["channel_class"],
  targetVariants = 1
): ContentCell {
  return {
    contentType:
      format === "definition_sentence"
        ? "definition"
        : format === "answer_block"
          ? "answer_block"
          : format === "faq_table"
            ? "faq"
            : format === "comparison_table"
              ? "comparison"
              : format === "case_study"
                ? "case_study"
                : "jsonld",
    format,
    language,
    channel_class,
    targetVariants,
    phrasingGroupSeed: `${format}:${language}:${channel_class}:v0`,
  };
}

const REAL_USAGE: AdapterUsage = {
  inputTokens: 500,
  outputTokens: 1200,
  usd: 0.05,
  cacheHit: false,
};

// ---------------------------------------------------------------------------
// Lean body fixtures — only author fields, NO UUIDs / derived counts
// ---------------------------------------------------------------------------

/** Lean definition_sentence body: only content_type + text. */
const LEAN_DEFINITION_BODY = {
  content_type: "definition",
  text: "EMORA is an AI companion app featuring emotional memory.",
  // NOTE: NO meaning_key — that is derived code-side from phrasingGroupId
};

/** Lean answer_block body in English: only content_type + text. */
const LEAN_ANSWER_BLOCK_BODY_EN = {
  content_type: "answer_block",
  // ~150 words (within the [134,167] band)
  text: "EMORA is an AI companion application designed to build long-term emotional connections with users. Unlike conventional chatbots, EMORA tracks emotional states across conversations, adapting its communication style to the user's current mood and history. The app supports multilingual interactions in over eighteen languages, making it accessible to a global audience. EMORA uses advanced voice chat capabilities alongside deep emotion-tracking algorithms to provide meaningful support for young adults seeking companionship. The product is positioned as a solution for people experiencing loneliness, offering a conversational partner that remembers past interactions. Users report feeling understood and supported through regular engagement. The platform competes with Character AI and Replika by emphasising long-term memory depth and native multilingual fluency, rather than simple single-session exchanges.",
  // NOTE: NO length_units, NO numeric_claim_ids, NO source_ids
};

/** Lean answer_block body in Japanese: only content_type + text. */
const LEAN_ANSWER_BLOCK_BODY_JA = {
  content_type: "answer_block",
  // Japanese text — character count is within the CJK band
  text: "EMORAは感情的な記憶機能を持つAIコンパニオンアプリです。ユーザーとの長期的な関係を構築し、多言語でのコミュニケーションをサポートします。感情追跡機能により、ユーザーの感情状態を理解し、適切なサポートを提供します。これにより、孤独感の軽減や精神的な充実感の向上が期待できます。このアプリはCharacter AIやReplikaと比較して、長期記憶の深さと多言語対応力で差別化されています。ボイスチャット機能も充実しており、自然な会話体験を実現します。",
  // NOTE: NO length_units, NO numeric_claim_ids, NO source_ids
};

/** Lean FAQ body: only content_type + rows with q/a (no answer_claim_ids). */
const LEAN_FAQ_BODY = {
  content_type: "faq",
  rows: [
    { q: "What is EMORA?", a: "EMORA is an AI companion app with long-term emotional memory." },
    { q: "Which languages does EMORA support?", a: "EMORA supports over 18 languages natively." },
    { q: "How does EMORA differ from Replika?", a: "EMORA emphasises deep cross-session memory and multilingual fluency." },
  ],
  // NOTE: NO answer_claim_ids per row
};

/** Lean comparison body: only content_type, columns, rows with entity/cells[{value}] (no claim_id). */
const LEAN_COMPARISON_BODY = {
  content_type: "comparison",
  columns: ["Feature", "EMORA", "Character.AI"],
  rows: [
    { entity: "EMORA", cells: [{ value: "Long-term emotional memory" }, { value: "Limited session memory" }] },
    { entity: "Character.AI", cells: [{ value: "Short-term context only" }, { value: "Broad character variety" }] },
  ],
  // NOTE: NO claim_id per cell
};

/** Lean case_study body: only content_type, situation/action/result, metrics with label/before/after (no claim_id). */
const LEAN_CASE_STUDY_BODY = {
  content_type: "case_study",
  situation: "A user struggled with loneliness during remote work.",
  action: "They used EMORA daily for emotional support and journaling.",
  result: "The user reported improved wellbeing after three months.",
  metrics: [
    { label: "Loneliness score", before: "8/10", after: "4/10" },
    { label: "Daily app sessions", before: "0", after: "2" },
  ],
  // NOTE: NO claim_id per metric
};

// ---------------------------------------------------------------------------
// Adapter factories
// ---------------------------------------------------------------------------

/**
 * Build a fake adapter that returns a fixed set of items.
 * Items should have LEAN bodies matching the lean per-format schema.
 */
function makeOkAdapter(
  items: Array<{
    language: string;
    format: string;
    channel_class: string;
    phrasingGroupId: string;
    body: unknown;
  }>,
  usage: AdapterUsage = REAL_USAGE
): ContentGenerationAdapter & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    generateStructured: vi.fn(async () => {
      callCount++;
      return {
        ok: true as const,
        data: { items },
        usage,
      };
    }) as ContentGenerationAdapter["generateStructured"],
  };
}

/**
 * Build an adapter that returns NOT_CONFIGURED.
 */
function makeNotConfiguredAdapter(): ContentGenerationAdapter & {
  callCount: number;
} {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    generateStructured: vi.fn(async () => {
      callCount++;
      return { ok: false as const, code: NOT_CONFIGURED };
    }) as ContentGenerationAdapter["generateStructured"],
  };
}

/**
 * Build an adapter that returns a PARSE_FAILED error.
 */
function makeParseFailedAdapter(): ContentGenerationAdapter {
  return {
    generateStructured: vi.fn(async () => ({
      ok: false as const,
      code: "PARSE_FAILED",
      message: "Response JSON did not match the expected schema.",
      raw: null,
      usage: REAL_USAGE,
    })) as ContentGenerationAdapter["generateStructured"],
  };
}

// ---------------------------------------------------------------------------
// Tests: overGenTotal
// ---------------------------------------------------------------------------

describe("overGenTotal", () => {
  it("computes ceil(n * 1.3)", () => {
    expect(overGenTotal(1)).toBe(Math.ceil(1 * OVER_GEN_FACTOR));
    expect(overGenTotal(10)).toBe(Math.ceil(10 * OVER_GEN_FACTOR));
    expect(overGenTotal(3)).toBe(Math.ceil(3 * OVER_GEN_FACTOR));
  });
});

// ---------------------------------------------------------------------------
// Tests: buildStorageBodyWithLength (lean → storage body construction)
// ---------------------------------------------------------------------------

describe("buildStorageBodyWithLength", () => {
  it("definition_sentence: meaning_key is set to phrasingGroupId, passes ContentBodySchema", () => {
    const lean = LeanContentBodySchema.parse(LEAN_DEFINITION_BODY);
    const storageBody = buildStorageBodyWithLength(lean, "emora-definition-pg1", 0);
    const parseResult = ContentBodySchema.safeParse(storageBody);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;
    expect(parseResult.data.content_type).toBe("definition");
    if (parseResult.data.content_type === "definition") {
      expect(parseResult.data.meaning_key).toBe("emora-definition-pg1");
      expect(parseResult.data.text).toBe(LEAN_DEFINITION_BODY.text);
    }
  });

  it("answer_block: numeric_claim_ids=[], source_ids=[], length_units is the passed value, passes ContentBodySchema", () => {
    const lean = LeanContentBodySchema.parse(LEAN_ANSWER_BLOCK_BODY_EN);
    const storageBody = buildStorageBodyWithLength(lean, "some-pg", 150);
    const parseResult = ContentBodySchema.safeParse(storageBody);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;
    expect(parseResult.data.content_type).toBe("answer_block");
    if (parseResult.data.content_type === "answer_block") {
      expect(parseResult.data.length_units).toBe(150);
      expect(parseResult.data.numeric_claim_ids).toEqual([]);
      expect(parseResult.data.source_ids).toEqual([]);
      expect(parseResult.data.text).toBe(LEAN_ANSWER_BLOCK_BODY_EN.text);
    }
  });

  it("faq: rows have answer_claim_ids=[], passes ContentBodySchema", () => {
    const lean = LeanContentBodySchema.parse(LEAN_FAQ_BODY);
    const storageBody = buildStorageBodyWithLength(lean, "faq-pg1", 0);
    const parseResult = ContentBodySchema.safeParse(storageBody);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;
    expect(parseResult.data.content_type).toBe("faq");
    if (parseResult.data.content_type === "faq") {
      for (const row of parseResult.data.rows) {
        expect(row.answer_claim_ids).toEqual([]);
      }
    }
  });

  it("comparison: cells have claim_id=null, passes ContentBodySchema", () => {
    const lean = LeanContentBodySchema.parse(LEAN_COMPARISON_BODY);
    const storageBody = buildStorageBodyWithLength(lean, "comp-pg1", 0);
    const parseResult = ContentBodySchema.safeParse(storageBody);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;
    expect(parseResult.data.content_type).toBe("comparison");
    if (parseResult.data.content_type === "comparison") {
      for (const row of parseResult.data.rows) {
        for (const cell of row.cells) {
          expect(cell.claim_id).toBeNull();
        }
      }
    }
  });

  it("case_study: metrics have claim_id=null, passes ContentBodySchema", () => {
    const lean = LeanContentBodySchema.parse(LEAN_CASE_STUDY_BODY);
    const storageBody = buildStorageBodyWithLength(lean, "cs-pg1", 0);
    const parseResult = ContentBodySchema.safeParse(storageBody);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;
    expect(parseResult.data.content_type).toBe("case_study");
    if (parseResult.data.content_type === "case_study") {
      for (const metric of parseResult.data.metrics) {
        expect(metric.claim_id).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: buildContentPrompt
// ---------------------------------------------------------------------------

describe("buildContentPrompt", () => {
  it("includes the target language in the system instruction", () => {
    const cells = [makeCell("ja", "answer_block", "owned_net")];
    const { systemInstruction, userPrompt } = buildContentPrompt({
      language: "ja",
      cells,
      brief: BRIEF,
      totalItemsRequested: 2,
    });
    // Must mention the language in the instruction
    expect(systemInstruction).toContain("ja");
    expect(userPrompt).toContain("ja");
  });

  it("includes brand name and category descriptors", () => {
    const cells = [makeCell("en", "definition_sentence", "owned_net")];
    const { userPrompt } = buildContentPrompt({
      language: "en",
      cells,
      brief: BRIEF,
      totalItemsRequested: 2,
    });
    expect(userPrompt).toContain("EMORA");
    expect(userPrompt).toContain("AI companion app");
  });

  it("includes format descriptor for answer_block", () => {
    const cells = [makeCell("ko", "answer_block", "pr_wire")];
    const { userPrompt } = buildContentPrompt({
      language: "ko",
      cells,
      brief: BRIEF,
      totalItemsRequested: 2,
    });
    expect(userPrompt).toContain("answer_block");
    // Should reference the channel
    expect(userPrompt).toContain("pr_wire");
  });

  it("includes competitor names", () => {
    const cells = [makeCell("en", "comparison_table", "owned_net")];
    const { userPrompt } = buildContentPrompt({
      language: "en",
      cells,
      brief: BRIEF,
      totalItemsRequested: 2,
    });
    // Either the alias or the name should appear
    expect(userPrompt).toMatch(/character\.ai|Character\.AI|Replika/i);
  });

  it("includes DO NOT translate instruction", () => {
    const cells = [makeCell("ja", "faq_table", "directory")];
    const { systemInstruction } = buildContentPrompt({
      language: "ja",
      cells,
      brief: BRIEF,
      totalItemsRequested: 3,
    });
    expect(systemInstruction).toMatch(/DO NOT translate/i);
  });

  it("batches multiple formats in the user prompt", () => {
    const cells = [
      makeCell("en", "definition_sentence", "owned_net"),
      makeCell("en", "answer_block", "owned_net"),
      makeCell("en", "faq_table", "pr_wire"),
    ];
    const { userPrompt } = buildContentPrompt({
      language: "en",
      cells,
      brief: BRIEF,
      totalItemsRequested: 4,
    });
    expect(userPrompt).toContain("definition_sentence");
    expect(userPrompt).toContain("answer_block");
    expect(userPrompt).toContain("faq_table");
  });

  it("lean prompt does NOT ask for claim_id or numeric_claim_ids in body", () => {
    const cells = [makeCell("en", "answer_block", "owned_net")];
    const { systemInstruction } = buildContentPrompt({
      language: "en",
      cells,
      brief: BRIEF,
      totalItemsRequested: 2,
    });
    // The system instruction must NOT mention numeric_claim_ids or claim_id
    // (those are handled downstream, not by the LLM).
    expect(systemInstruction).not.toContain("numeric_claim_ids");
    expect(systemInstruction).not.toContain("claim_id");
  });
});

// ---------------------------------------------------------------------------
// Tests: generateContentForLanguage
// ---------------------------------------------------------------------------

describe("generateContentForLanguage", () => {
  // ---- Criterion 1: ONE generateStructured call PER LLM-GENERATABLE FORMAT ----

  it("makes ONE generateStructured call per distinct LLM-generatable format", async () => {
    const cells = [
      makeCell("en", "definition_sentence", "owned_net"),
      makeCell("en", "answer_block", "owned_net"),
      makeCell("en", "faq_table", "pr_wire"),
    ];
    // 3 cells with 3 different LLM-generatable formats → 3 calls

    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "definition_sentence",
        channel_class: "owned_net",
        phrasingGroupId: "def-group-1",
        body: LEAN_DEFINITION_BODY,
      },
    ]);

    await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    // ONE call PER FORMAT (3 distinct formats → 3 calls)
    expect(adapter.callCount).toBe(3);
  });

  it("makes exactly ONE call when all cells share the same format", async () => {
    const cells = [
      makeCell("en", "definition_sentence", "owned_net"),
      makeCell("en", "definition_sentence", "pr_wire"),
      makeCell("en", "definition_sentence", "directory"),
    ];
    // 3 cells, all same format → 1 call

    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "definition_sentence",
        channel_class: "owned_net",
        phrasingGroupId: "def-group-1",
        body: LEAN_DEFINITION_BODY,
      },
    ]);

    await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    // Only ONE call — all cells are the same format
    expect(adapter.callCount).toBe(1);
  });

  // ---- Criterion 2: jsonld_* cells are SKIPPED (no LLM call) ----

  it("skips jsonld_* cells entirely — no LLM call issued for them", async () => {
    const cells = [
      makeCell("en", "jsonld_org", "owned_net"),
      makeCell("en", "jsonld_faqpage", "owned_net"),
      makeCell("en", "jsonld_article", "owned_net"),
    ];

    const adapter = makeOkAdapter([]);

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    // No LLM calls — all cells were jsonld_* (handled by jsonld.ts)
    expect(adapter.callCount).toBe(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(0);
  });

  it("processes LLM-generatable cells and skips jsonld_* when mixed", async () => {
    const cells = [
      makeCell("en", "definition_sentence", "owned_net"),
      makeCell("en", "jsonld_org", "owned_net"),  // should be skipped
    ];

    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "definition_sentence",
        channel_class: "owned_net",
        phrasingGroupId: "def-group-1",
        body: LEAN_DEFINITION_BODY,
      },
    ]);

    await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    // ONE call for definition_sentence only (jsonld_org is skipped)
    expect(adapter.callCount).toBe(1);
  });

  // ---- Criterion 3: language-tag mismatch is rejected ----

  it("rejects items whose language does not match the requested language (native-gen guard)", async () => {
    const cells = [makeCell("ja", "answer_block", "owned_net")];

    // Adapter returns items — one valid Japanese, one WRONG language (covert translation)
    const adapter = makeOkAdapter([
      {
        language: "ja",
        format: "answer_block",
        channel_class: "owned_net",
        phrasingGroupId: "ja-group-1",
        body: LEAN_ANSWER_BLOCK_BODY_JA,
      },
      {
        language: "en", // WRONG — this should be rejected
        format: "answer_block",
        channel_class: "owned_net",
        phrasingGroupId: "wrong-lang-group",
        body: LEAN_ANSWER_BLOCK_BODY_EN,
      },
    ]);

    const result = await generateContentForLanguage({
      adapter,
      language: "ja",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // rawCount should be 2 (both items returned by model)
    expect(result.rawCount).toBe(2);
    // But only 1 item should survive (the "en" item is rejected)
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.language).toBe("ja");
  });

  it("returns zero items (ok:true) when ALL items have wrong language", async () => {
    const cells = [makeCell("ko", "definition_sentence", "owned_net")];

    // All items are in wrong language
    const adapter = makeOkAdapter([
      {
        language: "en", // Wrong
        format: "definition_sentence",
        channel_class: "owned_net",
        phrasingGroupId: "wrong-1",
        body: LEAN_DEFINITION_BODY,
      },
    ]);

    const result = await generateContentForLanguage({
      adapter,
      language: "ko",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(0);
    expect(result.rawCount).toBe(1); // model returned 1 but it was rejected
  });

  // ---- Criterion 4: NOT_CONFIGURED returns ok:false, never throws ----

  it("returns ok:false when adapter returns NOT_CONFIGURED (does not throw)", async () => {
    const cells = [makeCell("en", "answer_block", "owned_net")];
    const adapter = makeNotConfiguredAdapter();

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(NOT_CONFIGURED);
    expect(result.message).toContain("GEMINI_API_KEY");
    // Must NOT throw — the caller checks ok, not catch
  });

  it("does not throw when adapter throws synchronously", async () => {
    const throwingAdapter: ContentGenerationAdapter = {
      generateStructured: (async () => {
        throw new Error("Unexpected crash in adapter");
      }) as ContentGenerationAdapter["generateStructured"],
    };

    const cells = [makeCell("en", "answer_block", "owned_net")];

    // Must not throw — should return ok:false
    const result = await generateContentForLanguage({
      adapter: throwingAdapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROVIDER_ERROR");
    expect(result.message).toContain("Unexpected crash in adapter");
  });

  it("returns ok:false on PARSE_FAILED without throwing", async () => {
    const cells = [makeCell("en", "definition_sentence", "owned_net")];
    const adapter = makeParseFailedAdapter();

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PARSE_FAILED");
  });

  // ---- Criterion 5: returns real AdapterUsage for ledger/budget ----

  it("returns real AdapterUsage (not zero) from the adapter call", async () => {
    const cells = [makeCell("en", "definition_sentence", "owned_net")];
    const expectedUsage: AdapterUsage = {
      inputTokens: 800,
      outputTokens: 1500,
      usd: 0.12,
      cacheHit: false,
    };

    const adapter = makeOkAdapter(
      [
        {
          language: "en",
          format: "definition_sentence",
          channel_class: "owned_net",
          phrasingGroupId: "def-1",
          body: LEAN_DEFINITION_BODY,
        },
      ],
      expectedUsage
    );

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Usage must be the REAL adapter usage, not zeros
    expect(result.usage.inputTokens).toBe(800);
    expect(result.usage.outputTokens).toBe(1500);
    expect(result.usage.usd).toBe(0.12);
    expect(result.usage.usd).toBeGreaterThan(0);
  });

  // ---- Additional: empty cells returns immediately with zero usage ----

  it("returns ok:true with zero items and zero usage when cells is empty", async () => {
    const adapter = makeOkAdapter([]);

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells: [],
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(0);
    expect(result.rawCount).toBe(0);
    expect(result.usage.usd).toBe(0);
    // Adapter should not be called at all
    expect(adapter.callCount).toBe(0);
  });

  // ---- candidateClaims is always empty at generation time ----

  it("returns items with empty candidateClaims[] (populated downstream by claimExtract)", async () => {
    const cells = [makeCell("en", "definition_sentence", "owned_net")];

    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "definition_sentence",
        channel_class: "owned_net",
        phrasingGroupId: "def-group",
        body: LEAN_DEFINITION_BODY,
      },
    ]);

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    // candidateClaims must be empty at generation time
    const item: GeneratedContentItem = result.items[0]!;
    expect(item.candidateClaims).toEqual([]);
  });

  // ---- Lean body parse failure drops item without failing the call ----

  it("drops items with invalid lean body shapes without failing the entire call", async () => {
    const cells = [makeCell("en", "definition_sentence", "owned_net")];

    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "definition_sentence",
        channel_class: "owned_net",
        phrasingGroupId: "valid-group",
        body: LEAN_DEFINITION_BODY, // valid lean body
      },
      {
        language: "en",
        format: "definition_sentence",
        channel_class: "owned_net",
        phrasingGroupId: "invalid-group",
        body: { content_type: "definition" }, // missing required 'text' field
      },
    ]);

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // rawCount reflects ALL items returned by model
    expect(result.rawCount).toBe(2);
    // Only 1 valid item survives
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.phrasingGroupId).toBe("valid-group");
  });

  // ---- over-generation target is computed correctly ----

  it("requests totalItemsRequested = ceil(sum(targetVariants) * 1.3) items from the model", async () => {
    const cells = [
      makeCell("en", "definition_sentence", "owned_net", 2),
      makeCell("en", "answer_block", "owned_net", 3),
    ];
    // sum = 5, overGen = ceil(5 * 1.3) = 7

    let capturedPrompt = "";
    const adapter: ContentGenerationAdapter = {
      generateStructured: vi.fn(async (req) => {
        capturedPrompt = req.prompt;
        return {
          ok: true as const,
          data: { items: [] },
          usage: REAL_USAGE,
        };
      }) as ContentGenerationAdapter["generateStructured"],
    };

    await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    const expectedTotal = overGenTotal(5); // = 7
    expect(capturedPrompt).toContain(String(expectedTotal));
  });

  // ---- Criterion 11: definition_sentence with LEAN body → storage body correct ----

  it("constructs correct storage body for definition_sentence: meaning_key = phrasingGroupId", async () => {
    const cells = [makeCell("en", "definition_sentence", "owned_net")];

    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "definition_sentence",
        channel_class: "owned_net",
        phrasingGroupId: "emora-definition-pg1",
        body: LEAN_DEFINITION_BODY, // LEAN body — only text, no meaning_key
      },
    ]);

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    // Body MUST be an object with content_type: "definition"
    expect(typeof item.body).toBe("object");
    expect(item.body.content_type).toBe("definition");
    if (item.body.content_type === "definition") {
      expect(item.body.text).toBe(LEAN_DEFINITION_BODY.text);
      // meaning_key must be the phrasingGroupId, not something the LLM provided
      expect(item.body.meaning_key).toBe("emora-definition-pg1");
    }
    // Full storage body must pass ContentBodySchema
    expect(ContentBodySchema.safeParse(item.body).success).toBe(true);
  });

  // ---- Criterion 12: answer_block with LEAN body → storage body has length_units etc ----

  it("constructs correct storage body for answer_block: numeric_claim_ids=[], source_ids=[], length_units computed", async () => {
    const cells = [makeCell("en", "answer_block", "owned_net")];

    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "answer_block",
        channel_class: "owned_net",
        phrasingGroupId: "emora-answer-pg1",
        body: LEAN_ANSWER_BLOCK_BODY_EN, // LEAN — only text, no length_units/IDs
      },
    ]);

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.body.content_type).toBe("answer_block");
    if (item.body.content_type === "answer_block") {
      // length_units must be code-computed (positive integer)
      expect(item.body.length_units).toBeGreaterThan(0);
      // UUID arrays must be empty at generation time
      expect(item.body.numeric_claim_ids).toEqual([]);
      expect(item.body.source_ids).toEqual([]);
      expect(item.body.text).toBe(LEAN_ANSWER_BLOCK_BODY_EN.text);
    }
    // Full storage body must pass ContentBodySchema
    expect(ContentBodySchema.safeParse(item.body).success).toBe(true);
  });

  // ---- Criterion 13: faq with LEAN body → answer_claim_ids=[] ----

  it("constructs correct storage body for faq: answer_claim_ids=[] per row", async () => {
    const cells = [makeCell("en", "faq_table", "owned_net")];

    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "faq_table",
        channel_class: "owned_net",
        phrasingGroupId: "faq-pg1",
        body: LEAN_FAQ_BODY,
      },
    ]);

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.body.content_type).toBe("faq");
    if (item.body.content_type === "faq") {
      expect(item.body.rows).toHaveLength(3);
      for (const row of item.body.rows) {
        expect(row.answer_claim_ids).toEqual([]);
      }
    }
    expect(ContentBodySchema.safeParse(item.body).success).toBe(true);
  });

  // ---- Criterion 14: comparison_table with LEAN body → claim_id=null ----

  it("constructs correct storage body for comparison_table: claim_id=null per cell", async () => {
    const cells = [makeCell("en", "comparison_table", "owned_net")];

    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "comparison_table",
        channel_class: "owned_net",
        phrasingGroupId: "comp-pg1",
        body: LEAN_COMPARISON_BODY,
      },
    ]);

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.body.content_type).toBe("comparison");
    if (item.body.content_type === "comparison") {
      for (const row of item.body.rows) {
        for (const cell of row.cells) {
          expect(cell.claim_id).toBeNull();
        }
      }
    }
    expect(ContentBodySchema.safeParse(item.body).success).toBe(true);
  });

  // ---- Criterion 15: case_study with LEAN body → claim_id=null ----

  it("constructs correct storage body for case_study: claim_id=null per metric", async () => {
    const cells = [makeCell("en", "case_study", "owned_net")];

    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "case_study",
        channel_class: "owned_net",
        phrasingGroupId: "cs-pg1",
        body: LEAN_CASE_STUDY_BODY,
      },
    ]);

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.body.content_type).toBe("case_study");
    if (item.body.content_type === "case_study") {
      for (const metric of item.body.metrics) {
        expect(metric.claim_id).toBeNull();
      }
    }
    expect(ContentBodySchema.safeParse(item.body).success).toBe(true);
  });

  // ---- Multi-format cells: items from all formats are merged and returned ----

  it("returns items from multiple formats across per-format calls (merges results)", async () => {
    const cells = [
      makeCell("en", "definition_sentence", "owned_net"),
      makeCell("en", "answer_block", "pr_wire"),
    ];

    // Smart adapter that returns the right lean body for each call
    let callIndex = 0;
    const leanBodies: unknown[] = [
      LEAN_DEFINITION_BODY,
      LEAN_ANSWER_BLOCK_BODY_EN,
    ];
    const formats = ["definition_sentence", "answer_block"];
    const channels = ["owned_net", "pr_wire"];

    const smartAdapter: ContentGenerationAdapter & { callCount: number } = {
      callCount: 0,
      generateStructured: vi.fn(async () => {
        const body = leanBodies[callIndex % leanBodies.length]!;
        const format = formats[callIndex % formats.length]!;
        const channel_class = channels[callIndex % channels.length]!;
        callIndex++;
        smartAdapter.callCount++;
        return {
          ok: true as const,
          data: {
            items: [
              {
                language: "en",
                format,
                channel_class,
                phrasingGroupId: `group-${callIndex}`,
                body,
              },
            ],
          },
          usage: REAL_USAGE,
        };
      }) as ContentGenerationAdapter["generateStructured"],
    };

    const result = await generateContentForLanguage({
      adapter: smartAdapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2 formats → 2 calls → 2 valid items
    expect(result.items).toHaveLength(2);
    expect(smartAdapter.callCount).toBe(2);

    const resultFormats = result.items.map((i) => i.format);
    expect(resultFormats).toContain("definition_sentence");
    expect(resultFormats).toContain("answer_block");
  });

  // ---- BUG FIX: a string body is REJECTED (simulates old Gemini behavior) ----

  it("rejects items where body is a string (simulates old zodToGeminiSchema string fallback bug)", async () => {
    const cells = [makeCell("en", "definition_sentence", "owned_net")];

    // Simulate the old bug: body is a raw string (not an object)
    const adapter = makeOkAdapter([
      {
        language: "en",
        format: "definition_sentence",
        channel_class: "owned_net",
        phrasingGroupId: "bad-body",
        body: '{"content_type":"definition","text":"EMORA is..."}', // STRING — invalid
      },
    ]);

    const result = await generateContentForLanguage({
      adapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The string body must be rejected — LeanContentBodySchema requires an object
    expect(result.items).toHaveLength(0);
    // rawCount = 1 (model returned 1 item, but it was rejected)
    expect(result.rawCount).toBe(1);
  });

  // ---- Criterion 17: LEAN_GEN_SCHEMA_MAP schemas produce type:"object" ----

  it("LEAN_GEN_SCHEMA_MAP schemas produce type:\"object\" in zodToGeminiSchema (not \"string\")", () => {
    // This verifies that zodToGeminiSchema on the lean schemas always produces
    // an object type in the Gemini responseSchema, so Gemini returns structured
    // objects instead of raw strings.  This is the root cause fix.
    for (const [format, leanSchema] of Object.entries(LEAN_GEN_SCHEMA_MAP)) {
      const geminiSchema = zodToGeminiSchema(leanSchema);
      expect(
        (geminiSchema as { type?: string }).type,
        `LEAN_GEN_SCHEMA_MAP["${format}"] should produce type:"object" in zodToGeminiSchema`
      ).toBe("object");
    }
  });

  // ---- Criterion 16: Partial-return — one format's failure does not abort others ----

  it("continues to other formats when one format's call fails (partial-return resilience)", async () => {
    const cells = [
      makeCell("en", "definition_sentence", "owned_net"),
      makeCell("en", "answer_block", "pr_wire"),
    ];

    // Make the adapter fail on the first call (definition_sentence) but succeed
    // on the second (answer_block).
    let callIndex = 0;
    const partialAdapter: ContentGenerationAdapter & { callCount: number } = {
      callCount: 0,
      generateStructured: vi.fn(async () => {
        callIndex++;
        partialAdapter.callCount++;
        if (callIndex === 1) {
          // First call fails (e.g. PARSE_FAILED)
          return {
            ok: false as const,
            code: "PARSE_FAILED",
            message: "Response JSON did not match the expected schema.",
            raw: null,
            usage: REAL_USAGE,
          };
        }
        // Second call succeeds with a lean answer_block item
        return {
          ok: true as const,
          data: {
            items: [
              {
                language: "en",
                format: "answer_block",
                channel_class: "pr_wire",
                phrasingGroupId: "ans-partial-1",
                body: LEAN_ANSWER_BLOCK_BODY_EN,
              },
            ],
          },
          usage: REAL_USAGE,
        };
      }) as ContentGenerationAdapter["generateStructured"],
    };

    const result = await generateContentForLanguage({
      adapter: partialAdapter,
      language: "en",
      cells,
      brief: BRIEF,
    });

    // Should succeed with partial results (the answer_block item)
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the answer_block item (definition_sentence call failed)
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.format).toBe("answer_block");
    // Both calls were made (not short-circuited on first failure)
    expect(partialAdapter.callCount).toBe(2);
    // The answer_block storage body is valid
    expect(ContentBodySchema.safeParse(result.items[0]!.body).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// comparativeFacts injection (competitor-facts ingest → comparison tables)
// ---------------------------------------------------------------------------

describe("buildContentPromptForFormat — verified comparative facts injection", () => {
  const FACTS = [
    "Character.AI: persistent Memory system with Story Memory and Facts",
    "Replika: subscription-based companion with voice calls",
  ];

  it("injects verified facts into a comparison_table prompt with a build-only-from-these instruction", () => {
    const { userPrompt } = buildContentPromptForFormat({
      language: "en",
      format: "comparison_table",
      cells: [makeCell("en", "comparison_table", "owned_net")],
      brief: BRIEF,
      totalItemsRequested: 2,
      comparativeFacts: FACTS,
    });
    expect(userPrompt).toContain("VERIFIED COMPETITOR & BRAND FACTS");
    expect(userPrompt).toContain("Character.AI: persistent Memory system");
    expect(userPrompt).toMatch(/do not invent/i);
  });

  it("does NOT inject facts for non-comparison formats", () => {
    const { userPrompt } = buildContentPromptForFormat({
      language: "en",
      format: "answer_block",
      cells: [makeCell("en", "answer_block", "owned_net")],
      brief: BRIEF,
      totalItemsRequested: 2,
      comparativeFacts: FACTS,
    });
    expect(userPrompt).not.toContain("VERIFIED COMPETITOR & BRAND FACTS");
  });

  it("omits the block when no facts are supplied", () => {
    const { userPrompt } = buildContentPromptForFormat({
      language: "en",
      format: "comparison_table",
      cells: [makeCell("en", "comparison_table", "owned_net")],
      brief: BRIEF,
      totalItemsRequested: 2,
    });
    expect(userPrompt).not.toContain("VERIFIED COMPETITOR & BRAND FACTS");
  });
});
