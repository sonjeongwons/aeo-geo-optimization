/**
 * src/content/claimExtract.ts
 *
 * T09 — Claim extraction (Gemini extract/classify only).
 *
 * DESIGN-phase2.md §"Claim Verification (§7#7)" — EXTRACT stage:
 *
 *   A generateStructured() pass that extracts every customer factual claim from
 *   an asset body into ClaimRecord[].  Gemini ONLY extracts/classifies —
 *   it NEVER certifies truth and NEVER sets ClaimRecord.verification (that field
 *   is always left as 'unverified' from this module; claimVerify.ts sets it).
 *
 *   Returns ok:false on NOT_CONFIGURED or parse failure so the gate
 *   (claimVerificationGate) can fail closed — never auto-pass when extraction
 *   is uncertain.
 *
 *   This pass is invoked by the gate fold AFTER the cheap structural gates
 *   (phrasingVariation, verifiableNumbers, noFakeSignals, disclosure) so that
 *   blocked assets never pay for the extraction LLM call.
 *
 *   Spend is ledgered via insertLlmCall(purpose:'generation', ...) and
 *   accumulated against the per-run QgenRunBudget (same pattern as
 *   multilingualContent.ts).
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { randomUUID } from "crypto";
import { z } from "zod";
import {
  ClaimKindSchema,
  NumericPayloadSchema,
  type ClaimRecord,
} from "./types.js";
import type {
  AdapterUsage,
  GenerateStructuredRequest,
  GenerateStructuredResult,
} from "../providers/types.js";
import { NOT_CONFIGURED } from "../providers/types.js";
import type { QgenRunBudget } from "../cost/qgenBudget.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default model for claim extraction. Deliberately DIFFERENT from the
 * gemini-2.5-flash model content generation uses: Google tracks free-tier
 * daily quota PER MODEL PER PROJECT (GenerateRequestsPerDayPerProjectPerModel
 * — observed limit 20/day on gemini-2.5-flash), so sharing one model between
 * generation and extraction meant a busy generation day silently zeroed out
 * extraction capacity too, and claimVerify.ts's fail-closed backstop then
 * routed nearly everything to needs_human with "Extraction failed". Using a
 * separate model gives extraction its own independent daily quota bucket.
 * Structured span/claim extraction doesn't need flash's extra capability —
 * the fail-closed backstop already covers any accuracy gap by routing
 * uncertain output to needs_human rather than passing it.
 */
const DEFAULT_EXTRACT_MODEL = "gemini-flash-lite-latest";

/** Extraction temperature — 0 for deterministic extraction. */
const EXTRACT_TEMPERATURE = 0;

/** Provider string written to llm_call ledger rows. */
const PROVIDER = "gemini";

// ---------------------------------------------------------------------------
// Adapter port (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal adapter interface required by extractClaims.
 * Matches ContentGenerationAdapter in generateContentForLanguage.ts.
 */
export interface ClaimExtractionAdapter {
  generateStructured<T extends z.ZodTypeAny>(
    req: GenerateStructuredRequest<T>
  ): Promise<GenerateStructuredResult<z.infer<T>>>;
}

// ---------------------------------------------------------------------------
// Ledger port (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Port for writing llm_call ledger rows.
 * In production this is insertLlmCall from repo.ts.
 * In tests it may be a no-op stub.
 */
