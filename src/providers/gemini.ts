/**
 * Gemini provider adapter — REAL implementation via @google/genai.
 *
 * DESIGN.md §4 / "Provider adapter contract":
 *   - generate(): uses gemini-2.5-flash-lite (cheap monitor) or gemini-2.5-flash (baseline).
 *   - judge(): forced JSON via responseMimeType:'application/json' + responseSchema
 *              derived from JudgeVerdict; temp 0; escalates to gemini-2.5-pro on PARSE_FAILED.
 *   - NOT_CONFIGURED returned (not thrown) when GEMINI_API_KEY is absent.
 *
 * DESIGN.md §11 cost: priceUsd() called with actual token counts.
 * DESIGN.md §5.4 judge: RANK_RULE_DOCSTRING woven into the judge system prompt.
 */

import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import { JudgeVerdictSchema, zodToGeminiSchema } from "../domain/mention.schema.js";
import { RANK_RULE_DOCSTRING } from "../domain/rank.js";
import { NOT_CONFIGURED } from "./types.js";
import { priceUsd } from "./pricing.js";
import type {
  ProviderAdapter,
  GenerateRequest,
  GenerateResult,
  GenerateStructuredRequest,
  GenerateStructuredResult,
  JudgeRequest,
  JudgeResult,
  AdapterUsage,
} from "./types.js";
import type { Modality, SurfaceCapability } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Judge system prompt
// ---------------------------------------------------------------------------

export function buildJudgeSystemPrompt(
  brandName: string,
  brandAliases: string[],
  competitors: Array<{ name: string; aliases: string[] }>
): string {
  const brandList = [brandName, ...brandAliases]
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

  const competitorList = competitors
    .map((c) => {
      const allNames = [c.name, ...c.aliases].filter((v, i, a) => a.indexOf(v) === i);
      return allNames.join(" / ");
    })
    .join("; ");

  return `You are an objective mention-extraction judge for AEO/GEO measurement.

Your task: analyze the answer text and extract brand mention information as structured JSON.

Brand being measured: ${brandName}
Brand name and aliases (any of these counts): ${brandList}

Tracked competitors (name / aliases): ${competitorList || "(none)"}

${RANK_RULE_DOCSTRING}

Output rules:
- brand_mentioned: true iff the brand or any alias appears in the answer text.
- brand_rank: apply the rank rule above. Null if brand not mentioned.
- sentiment: positive | neutral | negative toward the brand. Null if not mentioned. Never fabricate sentiment — use "neutral" when ambiguous.
- competitors_found: ONLY tracked competitors. Include their ranks per the rank rule. Empty array if none found.
- evidence: when brand_mentioned=true, provide the verbatim or alias-normalized span that verifies the mention (quote, start offset inclusive, end offset exclusive). Null when brand_mentioned=false.
- citation_present: true ONLY when the brand appears as a clickable/linked SOURCE or explicit attribution — a markdown link [${brandName}](http...), an HTML anchor <a href>, or a "Source:"/footnote/reference that credits the brand. A brand merely NAMED in prose is a MENTION, NOT a citation. Citation is a strict subset of mention. Default false.
- citation_url: when citation_present=true, the URL the brand is linked as/to (the href or cited source URL). Null otherwise.
- citation_quote: when citation_present=true, the anchor text / attribution span (a substring of the answer). Null otherwise.

IMPORTANT: evidence.quote and citation_quote must be substrings of (or alias-normalized from) the actual answer text. Do not fabricate evidence or citations. Do NOT mark citation_present=true just because the brand is named — there must be an actual link or explicit source attribution.`;
}

// ---------------------------------------------------------------------------
// Extract text from response
// ---------------------------------------------------------------------------

function extractText(response: { text?: string | undefined }): string | null {
  const t = response.text;
  return t !== undefined && t !== "" ? t : null;
}

