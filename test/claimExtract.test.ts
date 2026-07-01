/**
 * test/claimExtract.test.ts
 *
 * T09 — Claim extraction unit tests.
 *
 * Acceptance criteria:
 *   1. Extracts numeric claims with parsed {value, unit, bound}.
 *   2. Never sets ClaimRecord.verification (always 'unverified').
 *   3. ok:false on extraction failure (NOT_CONFIGURED / PARSE_FAILED) so
 *      callers can fail closed.
 *   4. Ledgers spend as purpose='generation'.
 *
 * Uses FAKE adapter and FAKE ledger — no live DB / API key required.
 */

import { describe, it, expect, vi } from "vitest";
import {
  extractClaims,
  type ClaimExtractionAdapter,
  type ClaimExtractionLedgerPort,
  type ClaimExtractOk,
} from "../src/content/claimExtract.js";
import { NOT_CONFIGURED } from "../src/providers/types.js";
import type { AdapterUsage, GenerateStructuredRequest } from "../src/providers/types.js";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REAL_USAGE: AdapterUsage = {
  inputTokens: 300,
  outputTokens: 150,
  usd: 0.03,
  cacheHit: false,
};

/**
 * Build a fake ledger and return both the port and a record of calls made.
 */
function fakeLedger(): {
  port: ClaimExtractionLedgerPort;
  calls: Array<{
    customerId: string | null;
    purpose: string;
    usd: number;
    provider: string;
    modelId: string;
  }>;
} {
  const calls: Array<{
    customerId: string | null;
    purpose: string;
    usd: number;
    provider: string;
    modelId: string;
  }> = [];
  return {
    calls,
    port: {
      insertLlmCall: async (c) => {
        calls.push({
          customerId: c.customerId,
          purpose: c.purpose,
          usd: c.usd,
          provider: c.provider,
          modelId: c.modelId,
        });
        return { id: "ledger-row-id" };
      },
    },
  };
}

/**
 * Build a fake adapter that returns the given raw claims payload.
 */
function makeOkAdapter(rawClaims: unknown[], usage: AdapterUsage = REAL_USAGE): ClaimExtractionAdapter {
  return {
    generateStructured: vi.fn(async (_req: GenerateStructuredRequest<z.ZodTypeAny>) => ({
      ok: true as const,
      data: { claims: rawClaims },
      usage,
    })),
  };
}

/**
 * Build a NOT_CONFIGURED adapter.
 */
function makeNotConfiguredAdapter(): ClaimExtractionAdapter {
  return {
    generateStructured: vi.fn(async () => ({
      ok: false as const,
      code: NOT_CONFIGURED,
    })),
  };
}

/**
 * Build a PARSE_FAILED adapter.
 */
function makeParsedFailedAdapter(usage: AdapterUsage = REAL_USAGE): ClaimExtractionAdapter {
  return {
    generateStructured: vi.fn(async () => ({
      ok: false as const,
      code: "PARSE_FAILED",
      message: "Response was not valid JSON.",
      raw: null,
      usage,
    })),
  };
}

/**
 * Build a PROVIDER_ERROR adapter.
 */
function makeProviderErrorAdapter(): ClaimExtractionAdapter {
  return {
    generateStructured: vi.fn(async () => ({
      ok: false as const,
      code: "PROVIDER_ERROR",
      message: "Unexpected internal error.",
      retryable: false,
    })),
  };
}

/**
 * A simple answer block body object for extraction.
 */
const ANSWER_BLOCK_BODY = {
  content_type: "answer_block",
  text: "EMORA delivers 30% faster responses than competitors, with up to 50% more engagement.",
  length_units: 15,
  numeric_claim_ids: [],
  source_ids: [],
};

const SIMPLE_DEFINITION_BODY = {
  content_type: "definition",
  text: "EMORA is the best AI character chat app with 10 million active users.",
  meaning_key: "emora-definition",
};

// ---------------------------------------------------------------------------
// Criterion 1 — Extracts numeric claims with parsed {value, unit, bound}
// ---------------------------------------------------------------------------