export interface ClaimExtractionLedgerPort {
  insertLlmCall(c: {
    customerId: string | null;
    runId: string | null;
    purpose: "generation" | "judge";
    provider: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    usd: number;
    cacheHit: boolean;
    responseRawId: string | null;
  }): Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Raw extraction schema (the model's response shape)
// ---------------------------------------------------------------------------

/**
 * Raw claim item returned by the model.
 * We use a lenient schema here and coerce/validate into ClaimRecord downstream
 * so per-item failures don't abort the whole extraction call.
 *
 * Critically, 'verification' is NOT in this schema — the model is never asked
 * to certify truth; claimVerify.ts sets verification after deterministic checks.
 */
const RawExtractedClaimSchema = z.object({
  /**
   * Verbatim text of the claim as it appears in the asset body.
   * The model extracts this exactly from the source text.
   */
  claim_text: z.string().min(1),

  /**
   * Category of the claim.
   * 'numeric'      — contains a specific numeric measurement/statistic.
   * 'capability'   — describes what the product/brand can do.
   * 'superlative'  — "best", "fastest", "most", etc.
   * 'comparative'  — "better than X", "faster than Y", etc.
   */
  claim_kind: z.string().min(1), // coerced to ClaimKindSchema below

  /**
   * Numeric payload — present only for numeric claims.
   * The model parses the numeric value, unit, and bound from the claim text.
   * - bound 'exact'   → "30%"
   * - bound 'upTo'    → "up to 50%"
   * - bound 'atLeast' → "at least 2x"
   */
  numeric: z
    .object({
      value: z.number(),
      unit: z.string().min(1),
      bound: z.string().min(1), // coerced to NumericBoundSchema below
    })
    .optional(),

  /**
   * Character-offset span [start, end) of the claim text within the body.
   * Used by the backstop scan in claimVerify.ts to correlate regex matches
   * to extracted claims.
   */
  span: z.object({
    start: z.number().int().min(0),
    end: z.number().int().positive(),
  }),
});

type RawExtractedClaim = z.infer<typeof RawExtractedClaimSchema>;

/** Top-level model response schema. */
const ClaimExtractionResponseSchema = z.object({
  claims: z.array(RawExtractedClaimSchema),
});

type ClaimExtractionResponse = z.infer<typeof ClaimExtractionResponseSchema>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ClaimExtractOk {
  ok: true;
  /** Extracted and validated ClaimRecord[]. verification is always 'unverified'. */
  claims: ClaimRecord[];
  /** Raw count before coercion/validation filtering. */
  rawCount: number;
  /** Real AdapterUsage for the cost ledger. */
  usage: AdapterUsage;
}

export interface ClaimExtractError {
  ok: false;
  /**
   * Error code:
   * - NOT_CONFIGURED — GEMINI_API_KEY absent; gate should fail closed.
   * - PARSE_FAILED   — model returned unparseable JSON or schema mismatch.
   * - PROVIDER_ERROR — unexpected adapter error.
   * - RATE_LIMITED / TIMEOUT — transient errors.
   */
  code: string;
  message: string;
  /** Usage when available (may be undefined on total failure). */
  usage?: AdapterUsage;
}

export type ClaimExtractResult = ClaimExtractOk | ClaimExtractError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Zero usage sentinel for error/no-op cases. */
const ZERO_USAGE: AdapterUsage = {
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
  cacheHit: false,
};

/**
 * Valid NumericBound values for coercion.
 */
const NUMERIC_BOUND_VALUES = new Set(["exact", "upTo", "atLeast"]);

/**
 * Coerce and validate a raw extracted claim into a ClaimRecord.
 * Returns null if the item is malformed and should be dropped.
 *
 * CRITICAL: verification is ALWAYS set to 'unverified' here.
 * claimVerify.ts is the ONLY module that sets verification to other states.
 */
function coerceToClaimRecord(
  raw: RawExtractedClaim,
  bodyText: string
): ClaimRecord | null {
  // ---- Coerce claim_kind ----
  const claimKindParse = ClaimKindSchema.safeParse(raw.claim_kind);
  if (!claimKindParse.success) {
    return null;
  }
  const claim_kind = claimKindParse.data;

  // ---- Validate and coerce numeric payload ----
  let numeric: ClaimRecord["numeric"] | undefined = undefined;
  if (raw.numeric !== undefined) {
    // Coerce bound string to NumericBound enum
    if (!NUMERIC_BOUND_VALUES.has(raw.numeric.bound)) {
      // Drop numeric payload if bound is invalid; keep the claim as non-numeric
      // (claimVerify.ts backstop will flag it if needed)
    } else {
      const numericParse = NumericPayloadSchema.safeParse({
        value: raw.numeric.value,
        unit: raw.numeric.unit,
        bound: raw.numeric.bound,
      });
      if (numericParse.success) {
        numeric = numericParse.data;
      }
    }
  }

  // ---- Validate span ----
  const { start, end } = raw.span;
  if (start < 0 || end <= start) {
    return null;
  }

  // ---- Optional: clamp span to body text length for safety ----
  const safeEnd = Math.min(end, bodyText.length);
  const safeStart = Math.min(start, safeEnd);

  const record: ClaimRecord = {
    claim_id: randomUUID(),
    claim_text: raw.claim_text,
    claim_kind,
    // numeric is only set when the kind is 'numeric' AND we have a valid payload
    ...(claim_kind === "numeric" && numeric !== undefined
      ? { numeric }
      : {}),
    span: { start: safeStart, end: safeEnd },
    // CRITICAL: resolved_source_id is always null at extraction time.
    // claimVerify.ts sets this when matching to a claim_source row.
    resolved_source_id: null,
    // CRITICAL: verification is ALWAYS 'unverified' from this module.
    // Gemini extracts/classifies only — it never certifies truth.
    // claimVerify.ts is the ONLY place verification is set to other values.
    verification: "unverified",
  };

  return record;
}

/**
 * Build the extraction system instruction.
 * Instructs the model to extract and classify claims without certifying truth.
 */
function buildExtractionSystemInstruction(language: string): string {
  return `You are a factual claim extractor for content verification.

Your task: extract every customer factual claim from the provided content body text.

Language of the content: ${language}

EXTRACTION RULES:
1. Extract EVERY claim that asserts a fact about the brand, product, or service.
2. Classify each claim as one of: numeric, capability, superlative, comparative.
   - numeric: contains a specific number, percentage, count, or measurement (e.g. "30% faster", "10 million users", "up to 50% off").
   - capability: describes what the product can do (e.g. "supports 18 languages", "works offline").
   - superlative: uses "best", "fastest", "most", "leading", "top", "#1", etc.
   - comparative: compares to another entity (e.g. "better than X", "faster than competitors").
3. For numeric claims, parse the numeric value, unit, and bound:
   - bound "exact": a precise value ("30%", "10 million").
   - bound "upTo": an upper-bound value ("up to 50%", "as much as 2x").
   - bound "atLeast": a lower-bound value ("at least 30%", "over 10 million").
4. Provide the character-offset span [start, end) of each claim within the body text.
   start is inclusive, end is exclusive.

CRITICAL CONSTRAINTS:
- DO NOT evaluate whether claims are true or false.
- DO NOT add a verification or truth status — that is not your job.
- DO NOT invent claims not present in the text.
- Extract claims verbatim as they appear in the source text.
- If there are no factual claims, return an empty claims array.`;
}

/**
 * Build the extraction user prompt.
 */
function buildExtractionUserPrompt(bodyText: string): string {
  return `Extract all factual claims from the following content body:

---
${bodyText}
---

Return a JSON object with a "claims" array containing every factual claim found.`;
}

/**
 * Extract the text representation of a content body for claim extraction.
 * Different body types have different text fields.
 */
function extractBodyText(body: unknown): string {
  if (body === null || typeof body !== "object") {
    return String(body ?? "");
  }
  const b = body as Record<string, unknown>;
  const contentType = b["content_type"];

  switch (contentType) {
    case "definition": {
      return String(b["text"] ?? "");
    }
    case "answer_block": {
      return String(b["text"] ?? "");
    }
    case "faq": {
      const rows = b["rows"];
      if (!Array.isArray(rows)) return "";
      return rows
        .map((r: unknown) => {
          if (r !== null && typeof r === "object") {
            const row = r as Record<string, unknown>;
            return `Q: ${String(row["q"] ?? "")} A: ${String(row["a"] ?? "")}`;
          }
          return "";
        })
        .join("\n");
    }
    case "comparison": {
      const columns = b["columns"];
      const rows = b["rows"];
      const colStr = Array.isArray(columns)
        ? columns.map((c: unknown) => String(c)).join(" | ")
        : "";
      const rowStr = Array.isArray(rows)
        ? rows
            .map((r: unknown) => {
              if (r !== null && typeof r === "object") {
                const row = r as Record<string, unknown>;
                const cells = row["cells"];
                const cellStr = Array.isArray(cells)
                  ? cells
                      .map((c: unknown) => {
                        if (c !== null && typeof c === "object") {
                          return String((c as Record<string, unknown>)["value"] ?? "");
                        }
                        return "";
                      })
                      .join(" | ")
                  : "";
                return `${String(row["entity"] ?? "")} | ${cellStr}`;
              }
              return "";
            })
            .join("\n")
        : "";
      return [colStr, rowStr].filter(Boolean).join("\n");
    }
    case "case_study": {
      return [
        b["situation"] ? `Situation: ${String(b["situation"])}` : "",
        b["action"] ? `Action: ${String(b["action"])}` : "",
        b["result"] ? `Result: ${String(b["result"])}` : "",
        Array.isArray(b["metrics"])
          ? b["metrics"]
              .map((m: unknown) => {
                if (m !== null && typeof m === "object") {
                  const metric = m as Record<string, unknown>;
                  return `${String(metric["label"] ?? "")}: ${String(metric["before"] ?? "")} → ${String(metric["after"] ?? "")}`;
                }
                return "";
              })
              .filter(Boolean)
              .join("; ")
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "jsonld": {
      // For JSON-LD bodies, serialize the nested JSON object as text
      const json = b["json"];
      try {
        return JSON.stringify(json ?? {});
      } catch {
        return "";
      }
    }
    default:
      // Fallback: serialize the whole body
      try {
        return JSON.stringify(b);
      } catch {
        return "";
      }
  }
}

// ---------------------------------------------------------------------------
// extractClaims — main export
// ---------------------------------------------------------------------------

/**
 * Run ONE adapter.generateStructured() call to extract and classify every
 * customer factual claim from an asset body into ClaimRecord[].
 *
 * DESIGN-phase2.md §"Claim Verification (§7#7)" — EXTRACT stage.
 *
 * Key invariants:
 * 1. Gemini ONLY extracts/classifies — it NEVER certifies truth.
 * 2. ClaimRecord.verification is ALWAYS 'unverified' from this module.
 * 3. ClaimRecord.resolved_source_id is ALWAYS null from this module.
 * 4. Returns ok:false on NOT_CONFIGURED or parse failure (fail closed).
 * 5. Spend is ledgered with purpose:'generation'.
 * 6. IC-03 fix: If opts.budget is supplied, the §11 per-run ceiling is checked
 *    BEFORE the Gemini call (budget.isWithinCeiling()); if already exceeded the
 *    function returns ok:false without spending. After a successful call,
 *    budget.recordUsage(usage.usd) is called so the ceiling covers BOTH
 *    generation and extraction Gemini call types.
 *
 * @param opts.adapter      Adapter with generateStructured() (GeminiAdapter).
 * @param opts.body         Asset body (ContentBody) to extract claims from.
 * @param opts.language     BCP-47 language code of the body text.
 * @param opts.ledger       LedgerPort for writing llm_call rows.
 * @param opts.customerId   Customer UUID for the ledger row (null for owned-net).
 * @param opts.modelId      Optional model override (default: gemini-2.5-flash).
 * @param opts.budget       Optional per-run budget tracker (§11 ceiling).
 * @returns ClaimExtractResult — never throws.
 */
export async function extractClaims(opts: {
  adapter: ClaimExtractionAdapter;
  body: unknown;
  language: string;
  ledger: ClaimExtractionLedgerPort;
  customerId?: string | null;
  modelId?: string;
  budget?: QgenRunBudget;
}): Promise<ClaimExtractResult> {
  const { adapter, body, language, ledger, customerId = null, modelId = DEFAULT_EXTRACT_MODEL, budget } = opts;

  // ---- Extract text representation of the body ----
  const bodyText = extractBodyText(body);

  if (bodyText.trim().length === 0) {
    // Nothing to extract from — return empty claims (not an error)
    return {
      ok: true,
      claims: [],
      rawCount: 0,
      usage: ZERO_USAGE,
    };
  }

  // ---- IC-03: check per-run budget ceiling before spending on extraction ----
  // Mirror the pattern from multilingualContent.ts: if we are already over the
  // ceiling, stop gracefully instead of making an additional Gemini call.
  if (budget !== undefined && !budget.isWithinCeiling()) {
    return {
      ok: false,
      code: "BUDGET_CEILING_EXCEEDED",
      message:
        "Per-run budget ceiling already reached before claim extraction; skipping Gemini call (fail closed).",
      usage: ZERO_USAGE,
    };
  }

  // ---- Build prompt ----
  const systemInstruction = buildExtractionSystemInstruction(language);
  const userPrompt = buildExtractionUserPrompt(bodyText);

  // ---- Structured Gemini call ----
  const req: GenerateStructuredRequest<typeof ClaimExtractionResponseSchema> = {
    modelId,
    prompt: userPrompt,
    systemInstruction,
    temperature: EXTRACT_TEMPERATURE,
    schema: ClaimExtractionResponseSchema,
  };

  let result: GenerateStructuredResult<ClaimExtractionResponse>;
  try {
    result = await adapter.generateStructured(req);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: `Unexpected error calling generateStructured for claim extraction: ${msg}`,
      usage: ZERO_USAGE,
    };
  }

  // ---- NOT_CONFIGURED: gate should fail closed ----
  if (!result.ok && result.code === NOT_CONFIGURED) {
    return {
      ok: false,
      code: NOT_CONFIGURED,
      message:
        "GEMINI_API_KEY not configured; cannot extract claims (gate will fail closed).",
      usage: ZERO_USAGE,
    };
  }

  // ---- Other structured errors (PARSE_FAILED, RATE_LIMITED, etc.) ----
  if (!result.ok) {
    const msg =
      "message" in result && result.message
        ? result.message
        : `generateStructured failed for claim extraction with code: ${result.code}`;
    const usage = "usage" in result && result.usage ? result.usage : ZERO_USAGE;
    return { ok: false, code: result.code, message: msg, usage };
  }

  // ---- Ledger the spend (purpose:'generation') ----
  const usage = result.usage;
  ledger
    .insertLlmCall({
      customerId: customerId ?? null,
      runId: null,
      purpose: "generation",
      provider: PROVIDER,
      modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usd: usage.usd,
      cacheHit: usage.cacheHit,
      responseRawId: null,
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[claimExtract] Ledger write failed for claim extraction (non-fatal): ${msg}`
      );
    });

  // ---- IC-03: record actual spend in per-run budget accumulator (§11) ----
  // budget.recordUsage throws QgenBudgetExceededError when the ceiling is
  // crossed; we suppress it here (non-fatal for the extraction result) because
  // the caller (claimVerificationGate) will check isWithinCeiling() before the
  // NEXT extraction call. The spend has already been paid, so we keep the
  // result and let the gate complete — it is the NEXT call that will be blocked.
  if (budget !== undefined) {
    try {
      budget.recordUsage(usage.usd);
    } catch {
      // Ceiling exceeded AFTER this call — non-fatal for the current result.
      // The next extractClaims call will see isWithinCeiling() === false.
    }
  }

  // ---- Coerce raw claims to ClaimRecord[] ----
  const rawClaims = result.data.claims;
  const records: ClaimRecord[] = [];

  for (const raw of rawClaims) {
    const record = coerceToClaimRecord(raw, bodyText);
    if (record !== null) {
      records.push(record);
    }
  }

  return {
    ok: true,
    claims: records,
    rawCount: rawClaims.length,
    usage,
  };
}
