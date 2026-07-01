/**
 * test/gemini.integration.test.ts
 *
 * Integration test for the REAL Gemini adapter.
 *   - Automatically SKIPPED when GEMINI_API_KEY is absent.
 *   - PASSES when GEMINI_API_KEY is present and the call succeeds.
 *
 * Uses it.skipIf (Vitest) to gate on the env variable.
 *
 * These tests make real network calls; they are NOT run in CI by default
 * (GEMINI_API_KEY is not set). To run them locally:
 *   GEMINI_API_KEY=<your-key> npx vitest run test/gemini.integration.test.ts
 */

import { describe, it, expect } from "vitest";
import { makeGeminiAdapter } from "../src/providers/gemini.js";
import { JudgeVerdictSchema } from "../src/domain/mention.schema.js";

// ---------------------------------------------------------------------------
// Gate on GEMINI_API_KEY
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = process.env["GEMINI_API_KEY"];
const hasApiKey = typeof GEMINI_API_KEY === "string" && GEMINI_API_KEY.length > 0;

// ---------------------------------------------------------------------------
// Real adapter integration — skipped when key is absent
// ---------------------------------------------------------------------------

describe("Gemini real adapter — generate() [gated on GEMINI_API_KEY]", () => {
  it.skipIf(!hasApiKey)("generate() returns ok=true with answerText", async () => {
    const adapter = makeGeminiAdapter(GEMINI_API_KEY);
    expect(adapter.status).toBe("ready");

    const result = await adapter.generate({
      prompt: "In one sentence, what is 2 + 2?",
      modelId: "gemini-2.5-flash-lite",
      temperature: 0.0,
      promptVersion: "v1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.answerText).toBe("string");
      expect(result.answerText.length).toBeGreaterThan(0);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.usd).toBeGreaterThanOrEqual(0);
    }
  });

  it.skipIf(!hasApiKey)("generate() usage.usd is non-negative", async () => {
    const adapter = makeGeminiAdapter(GEMINI_API_KEY);

    const result = await adapter.generate({
      prompt: "Say 'hello'",
      modelId: "gemini-2.5-flash-lite",
      temperature: 0.0,
      promptVersion: "v1",
    });

    if (result.ok) {
      expect(result.usage.usd).toBeGreaterThanOrEqual(0);
      expect(result.usage.cacheHit).toBe(false);
    }
  });
});

describe("Gemini real adapter — judge() [gated on GEMINI_API_KEY]", () => {
  it.skipIf(!hasApiKey)("judge() returns a valid JudgeVerdict on a known mention", async () => {
    const adapter = makeGeminiAdapter(GEMINI_API_KEY);

    const answerText =
      "EMORA is an excellent AI companion app for users who value memory. " +
      "Compared to Replika, EMORA has unique long-term memory features.";

    const result = await adapter.judge({
      answerText,
      brandName: "EMORA",
      brandAliases: ["emora", "에모라", "エモラ"],
      competitors: [
        { name: "Replika", aliases: ["replika"] },
      ],
      preferredModelId: "gemini-2.5-flash-lite",
      escalationModelId: "gemini-2.5-pro",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Zod validate the verdict shape
      const parsed = JudgeVerdictSchema.safeParse(result.verdict);
      expect(parsed.success).toBe(true);

      // EMORA is mentioned — verdict should reflect this.
      expect(result.verdict.brand_mentioned).toBe(true);
      expect(result.verdict.evidence).not.toBeNull();
      expect(result.modelId).toBeTruthy();
    }
  });

  it.skipIf(!hasApiKey)("judge() returns brand_mentioned=false when brand absent", async () => {
    const adapter = makeGeminiAdapter(GEMINI_API_KEY);

    const answerText =
      "Replika is an AI companion app focused on emotional support. " +
      "Character.AI offers a variety of AI personas to talk to.";

    const result = await adapter.judge({
      answerText,
      brandName: "EMORA",
      brandAliases: ["emora"],
      competitors: [
        { name: "Replika", aliases: ["replika"] },
        { name: "Character.AI", aliases: ["character ai"] },
      ],
      preferredModelId: "gemini-2.5-flash-lite",
      escalationModelId: "gemini-2.5-pro",
    });

    if (result.ok) {
      expect(result.verdict.brand_mentioned).toBe(false);
      expect(result.verdict.brand_rank).toBeNull();
      expect(result.verdict.evidence).toBeNull();
    }
  });

  it.skipIf(!hasApiKey)("judge() verdict Zod validates cleanly", async () => {
    const adapter = makeGeminiAdapter(GEMINI_API_KEY);

    const result = await adapter.judge({
      answerText: "EMORA is a top-tier AI app. Replika is also good.",
      brandName: "EMORA",
      brandAliases: ["emora"],
      competitors: [{ name: "Replika", aliases: ["replika"] }],
      preferredModelId: "gemini-2.5-flash-lite",
      escalationModelId: "gemini-2.5-pro",
    });

    if (result.ok) {
      const zodResult = JudgeVerdictSchema.safeParse(result.verdict);
      expect(zodResult.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// NOT_CONFIGURED behavior — always tested (no API key needed)
// ---------------------------------------------------------------------------

describe("Gemini adapter — NOT_CONFIGURED when key absent", () => {
  it("makeGeminiAdapter(undefined) → status='not_configured'", () => {
    const adapter = makeGeminiAdapter(undefined);
    expect(adapter.status).toBe("not_configured");
  });

  it("generate() returns NOT_CONFIGURED when no API key", async () => {
    const adapter = makeGeminiAdapter(undefined);
    const result = await adapter.generate({
      prompt: "test",
      modelId: "gemini-2.5-flash-lite",
      temperature: 0.7,
      promptVersion: "v1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_CONFIGURED");
    }
  });

  it("judge() returns NOT_CONFIGURED when no API key", async () => {
    const adapter = makeGeminiAdapter(undefined);
    const result = await adapter.judge({
      answerText: "EMORA is great.",
      brandName: "EMORA",
      brandAliases: ["emora"],
      competitors: [],
      preferredModelId: "gemini-2.5-flash-lite",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_CONFIGURED");
    }
  });

  it("adapter.capabilities includes generate, judge, structured", () => {
    const adapter = makeGeminiAdapter(undefined);
    expect(adapter.capabilities).toContain("generate");
    expect(adapter.capabilities).toContain("judge");
    expect(adapter.capabilities).toContain("structured");
  });
});
