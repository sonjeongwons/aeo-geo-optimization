/**
 * src/providers/openaiCompat.ts
 *
 * OpenAI-compatible chat-completions ProviderAdapter (DESIGN-research-aeo-geo.md
 * rank 4a: a 2nd, higher-citing judge unblocks honest measurement).
 *
 * Covers Perplexity (api.perplexity.ai) and OpenAI (api.openai.com/v1) and any
 * other /chat/completions-compatible endpoint. Mirrors the GeminiAdapter contract:
 *   - status: "ready" when the API key is present, else "not_configured".
 *   - judge(): reuses the SAME buildJudgeSystemPrompt as Gemini so cross-engine
 *     mention judging is apples-to-apples; forces JSON, validates JudgeVerdictSchema.
 *   - generate(): free-text answer (used for SMR sampling on this engine).
 *   - generateStructured(): JSON-object output validated against a caller Zod schema.
 *
 * NOT_CONFIGURED is a RETURNED VALUE, never an exception (contract §4).
 *
 * UNTESTED-UNTIL-KEYED: there is no live key in this environment, so this path is
 * interface-complete + compiles but has not been exercised end-to-end. The moment
 * a PERPLEXITY_API_KEY / OPENAI_API_KEY is set, the registry flips it to "ready".
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import type { z } from "zod";
import { JudgeVerdictSchema } from "../domain/mention.schema.js";
import { buildJudgeSystemPrompt } from "./gemini.js";
import { NOT_CONFIGURED } from "./types.js";
import type {
  ProviderAdapter,
  Modality,
  SurfaceCapability,
  AdapterUsage,
  GenerateRequest,
  GenerateResult,
  JudgeRequest,
  JudgeResult,
  GenerateStructuredRequest,
  GenerateStructuredResult,
} from "./types.js";

/** USD per 1M tokens (input, output). Approximate; refine when billing confirmed. */
interface Price { inUsdPerM: number; outUsdPerM: number; }

export interface OpenAiCompatConfig {
  provider: string;
  baseUrl: string;            // e.g. "https://api.perplexity.ai"
  defaultModel: string;       // e.g. "sonar"
  apiKey: string | undefined;
  price: Price;
  /** ms timeout per request. */
  timeoutMs?: number;
}

function usd(price: Price, inTok: number, outTok: number): number {
  return (inTok / 1_000_000) * price.inUsdPerM + (outTok / 1_000_000) * price.outUsdPerM;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatAdapter implements ProviderAdapter {
  readonly provider: string;
  readonly modality: Modality = "chat";
  readonly capabilities: SurfaceCapability[] = ["generate", "judge", "structured"];

  private readonly cfg: OpenAiCompatConfig;

  constructor(cfg: OpenAiCompatConfig) {
    this.cfg = cfg;
    this.provider = cfg.provider;
  }

  get status(): "ready" | "stub" | "not_configured" {
    return this.cfg.apiKey ? "ready" : "not_configured";
  }

  private usageOf(resp: ChatResponse): AdapterUsage {
    const inTok = resp.usage?.prompt_tokens ?? 0;
    const outTok = resp.usage?.completion_tokens ?? 0;
    return { inputTokens: inTok, outputTokens: outTok, usd: usd(this.cfg.price, inTok, outTok), cacheHit: false };
  }

  /** Low-level chat call. Returns {content, resp} or throws a tagged error. */
  private async chat(
    modelId: string,
    messages: Array<{ role: "system" | "user"; content: string }>,
    temperature: number,
    jsonMode: boolean,
  ): Promise<{ content: string; resp: ChatResponse }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30000);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const body = await res.text().catch(() => "");
        const err = new Error(`${this.provider} HTTP ${res.status}: ${body.slice(0, 200)}`) as Error & { retryable?: boolean; code?: string };
        err.retryable = retryable;
        err.code = res.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR";
        throw err;
      }
      const resp = (await res.json()) as ChatResponse;
      const content = resp.choices?.[0]?.message?.content ?? "";
      return { content, resp };
    } finally {
      clearTimeout(t);
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!this.cfg.apiKey) return { ok: false, code: NOT_CONFIGURED };
    const modelId = req.modelId || this.cfg.defaultModel;
    try {
      const { content, resp } = await this.chat(modelId, [{ role: "user", content: req.prompt }], req.temperature, false);
      return { ok: true, answerText: content, usage: this.usageOf(resp), meta: { provider: this.provider, modelId } };
    } catch (e) {
      const err = e as Error & { retryable?: boolean; code?: string };
      return { ok: false, code: err.code ?? "PROVIDER_ERROR", message: err.message, retryable: err.retryable ?? true };
    }
  }

  async judge(req: JudgeRequest): Promise<JudgeResult> {
    if (!this.cfg.apiKey) return { ok: false, code: NOT_CONFIGURED };
    const modelId = req.preferredModelId || this.cfg.defaultModel;
    const system =
      buildJudgeSystemPrompt(req.brandName, req.brandAliases, req.competitors) +
      "\n\nRespond with ONLY a single JSON object (no markdown, no prose) with keys: " +
      "brand_mentioned, brand_rank, sentiment, competitors_found, evidence.";
    try {
      const { content, resp } = await this.chat(
        modelId,
        [{ role: "system", content: system }, { role: "user", content: req.answerText }],
        0,
        true,
      );
      const usage = this.usageOf(resp);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return { ok: false, code: "PARSE_FAILED", raw: content, usage, modelId };
      }
      const v = JudgeVerdictSchema.safeParse(parsed);
      if (!v.success) return { ok: false, code: "PARSE_FAILED", raw: parsed, usage, modelId };
      return { ok: true, verdict: v.data, raw: parsed, usage, modelId };
    } catch (e) {
      const err = e as Error & { retryable?: boolean; code?: string };
      return { ok: false, code: err.code ?? "PROVIDER_ERROR", message: err.message, retryable: err.retryable ?? true };
    }
  }

  async generateStructured<T extends z.ZodTypeAny>(
    req: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<z.infer<T>>> {
    if (!this.cfg.apiKey) return { ok: false, code: NOT_CONFIGURED };
    const modelId = req.modelId || this.cfg.defaultModel;
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (req.systemInstruction) messages.push({ role: "system", content: req.systemInstruction });
    messages.push({ role: "user", content: req.prompt + "\n\nRespond with ONLY a single valid JSON object." });
    try {
      const { content, resp } = await this.chat(modelId, messages, req.temperature, true);
      const usage = this.usageOf(resp);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return { ok: false, code: "PARSE_FAILED", raw: content, usage };
      }
      const v = req.schema.safeParse(parsed);
      if (!v.success) return { ok: false, code: "PARSE_FAILED", raw: parsed, usage, message: v.error.message };
      return { ok: true, data: v.data, usage };
    } catch (e) {
      const err = e as Error & { retryable?: boolean; code?: string };
      return { ok: false, code: err.code ?? "PROVIDER_ERROR", message: err.message, retryable: err.retryable ?? true };
    }
  }
}

/** Provider presets. Perplexity = recommended 2nd judge (highest citer). */
export function makePerplexityAdapter(apiKey: string | undefined): OpenAiCompatAdapter {
  return new OpenAiCompatAdapter({
    provider: "perplexity",
    baseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar",
    apiKey,
    price: { inUsdPerM: 1.0, outUsdPerM: 1.0 },
  });
}

export function makeOpenAiAdapter(apiKey: string | undefined): OpenAiCompatAdapter {
  return new OpenAiCompatAdapter({
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    apiKey,
    price: { inUsdPerM: 0.15, outUsdPerM: 0.6 },
  });
}
