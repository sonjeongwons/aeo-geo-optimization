/**
 * Provider registry — wires real Gemini + stubs for all v1-a non-Gemini providers,
 * and merges all v1-b surface adapters (T11, Phase 4).
 *
 * DESIGN.md §4:
 *   buildRegistry() = real Gemini + makeStubAdapter for
 *   openai/anthropic/perplexity/grok/mistral/deepseek/llama-groq.
 *   readiness() from env keys.
 *
 * Phase 4 (T11) — additive:
 *   buildSurfaceRegistry() builds v1-b surface adapters (stubs today) and
 *   merges them into the unified ProviderRegistry returned by buildRegistry().
 *   No existing adapter entries or exports are changed.
 */

import { makeGeminiAdapter } from "./gemini.js";
import { makePerplexityAdapter, makeOpenAiAdapter } from "./openaiCompat.js";
import { makeStubAdapter } from "./stub.js";
import { buildSurfaceRegistry } from "../surfaces/registry.js";
import type { ProviderAdapter, ProviderReadiness } from "./types.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ProviderRegistry {
  /** Get an adapter by provider name. Returns undefined if unknown. */
  get(provider: string): ProviderAdapter | undefined;

  /** List all registered adapters. */
  all(): ProviderAdapter[];

  /** Readiness summary for all adapters (for GET /providers endpoint). */
  readiness(): ProviderReadiness[];
}

// ---------------------------------------------------------------------------
// Internal adapter definition list
// ---------------------------------------------------------------------------

interface AdapterDef {
  provider: string;
  kind: "gemini" | "perplexity" | "openai" | "stub";
  /** Environment variable name for the API key (relevant for readiness reporting). */
  envKey: string;
}

// Research rank-4a: perplexity (highest citer) + openai are real OpenAI-compatible
// adapters now — they self-report "not_configured" until their key is set, then
// flip to "ready" with zero further wiring (unblocks 2nd-engine SMR measurement).
const ADAPTER_DEFS: AdapterDef[] = [
  { provider: "gemini",     kind: "gemini",     envKey: "GEMINI_API_KEY" },
  { provider: "openai",     kind: "openai",     envKey: "OPENAI_API_KEY" },
  { provider: "anthropic",  kind: "stub",       envKey: "ANTHROPIC_API_KEY" },
  { provider: "perplexity", kind: "perplexity", envKey: "PERPLEXITY_API_KEY" },
  { provider: "grok",       kind: "stub",       envKey: "GROK_API_KEY" },
  { provider: "mistral",    kind: "stub",       envKey: "MISTRAL_API_KEY" },
  { provider: "deepseek",   kind: "stub",       envKey: "DEEPSEEK_API_KEY" },
  { provider: "llama-groq", kind: "stub",       envKey: "GROQ_API_KEY" },
];

// ---------------------------------------------------------------------------
// buildRegistry
// ---------------------------------------------------------------------------

/**
 * Build and return a ProviderRegistry.
 *
 * Each adapter is instantiated once; the registry is immutable after build.
 * The Gemini adapter reads GEMINI_API_KEY from the provided env map (injected
 * so tests can override without touching process.env).
 *
 * Phase 4 (T11) addition (ADDITIVE — no existing logic changed):
 *   v1-b surface adapters are built via buildSurfaceRegistry() and merged
 *   into the unified adapter map. All existing v1-a entries are unchanged.
 *   Surface adapters are keyed by their surfaceId (e.g. "googleAio", "copilot").
 *
 * @param env  Env variable map (default: process.env).
 */
export function buildRegistry(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): ProviderRegistry {
  const adapters = new Map<string, ProviderAdapter>();

  for (const def of ADAPTER_DEFS) {
    let adapter: ProviderAdapter;

    if (def.kind === "gemini") {
      adapter = makeGeminiAdapter(env[def.envKey]);
    } else if (def.kind === "perplexity") {
      adapter = makePerplexityAdapter(env[def.envKey]);
    } else if (def.kind === "openai") {
      adapter = makeOpenAiAdapter(env[def.envKey]);
    } else {
      // Stub — key presence doesn't matter yet; stubs always return NOT_CONFIGURED.
      adapter = makeStubAdapter(def.provider);
    }

    adapters.set(def.provider, adapter);
  }

  // Phase 4 (T11): merge v1-b surface adapters (SERP/scrape) into the registry.
  // All surface adapters start as NOT_CONFIGURED stubs (no SERP_API_KEY / RPA_RUNNER_URL).
  // They slot into the same ProviderAdapter contract as v1-a adapters without any
  // changes to the runResponse / judge / SMR pipeline.
  const surfaceRegistry = buildSurfaceRegistry(env);
  for (const adapter of surfaceRegistry.all()) {
    adapters.set(adapter.provider, adapter);
  }

  return {
    get(provider: string): ProviderAdapter | undefined {
      return adapters.get(provider);
    },

    all(): ProviderAdapter[] {
      return [...adapters.values()];
    },

    readiness(): ProviderReadiness[] {
      return [...adapters.values()].map((a) => ({
        provider: a.provider,
        // Stubs are presented as 'not_configured' in the readiness report
        // because there is no API key or implementation to configure.
        // The adapter's own .status property remains 'stub' (DESIGN §4).
        status: a.status === "stub" ? "not_configured" : a.status,
        modality: a.modality,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// resolveJudgeAdapter (hi-end audit MUST #1)
// ---------------------------------------------------------------------------

/**
 * Resolve the LLM-as-judge adapter: the configured JUDGE_PROVIDER when it is
 * 'ready' (key present + a judge() implementation), else fall back to Gemini.
 *
 * This replaces the previously-hardcoded registry.get("gemini") judge selection
 * so that setting JUDGE_PROVIDER=perplexity (+ PERPLEXITY_API_KEY) actually
 * substitutes the judge — making the §5.4 measurement disclosure true in code.
 *
 * @param registry        the provider registry
 * @param preferredProvider  env.JUDGE_PROVIDER (e.g. "gemini" | "perplexity" | "openai")
 * @returns the resolved judge ProviderAdapter
 * @throws if neither the preferred provider nor Gemini is available at all
 */
export function resolveJudgeAdapter(
  registry: ProviderRegistry,
  preferredProvider: string,
): ProviderAdapter {
  const preferred = registry.get(preferredProvider);
  if (preferred && preferred.status === "ready") return preferred;

  const gemini = registry.get("gemini");
  if (gemini) return gemini; // fail-safe fallback (may itself be not_configured)

  throw new Error(
    `resolveJudgeAdapter: no judge adapter available (preferred='${preferredProvider}' not ready, gemini missing)`,
  );
}
