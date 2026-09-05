/**
 * test/gemini-structured.test.ts
 *
 * Unit tests for GeminiAdapter.generateStructured() (T02).
 *
 * Covers:
 *   1. NOT_CONFIGURED when apiKey is absent.
 *   2. ok=true with parsed+validated data + AdapterUsage on valid JSON response.
 *   3. PARSE_FAILED (typed error, no throw) when response JSON fails schema validation.
 *   4. PARSE_FAILED when response text is not valid JSON.
 *
 * Uses a stubbed @google/genai client — no real network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { makeGeminiAdapter } from "../src/providers/gemini.js";
import { NOT_CONFIGURED } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const TestSchema = z.object({
  name: z.string(),
  score: z.number(),
});
type TestData = z.infer<typeof TestSchema>;

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

/**
 * Build a GeminiAdapter backed by a mocked @google/genai client.
 * The mock intercepts client.models.generateContent() and returns the provided
 * fake response object.
 */
function makeAdapterWithStubClient(
  apiKey: string,
  stubResponse: Record<string, unknown>
) {
  const adapter = makeGeminiAdapter(apiKey);

  // Reach into the private _clients pool (indexed by key) to inject a stub
  // for key index 0 — this adapter is constructed with a single key, so
  // there's exactly one client slot.
  // We cast to `any` only in the test — never in production code.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = adapter as any;
  a._clients = [
    {
      models: {
        generateContent: vi.fn().mockResolvedValue(stubResponse),
      },
    },
  ];

  return adapter;
}

function makeUsageMeta(
  promptTokenCount: number,
  candidatesTokenCount: number
): Record<string, unknown> {
  return {
    usageMetadata: { promptTokenCount, candidatesTokenCount },
  };
}

// ---------------------------------------------------------------------------
// 1. NOT_CONFIGURED
// ---------------------------------------------------------------------------

