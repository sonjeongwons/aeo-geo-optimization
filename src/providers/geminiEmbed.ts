/**
 * src/providers/geminiEmbed.ts
 *
 * Gemini embedding adapter for the retrievability leading indicator
 * (src/metrics/retrievability.ts). Implements the structural EmbeddingAdapter
 * (embed(texts) → one vector each) via @google/genai text-embedding-004.
 *
 * OFF unless GEMINI_API_KEY is present: embed() returns [] when unconfigured, so
 * the retrievability scorer degrades to a no-op (never throws, never blocks) —
 * same gating discipline as the other paid Gemini calls. §7: embeddings are used
 * only for an INTERNAL indexing-hygiene signal, never surfaced as a guarantee.
 *
 * Node 22 ESM NodeNext.
 */

import { GoogleGenAI } from "@google/genai";

/** Free-tier-eligible embedding model (override via GEMINI_EMBED_MODEL). */
export const EMBED_MODEL = process.env["GEMINI_EMBED_MODEL"] ?? "gemini-embedding-001";

/**
 * Map a @google/genai embedContent response to plain vectors. PURE + defensive:
 * a missing/short field yields an empty vector rather than throwing (the scorer
 * treats a zero/empty vector as a safe 0 cosine).
 */
export function mapEmbedResponse(res: unknown): number[][] {
  const embs = (res as { embeddings?: unknown })?.embeddings;
  if (!Array.isArray(embs)) return [];
  return embs.map((e) => {
    const v = (e as { values?: unknown })?.values;
    return Array.isArray(v) ? (v as number[]) : [];
  });
}

export class GeminiEmbeddingAdapter {
  private readonly _apiKey: string | undefined;
  private _client: GoogleGenAI | undefined;

  constructor(apiKey: string | undefined) {
    this._apiKey = apiKey;
  }

  status(): "ready" | "not_configured" {
    return this._apiKey ? "ready" : "not_configured";
  }

  private client(): GoogleGenAI | null {
    if (!this._apiKey) return null;
    if (!this._client) this._client = new GoogleGenAI({ apiKey: this._apiKey });
    return this._client;
  }

  /** Embed a batch of texts → one vector each (same order). [] when unconfigured. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const c = this.client();
    if (!c) return [];
    const res = await c.models.embedContent({ model: EMBED_MODEL, contents: texts });
    return mapEmbedResponse(res);
  }
}

/** Factory mirroring makeGeminiAdapter. */
export function makeGeminiEmbeddingAdapter(apiKey: string | undefined): GeminiEmbeddingAdapter {
  return new GeminiEmbeddingAdapter(apiKey);
}