/**
 * Normalize Gemini's candidate.groundingMetadata into the GroundingTrace shape
 * consumed by judge/groundingGap.ts (webSearchQueries / chunks / supports).
 * Returns a trace with empty arrays when grounding metadata is absent.
 */
export function extractGroundingTrace(response: unknown): {
  webSearchQueries: string[];
  chunks: Array<{ uri: string; title?: string }>;
  supports: Array<{ chunkIndices: number[] }>;
} {
  const r = response as {
    candidates?: Array<{
      groundingMetadata?: {
        webSearchQueries?: string[];
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        groundingSupports?: Array<{ groundingChunkIndices?: number[] }>;
      };
    }>;
  };
  const gm = r.candidates?.[0]?.groundingMetadata;
  return {
    webSearchQueries: gm?.webSearchQueries ?? [],
    // Keep chunks 1:1 with the raw Gemini groundingChunks array — do NOT filter
    // empty-uri chunks. groundingSupports.groundingChunkIndices reference RAW API
    // indices, so dropping a chunk here shifts every later index and silently
    // misaligns (or vanishes) real citations (SOTA v5 self-audit X1). Empty-uri
    // chunks map to domainForChunk("")→null downstream and are dropped there.
    chunks: (gm?.groundingChunks ?? []).map((c) => ({
      uri: c.web?.uri ?? "",
      ...(c.web?.title !== undefined ? { title: c.web.title } : {}),
    })),
    supports: (gm?.groundingSupports ?? []).map((s) => ({
      chunkIndices: s.groundingChunkIndices ?? [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Extract usage
// ---------------------------------------------------------------------------

function extractUsage(
  meta: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } | undefined },
  modelId: string,
  cacheHit: boolean
): AdapterUsage {
  const usage = meta.usageMetadata;
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;
  const actualUsd = cacheHit ? 0 : priceUsd(modelId, inputTokens, outputTokens);

  return {
    inputTokens,
    outputTokens,
    usd: actualUsd,
    cacheHit,
  };
}

// ---------------------------------------------------------------------------
// GeminiAdapter
// ---------------------------------------------------------------------------

// Free-tier / burst rate-limit backoff + multi-key rotation. The
// content-generation path has NO retry at the caller level, so a single
// 429/RESOURCE_EXHAUSTED must be absorbed here or it fails the unit
// (validation_failed).
//
// With ONE key: on rate-limit, wait and retry (the per-minute free-tier
// quota resets), degrading a free-tier key to SLOWER rather than FAILING.
// With MULTIPLE keys (GEMINI_API_KEYS, from separate Google Cloud
// projects/accounts — quota is per-project, not per-key): on rate-limit,
// retry on the NEXT key IMMEDIATELY (no wait) before falling back to a
// backoff wait once every key is rate-limited in the same round. This
// multiplies effective RPM by the number of distinct-project keys instead
// of just spending the wait budget on one key.
// Bounded so a hard daily-quota exhaustion (on every key) still gives up
// instead of hanging forever.
const _RL_RE = /\brate[\s_-]?limit|\b429\b|\bquota\b|resource[\s_-]?exhausted|too many requests/i;
const RL_MAX_RETRIES = Number(process.env["GEMINI_RATE_LIMIT_RETRIES"] ?? "3");
const RL_BASE_MS = Number(process.env["GEMINI_RATE_LIMIT_BASE_MS"] ?? "20000");

export class GeminiAdapter implements ProviderAdapter {
  readonly provider = "gemini";
  readonly modality: Modality = "chat";
  readonly capabilities: SurfaceCapability[] = ["generate", "judge", "structured"];

  private readonly _apiKeys: string[];
  private readonly _clients: (GoogleGenAI | null)[];
  private _cursor = 0;

  constructor(apiKeys: string | string[] | undefined) {
    const list = Array.isArray(apiKeys) ? apiKeys : apiKeys ? [apiKeys] : [];
    this._apiKeys = list.filter((k) => k.length > 0);
    this._clients = this._apiKeys.map(() => null);
  }

  get status(): "ready" | "stub" | "not_configured" {
    return this._apiKeys.length > 0 ? "ready" : "not_configured";
  }

  private _clientAt(i: number): GoogleGenAI {
    const existing = this._clients[i];
    if (existing) return existing;
    const client = new GoogleGenAI({ apiKey: this._apiKeys[i]! });
    this._clients[i] = client;
    return client;
  }

  /**
   * Call `fn` against one of the configured keys, rotating round-robin and
   * failing over to the next key on a rate-limit error before waiting.
   * Single-key deployments behave exactly as the old retryOnRateLimit did.
   */
  private async _call<T>(fn: (client: GoogleGenAI) => Promise<T>): Promise<T> {
    const n = this._apiKeys.length;
    let lastErr: unknown;
    for (let round = 0; round <= RL_MAX_RETRIES; round++) {
      for (let i = 0; i < n; i++) {
        const idx = (this._cursor + i) % n;
        try {
          const result = await fn(this._clientAt(idx));
          this._cursor = (idx + 1) % n;
          return result;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (!_RL_RE.test(msg)) throw err;
          // Rate-limited on this key — try the next key immediately, no wait.
        }
      }
      if (round >= RL_MAX_RETRIES) break;
      const waitMs = Math.min(60_000, RL_BASE_MS * 2 ** round);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    throw lastErr;
  }

  // -------------------------------------------------------------------------
  // generate()
  // -------------------------------------------------------------------------

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (this._apiKeys.length === 0) {
      return { ok: false, code: NOT_CONFIGURED };
    }

    // Web grounding (SOTA v3): enable the Google Search tool when the request
    // opts in (req.grounded) OR the global GEMINI_GROUNDING env toggle is on.
    // Off by default — it bills the Search tool and changes WHAT is measured.
    const grounded = req.grounded === true || process.env["GEMINI_GROUNDING"] === "on";

    try {
      const response = await this._call((client) => client.models.generateContent({
        model: req.modelId,
        contents: req.prompt,
        config: {
          temperature: req.temperature,
          ...(grounded ? { tools: [{ googleSearch: {} }] } : {}),
        },
      }));

      const answerText = extractText(response);
      if (answerText === null) {
        return {
          ok: false,
          code: "PROVIDER_ERROR",
          message: "Gemini returned an empty response.",
          retryable: false,
          usage: extractUsage(response, req.modelId, false),
        };
      }

      const usage = extractUsage(response, req.modelId, false);

      return {
        ok: true,
        answerText,
        usage,
        meta: {
          modelVersion: (response as { modelVersion?: string }).modelVersion ?? req.modelId,
          promptTokenCount: response.usageMetadata?.promptTokenCount,
          candidatesTokenCount: response.usageMetadata?.candidatesTokenCount,
          // Retrieval trace — present only when grounding is enabled. Normalized
          // to the GroundingTrace shape consumed by judge/groundingGap.ts.
          ...(grounded ? { grounding: extractGroundingTrace(response) } : {}),
        },
      };
    } catch (err: unknown) {
      return _mapGenerateError(err);
    }
  }

  // -------------------------------------------------------------------------
  // judge()
  // -------------------------------------------------------------------------

  async judge(req: JudgeRequest): Promise<JudgeResult> {
    if (this._apiKeys.length === 0) {
      return { ok: false, code: NOT_CONFIGURED };
    }

    const systemPrompt = buildJudgeSystemPrompt(
      req.brandName,
      req.brandAliases,
      req.competitors
    );

    const userPrompt = `Answer text to judge:\n\n${req.answerText}`;

    const geminiSchema = zodToGeminiSchema(JudgeVerdictSchema);

    const call = this._call.bind(this);

    // First attempt: preferred model (cheap)
    const firstResult = await _callJudge(
      call,
      req.preferredModelId,
      systemPrompt,
      userPrompt,
      geminiSchema
    );

    if (firstResult.ok) return firstResult;

    // If parse failed and we have an escalation model, try once with pro
    if (
      firstResult.code === "PARSE_FAILED" &&
      req.escalationModelId &&
      req.escalationModelId !== req.preferredModelId
    ) {
      const escalationResult = await _callJudge(
        call,
        req.escalationModelId,
        systemPrompt,
        userPrompt,
        geminiSchema
      );
      return escalationResult;
    }

    return firstResult;
  }

  // -------------------------------------------------------------------------
  // generateStructured()  (T02 — Phase 1 forced-JSON seam)
  // -------------------------------------------------------------------------

  /**
   * Call Gemini with responseMimeType:'application/json' + responseSchema derived
   * from the caller-supplied Zod schema; parse + safeParse the result.
   *
   * Returns NOT_CONFIGURED when no API key is present.
   * Returns PARSE_FAILED (typed error, does not throw) on invalid JSON or
   * schema mismatch.
   */
  async generateStructured<T extends z.ZodTypeAny>(
    req: GenerateStructuredRequest<T>
  ): Promise<GenerateStructuredResult<z.infer<T>>> {
    if (this._apiKeys.length === 0) {
      return { ok: false, code: NOT_CONFIGURED };
    }

    const geminiSchema = zodToGeminiSchema(req.schema);

    try {
      const response = await this._call((client) => client.models.generateContent({
        model: req.modelId,
        contents: req.prompt,
        config: {
          temperature: req.temperature,
          ...(req.systemInstruction !== undefined
            ? { systemInstruction: req.systemInstruction }
            : {}),
          responseMimeType: "application/json",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          responseSchema: geminiSchema as any,
        },
      }));

      const usage = extractUsage(response, req.modelId, false);
      const rawText = extractText(response);

      if (!rawText) {
        return {
          ok: false,
          code: "PARSE_FAILED",
          message: "Gemini returned an empty structured response.",
          raw: null,
          usage,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return {
          ok: false,
          code: "PARSE_FAILED",
          message: "Response was not valid JSON.",
          raw: rawText,
          usage,
        };
      }

      const validation = req.schema.safeParse(parsed);
      if (!validation.success) {
        return {
          ok: false,
          code: "PARSE_FAILED",
          message: "Response JSON did not match the expected schema.",
          raw: parsed,
          usage,
        };
      }

      return {
        ok: true,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: validation.data,
        usage,
      };
    } catch (err: unknown) {
      return _mapStructuredError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: single judge call
// ---------------------------------------------------------------------------

async function _callJudge(
  call: <T>(fn: (client: GoogleGenAI) => Promise<T>) => Promise<T>,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  geminiSchema: Record<string, unknown>
): Promise<JudgeResult> {
  try {
    const response = await call((client) => client.models.generateContent({
      model: modelId,
      contents: userPrompt,
      config: {
        temperature: 0,
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        responseSchema: geminiSchema as any,
      },
    }));

    const rawText = extractText(response);
    const usage = extractUsage(response, modelId, false);

    if (!rawText) {
      return {
        ok: false,
        code: "PARSE_FAILED",
        raw: null,
        usage,
        modelId,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return {
        ok: false,
        code: "PARSE_FAILED",
        raw: rawText,
        usage,
        modelId,
      };
    }

    const validation = JudgeVerdictSchema.safeParse(parsed);
    if (!validation.success) {
      return {
        ok: false,
        code: "PARSE_FAILED",
        raw: parsed,
        usage,
        modelId,
      };
    }

    return {
      ok: true,
      verdict: validation.data,
      raw: parsed,
      usage,
      modelId,
    };
  } catch (err: unknown) {
    return _mapJudgeError(err, modelId);
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Shared error classifier (SOTA v5 self-audit X8). Uses WORD-BOUNDARY patterns
 * instead of bare substring `includes()`:
 *   - lower.includes("rate") fired inside "generated"/"moderate"/"inaccurate"/
 *     "operated", misrouting genuine PROVIDER_ERRORs as retryable RATE_LIMITED.
 *   - lower.includes("api key") fired on any message that merely names the API
 *     key, misrouting non-auth errors as NOT_CONFIGURED.
 * Auth → NOT_CONFIGURED is gated on actual auth phrases / status codes, not the
 * bare token "api key". Classification order matches the original (rate → timeout
 * → auth → provider).
 */
type GeminiErrorClass = "RATE_LIMITED" | "TIMEOUT" | "NOT_CONFIGURED" | "PROVIDER_ERROR";

const RATE_LIMIT_RE = /\brate[\s_-]?limit|rate[\s_-]?limited|\b429\b|\bquota\b|\bresource[\s_-]?exhausted\b|\btoo many requests\b/;
const TIMEOUT_RE = /\btimed?[\s_-]?out\b|\btimeout\b|\bdeadline(?:[\s_-]?exceeded)?\b/;
const AUTH_RE = /api[\s_-]?key not valid|invalid api[\s_-]?key|\binvalid key\b|api[\s_-]?key (?:is )?invalid|permission[\s_-]?denied|\bunauthorized\b|\bforbidden\b|\b401\b|\b403\b/;

export function classifyGeminiError(err: unknown): GeminiErrorClass {
  const lower = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (RATE_LIMIT_RE.test(lower)) return "RATE_LIMITED";
  if (TIMEOUT_RE.test(lower)) return "TIMEOUT";
  if (AUTH_RE.test(lower)) return "NOT_CONFIGURED";
  return "PROVIDER_ERROR";
}

function _mapGenerateError(err: unknown): GenerateResult {
  const msg = err instanceof Error ? err.message : String(err);
  switch (classifyGeminiError(err)) {
    case "RATE_LIMITED":
      return { ok: false, code: "RATE_LIMITED", message: msg, retryable: true };
    case "TIMEOUT":
      return { ok: false, code: "TIMEOUT", message: msg, retryable: true };
    case "NOT_CONFIGURED":
      return { ok: false, code: NOT_CONFIGURED };
    default:
      return { ok: false, code: "PROVIDER_ERROR", message: msg, retryable: false };
  }
}

function _mapStructuredError(err: unknown): GenerateStructuredResult<never> {
  const msg = err instanceof Error ? err.message : String(err);
  switch (classifyGeminiError(err)) {
    case "RATE_LIMITED":
      return { ok: false, code: "RATE_LIMITED", message: msg, retryable: true };
    case "TIMEOUT":
      return { ok: false, code: "TIMEOUT", message: msg, retryable: true };
    case "NOT_CONFIGURED":
      return { ok: false, code: NOT_CONFIGURED };
    default:
      return { ok: false, code: "PROVIDER_ERROR", message: msg, retryable: false };
  }
}

function _mapJudgeError(err: unknown, modelId: string): JudgeResult {
  const msg = err instanceof Error ? err.message : String(err);
  void modelId;
  switch (classifyGeminiError(err)) {
    case "RATE_LIMITED":
      return { ok: false, code: "RATE_LIMITED", message: msg, retryable: true };
    case "TIMEOUT":
      return { ok: false, code: "TIMEOUT", message: msg, retryable: true };
    case "NOT_CONFIGURED":
      return { ok: false, code: NOT_CONFIGURED };
    default:
      return { ok: false, code: "PROVIDER_ERROR", message: msg, retryable: false };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a GeminiAdapter. Accepts a single key (back-compat) or an array of
 * keys to rotate across (see GEMINI_API_KEYS / geminiApiKeys() in config/env.ts).
 * apiKey=undefined/[] → adapter.status='not_configured', all calls return NOT_CONFIGURED.
 */
export function makeGeminiAdapter(apiKey: string | string[] | undefined): GeminiAdapter {
  return new GeminiAdapter(apiKey);
}