describe("generateStructured — NOT_CONFIGURED", () => {
  it("returns NOT_CONFIGURED when apiKey is undefined", async () => {
    const adapter = makeGeminiAdapter(undefined);
    const result = await adapter.generateStructured!({
      modelId: "gemini-2.5-flash",
      prompt: "test",
      temperature: 0,
      schema: TestSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });

  it("returns NOT_CONFIGURED when apiKey is empty string", async () => {
    const adapter = makeGeminiAdapter("");
    const result = await adapter.generateStructured!({
      modelId: "gemini-2.5-flash",
      prompt: "test",
      temperature: 0,
      schema: TestSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. ok path — valid JSON + valid schema
// ---------------------------------------------------------------------------

describe("generateStructured — ok path", () => {
  it("returns ok=true with parsed data and AdapterUsage on valid JSON", async () => {
    const validPayload: TestData = { name: "EMORA", score: 95 };
    const stubResponse = {
      text: JSON.stringify(validPayload),
      ...makeUsageMeta(100, 30),
    };

    const adapter = makeAdapterWithStubClient("fake-key", stubResponse);
    const result = await adapter.generateStructured!({
      modelId: "gemini-2.5-flash",
      prompt: "Return a TestData object.",
      temperature: 0.2,
      schema: TestSchema,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(validPayload);
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(30);
      expect(result.usage.usd).toBeGreaterThanOrEqual(0);
      expect(result.usage.cacheHit).toBe(false);
    }
  });

  it("passes systemInstruction to Gemini when provided", async () => {
    const validPayload: TestData = { name: "Test", score: 42 };
    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify(validPayload),
      ...makeUsageMeta(50, 20),
    });

    const adapter = makeGeminiAdapter("fake-key");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = adapter as any;
    a._clients = [{ models: { generateContent: mockGenerateContent } }];

    await adapter.generateStructured!({
      modelId: "gemini-2.5-flash",
      prompt: "Return data.",
      systemInstruction: "You are a helpful assistant.",
      temperature: 0,
      schema: TestSchema,
    });

    expect(mockGenerateContent).toHaveBeenCalledOnce();
    const callArg = mockGenerateContent.mock.calls[0]?.[0] as Record<string, unknown>;
    const config = callArg?.["config"] as Record<string, unknown> | undefined;
    expect(config?.["systemInstruction"]).toBe("You are a helpful assistant.");
    expect(config?.["responseMimeType"]).toBe("application/json");
  });

  it("uses priceUsd for cost calculation on a known model", async () => {
    const validPayload: TestData = { name: "CostTest", score: 1 };
    // gemini-2.5-flash: input $0.30/Mtok, output $2.50/Mtok
    // 1,000,000 input tokens + 1,000,000 output = $0.30 + $2.50 = $2.80
    const stubResponse = {
      text: JSON.stringify(validPayload),
      ...makeUsageMeta(1_000_000, 1_000_000),
    };

    const adapter = makeAdapterWithStubClient("fake-key", stubResponse);
    const result = await adapter.generateStructured!({
      modelId: "gemini-2.5-flash",
      prompt: "test",
      temperature: 0,
      schema: TestSchema,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage.usd).toBeCloseTo(2.8, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. PARSE_FAILED — schema mismatch
// ---------------------------------------------------------------------------

describe("generateStructured — PARSE_FAILED on schema mismatch", () => {
  it("returns PARSE_FAILED when JSON is valid but fails Zod schema", async () => {
    const invalidPayload = { name: 42, score: "not-a-number" }; // wrong types
    const stubResponse = {
      text: JSON.stringify(invalidPayload),
      ...makeUsageMeta(80, 25),
    };

    const adapter = makeAdapterWithStubClient("fake-key", stubResponse);
    const result = await adapter.generateStructured!({
      modelId: "gemini-2.5-flash",
      prompt: "Return data.",
      temperature: 0,
      schema: TestSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PARSE_FAILED");
    }
  });

  it("does NOT throw — PARSE_FAILED is a typed return value", async () => {
    const stubResponse = {
      text: JSON.stringify({ unexpected: true }),
      ...makeUsageMeta(50, 10),
    };

    const adapter = makeAdapterWithStubClient("fake-key", stubResponse);

    await expect(
      adapter.generateStructured!({
        modelId: "gemini-2.5-flash",
        prompt: "test",
        temperature: 0,
        schema: TestSchema,
      })
    ).resolves.toBeDefined();
  });

  it("PARSE_FAILED carries usage so §11 cost ledger can record spend", async () => {
    const stubResponse = {
      text: JSON.stringify({ wrong: "shape" }),
      ...makeUsageMeta(120, 40),
    };

    const adapter = makeAdapterWithStubClient("fake-key", stubResponse);
    const result = await adapter.generateStructured!({
      modelId: "gemini-2.5-flash",
      prompt: "test",
      temperature: 0,
      schema: TestSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "PARSE_FAILED") {
      // usage is present in GenerateStructuredError
      expect((result as { usage?: unknown }).usage).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. PARSE_FAILED — non-JSON response
// ---------------------------------------------------------------------------

describe("generateStructured — PARSE_FAILED on non-JSON text", () => {
  it("returns PARSE_FAILED when response text is not valid JSON", async () => {
    const stubResponse = {
      text: "this is not json at all",
      ...makeUsageMeta(60, 15),
    };

    const adapter = makeAdapterWithStubClient("fake-key", stubResponse);
    const result = await adapter.generateStructured!({
      modelId: "gemini-2.5-flash",
      prompt: "test",
      temperature: 0,
      schema: TestSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PARSE_FAILED");
    }
  });

  it("returns PARSE_FAILED when response text is empty", async () => {
    const stubResponse = {
      text: "",
      ...makeUsageMeta(40, 0),
    };

    const adapter = makeAdapterWithStubClient("fake-key", stubResponse);
    const result = await adapter.generateStructured!({
      modelId: "gemini-2.5-flash",
      prompt: "test",
      temperature: 0,
      schema: TestSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PARSE_FAILED");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. generateStructured is NOT available on not_configured adapter
//    (structural test — confirms the method exists but returns NOT_CONFIGURED)
// ---------------------------------------------------------------------------

describe("generateStructured — method existence and capability declaration", () => {
  it("GeminiAdapter declares 'structured' capability", () => {
    const adapter = makeGeminiAdapter(undefined);
    expect(adapter.capabilities).toContain("structured");
  });

  it("generateStructured method is defined on the adapter", () => {
    const adapter = makeGeminiAdapter("some-key");
    expect(typeof adapter.generateStructured).toBe("function");
  });
});