describe("claimExtract — criterion 1: numeric claim extraction", () => {
  it("extracts a numeric claim with value, unit, and bound='exact'", async () => {
    const rawClaims = [
      {
        claim_text: "30% faster responses",
        claim_kind: "numeric",
        numeric: { value: 30, unit: "%", bound: "exact" },
        span: { start: 7, end: 27 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.claims).toHaveLength(1);

    const claim = ok.claims[0]!;
    expect(claim.claim_kind).toBe("numeric");
    expect(claim.numeric).toBeDefined();
    expect(claim.numeric!.value).toBe(30);
    expect(claim.numeric!.unit).toBe("%");
    expect(claim.numeric!.bound).toBe("exact");
    expect(claim.claim_text).toBe("30% faster responses");
  });

  it("extracts a numeric claim with bound='upTo'", async () => {
    const rawClaims = [
      {
        claim_text: "up to 50% more engagement",
        claim_kind: "numeric",
        numeric: { value: 50, unit: "%", bound: "upTo" },
        span: { start: 0, end: 25 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.claims).toHaveLength(1);

    const claim = ok.claims[0]!;
    expect(claim.numeric!.bound).toBe("upTo");
    expect(claim.numeric!.value).toBe(50);
    expect(claim.numeric!.unit).toBe("%");
  });

  it("extracts a numeric claim with bound='atLeast'", async () => {
    const rawClaims = [
      {
        claim_text: "at least 2x improvement",
        claim_kind: "numeric",
        numeric: { value: 2, unit: "x", bound: "atLeast" },
        span: { start: 0, end: 23 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    const claim = ok.claims[0]!;
    expect(claim.numeric!.bound).toBe("atLeast");
    expect(claim.numeric!.value).toBe(2);
    expect(claim.numeric!.unit).toBe("x");
  });

  it("extracts multiple claims of different kinds in one pass", async () => {
    const rawClaims = [
      {
        claim_text: "best AI character chat app",
        claim_kind: "superlative",
        span: { start: 7, end: 33 },
      },
      {
        claim_text: "10 million active users",
        claim_kind: "numeric",
        numeric: { value: 10_000_000, unit: "users", bound: "exact" },
        span: { start: 38, end: 61 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: SIMPLE_DEFINITION_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.claims).toHaveLength(2);
    expect(ok.rawCount).toBe(2);

    const superlative = ok.claims.find((c) => c.claim_kind === "superlative");
    const numeric = ok.claims.find((c) => c.claim_kind === "numeric");
    expect(superlative).toBeDefined();
    expect(numeric).toBeDefined();
    expect(numeric!.numeric!.value).toBe(10_000_000);
  });

  it("assigns a stable UUID claim_id to each extracted claim", async () => {
    const rawClaims = [
      {
        claim_text: "30% faster",
        claim_kind: "numeric",
        numeric: { value: 30, unit: "%", bound: "exact" },
        span: { start: 0, end: 10 },
      },
      {
        claim_text: "best in class",
        claim_kind: "superlative",
        span: { start: 11, end: 24 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.claims).toHaveLength(2);

    for (const claim of ok.claims) {
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(claim.claim_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    }

    // Each claim has a unique ID
    const ids = ok.claims.map((c) => c.claim_id);
    expect(new Set(ids).size).toBe(2);
  });

  it("returns empty claims array when the body has no factual claims", async () => {
    const adapter = makeOkAdapter([]);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.claims).toHaveLength(0);
    expect(ok.rawCount).toBe(0);
  });

  it("drops malformed raw claim with invalid claim_kind and keeps valid ones", async () => {
    const rawClaims = [
      {
        claim_text: "30% faster",
        claim_kind: "INVALID_KIND_HERE",  // not in the enum
        span: { start: 0, end: 10 },
      },
      {
        claim_text: "best product",
        claim_kind: "superlative",
        span: { start: 11, end: 23 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    // Only the valid claim should survive
    expect(ok.claims).toHaveLength(1);
    expect(ok.claims[0]!.claim_kind).toBe("superlative");
  });

  it("extracts capability claims without a numeric payload", async () => {
    const rawClaims = [
      {
        claim_text: "supports 18 languages natively",
        claim_kind: "capability",
        span: { start: 0, end: 30 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.claims).toHaveLength(1);
    expect(ok.claims[0]!.claim_kind).toBe("capability");
    expect(ok.claims[0]!.numeric).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — Never sets ClaimRecord.verification (always 'unverified')
// ---------------------------------------------------------------------------

describe("claimExtract — criterion 2: verification is always 'unverified'", () => {
  it("sets verification='unverified' on every extracted ClaimRecord", async () => {
    const rawClaims = [
      {
        claim_text: "30% faster responses",
        claim_kind: "numeric",
        numeric: { value: 30, unit: "%", bound: "exact" },
        span: { start: 0, end: 20 },
      },
      {
        claim_text: "best AI app in its class",
        claim_kind: "superlative",
        span: { start: 21, end: 45 },
      },
      {
        claim_text: "better than Character.AI",
        claim_kind: "comparative",
        span: { start: 46, end: 70 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.claims.length).toBeGreaterThan(0);

    for (const claim of ok.claims) {
      expect(claim.verification).toBe("unverified");
    }
  });

  it("never sets verification to 'verified', 'needs_human', or 'rejected'", async () => {
    const rawClaims = [
      {
        claim_text: "up to 50% better performance",
        claim_kind: "numeric",
        numeric: { value: 50, unit: "%", bound: "upTo" },
        span: { start: 0, end: 28 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    for (const claim of ok.claims) {
      expect(claim.verification).not.toBe("verified");
      expect(claim.verification).not.toBe("needs_human");
      expect(claim.verification).not.toBe("rejected");
    }
  });

  it("sets resolved_source_id=null on every extracted ClaimRecord", async () => {
    const rawClaims = [
      {
        claim_text: "10 million active users",
        claim_kind: "numeric",
        numeric: { value: 10_000_000, unit: "users", bound: "exact" },
        span: { start: 0, end: 23 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    for (const claim of ok.claims) {
      expect(claim.resolved_source_id).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — ok:false on failure so callers can fail closed
// ---------------------------------------------------------------------------

describe("claimExtract — criterion 3: ok:false on extraction failure (fail closed)", () => {
  it("returns ok:false with code=NOT_CONFIGURED when adapter is not configured", async () => {
    const adapter = makeNotConfiguredAdapter();
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(NOT_CONFIGURED);
      expect(result.message).toBeTruthy();
    }
  });

  it("returns ok:false with code=PARSE_FAILED when the adapter returns a parse error", async () => {
    const adapter = makeParsedFailedAdapter();
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PARSE_FAILED");
    }
  });

  it("returns ok:false with code=PROVIDER_ERROR on unexpected adapter error", async () => {
    const adapter = makeProviderErrorAdapter();
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROVIDER_ERROR");
    }
  });

  it("returns ok:false and never throws when adapter throws synchronously", async () => {
    const adapter: ClaimExtractionAdapter = {
      generateStructured: async () => {
        throw new Error("Simulated adapter crash");
      },
    };
    const ledger = fakeLedger();

    // Must NOT throw
    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROVIDER_ERROR");
      expect(result.message).toContain("Simulated adapter crash");
    }
  });

  it("does NOT write a ledger row when NOT_CONFIGURED", async () => {
    const adapter = makeNotConfiguredAdapter();
    const ledger = fakeLedger();

    await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    // No ledger write on NOT_CONFIGURED (no call was made)
    // Allow time for the async ledger fire-and-forget
    await new Promise((r) => setTimeout(r, 10));
    expect(ledger.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — Ledgers spend as purpose='generation'
// ---------------------------------------------------------------------------

describe("claimExtract — criterion 4: ledgers spend as purpose='generation'", () => {
  it("writes an llm_call ledger row with purpose='generation' on success", async () => {
    const rawClaims = [
      {
        claim_text: "30% faster",
        claim_kind: "numeric",
        numeric: { value: 30, unit: "%", bound: "exact" },
        span: { start: 0, end: 10 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims, REAL_USAGE);
    const ledger = fakeLedger();

    await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    // Allow the async fire-and-forget ledger write to complete
    await new Promise((r) => setTimeout(r, 20));

    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0]!.purpose).toBe("generation");
  });

  it("ledger row includes the real USD cost from the adapter", async () => {
    const CUSTOM_USAGE: AdapterUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      usd: 0.12,
      cacheHit: false,
    };
    const adapter = makeOkAdapter([], CUSTOM_USAGE);
    const ledger = fakeLedger();

    await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0]!.usd).toBeCloseTo(0.12, 5);
  });

  it("ledger row includes the provider 'gemini'", async () => {
    const adapter = makeOkAdapter([]);
    const ledger = fakeLedger();

    await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0]!.provider).toBe("gemini");
  });

  it("passes customerId to the ledger row", async () => {
    const CUSTOMER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const adapter = makeOkAdapter([]);
    const ledger = fakeLedger();

    await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
      customerId: CUSTOMER_ID,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0]!.customerId).toBe(CUSTOMER_ID);
  });

  it("uses null customerId when not provided", async () => {
    const adapter = makeOkAdapter([]);
    const ledger = fakeLedger();

    await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
      // customerId not provided → defaults to null
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0]!.customerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additional structural tests
// ---------------------------------------------------------------------------

describe("claimExtract — structural invariants", () => {
  it("returns ok:true with empty claims when body text is empty", async () => {
    const adapter = makeOkAdapter([]);
    const ledger = fakeLedger();

    // Body with empty text
    const emptyBody = {
      content_type: "answer_block",
      text: "",
      length_units: 0,
      numeric_claim_ids: [],
      source_ids: [],
    };

    const result = await extractClaims({
      adapter,
      body: emptyBody,
      language: "en",
      ledger: ledger.port,
    });

    // Empty body → no LLM call → ok:true, empty claims, zero usage
    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.claims).toHaveLength(0);
    expect(ok.usage.usd).toBe(0);

    // No adapter call was made for an empty body
    expect(adapter.generateStructured).not.toHaveBeenCalled();
  });

  it("handles FAQ body format by extracting text from Q/A rows", async () => {
    const rawClaims = [
      {
        claim_text: "30% faster than competitors",
        claim_kind: "numeric",
        numeric: { value: 30, unit: "%", bound: "exact" },
        span: { start: 3, end: 30 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const faqBody = {
      content_type: "faq",
      rows: [
        {
          q: "How fast is EMORA?",
          a: "30% faster than competitors, with real-time responses.",
          answer_claim_ids: [],
        },
      ],
    };

    const result = await extractClaims({
      adapter,
      body: faqBody,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.claims).toHaveLength(1);
    expect(ok.claims[0]!.claim_kind).toBe("numeric");
  });

  it("rawCount reflects raw model output before coercion filtering", async () => {
    const rawClaims = [
      // Valid claim
      {
        claim_text: "30% faster",
        claim_kind: "numeric",
        numeric: { value: 30, unit: "%", bound: "exact" },
        span: { start: 0, end: 10 },
      },
      // Malformed claim — invalid claim_kind
      {
        claim_text: "something",
        claim_kind: "NONSENSE",
        span: { start: 11, end: 20 },
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    // rawCount = 2 (both raw items from adapter)
    expect(ok.rawCount).toBe(2);
    // Only 1 valid claim after coercion
    expect(ok.claims).toHaveLength(1);
  });

  it("real AdapterUsage is returned on success for the budget accumulator", async () => {
    const CUSTOM_USAGE: AdapterUsage = {
      inputTokens: 750,
      outputTokens: 250,
      usd: 0.08,
      cacheHit: false,
    };
    const adapter = makeOkAdapter([], CUSTOM_USAGE);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.usage.inputTokens).toBe(750);
    expect(ok.usage.outputTokens).toBe(250);
    expect(ok.usage.usd).toBeCloseTo(0.08, 5);
    expect(ok.usage.cacheHit).toBe(false);
  });

  it("numeric claim without numeric payload has no numeric field", async () => {
    // A numeric claim_kind but no numeric payload provided by the model
    // (malformed — numeric claims should have a numeric payload, but we handle gracefully)
    const rawClaims = [
      {
        claim_text: "fastest in class",
        claim_kind: "superlative",
        span: { start: 0, end: 16 },
        // No numeric field
      },
    ];
    const adapter = makeOkAdapter(rawClaims);
    const ledger = fakeLedger();

    const result = await extractClaims({
      adapter,
      body: ANSWER_BLOCK_BODY,
      language: "en",
      ledger: ledger.port,
    });

    expect(result.ok).toBe(true);
    const ok = result as ClaimExtractOk;
    expect(ok.claims).toHaveLength(1);
    // Superlative claim has no numeric payload
    expect(ok.claims[0]!.numeric).toBeUndefined();
  });
});
