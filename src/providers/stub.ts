/**
 * Stub adapter — returned for all non-Gemini providers (v1-a phase).
 *
 * DESIGN.md §4 / "Provider adapter contract":
 *   buildRegistry() wires real Gemini + makeStubAdapter for
 *   openai/anthropic/perplexity/grok/mistral/deepseek/llama-groq.
 *
 * Stubs:
 *   - status: 'stub' (not 'not_configured' — the provider is known but unimplemented)
 *   - generate(): returns NOT_CONFIGURED (deterministic planner skip)
 *   - judge(): returns NOT_CONFIGURED
 *
 * Adding a v1-b surface = new class implementing ProviderAdapter with
 * modality:'serp'|'scrape'; sampler/judge/metrics unchanged.
 */

import { NOT_CONFIGURED } from "./types.js";
import type {
  ProviderAdapter,
  GenerateRequest,
  GenerateResult,
  JudgeRequest,
  JudgeResult,
} from "./types.js";
import type { Modality, SurfaceCapability } from "../domain/types.js";

// ---------------------------------------------------------------------------
// StubAdapter
// ---------------------------------------------------------------------------

export class StubAdapter implements ProviderAdapter {
  readonly modality: Modality;
  readonly capabilities: SurfaceCapability[];
  readonly status = "stub" as const;

  constructor(
    readonly provider: string,
    modality: Modality = "chat"
  ) {
    this.modality = modality;
    // Stubs have no real capabilities — they always return NOT_CONFIGURED.
    this.capabilities = [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async generate(_req: GenerateRequest): Promise<GenerateResult> {
    return { ok: false, code: NOT_CONFIGURED };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async judge(_req: JudgeRequest): Promise<JudgeResult> {
    return { ok: false, code: NOT_CONFIGURED };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a stub adapter for a named provider.
 * The planner skips work-units whose adapter returns NOT_CONFIGURED, so stubs
 * produce zero work without any special-casing upstream.
 */
export function makeStubAdapter(
  provider: string,
  modality: Modality = "chat"
): StubAdapter {
  return new StubAdapter(provider, modality);
}
