/**
 * Public barrel for src/providers.
 *
 * Consumers import from "src/providers/index.js" and get the full
 * adapter contract + concrete implementations + registry factory.
 */

// Types / contract
export type {
  ProviderAdapter,
  GenerateRequest,
  GenerateResult,
  GenerateOk,
  GenerateNotConfigured,
  GenerateError,
  JudgeRequest,
  JudgeResult,
  JudgeOk,
  JudgeNotConfigured,
  JudgeParseFailed,
  JudgeError,
  AdapterUsage,
  ProviderReadiness,
  ProviderStatus,
  Modality,
  SurfaceCapability,
} from "./types.js";

export { NOT_CONFIGURED } from "./types.js";
export type { NotConfigured } from "./types.js";

// Pricing
export { priceUsd, getPriceRow, MODEL_PRICE_TABLE } from "./pricing.js";
export type { ModelPriceRow } from "./pricing.js";

// Gemini adapter
export { makeGeminiAdapter, GeminiAdapter } from "./gemini.js";

// Stub adapter
export { makeStubAdapter, StubAdapter } from "./stub.js";

// Registry
export { buildRegistry } from "./registry.js";
export type { ProviderRegistry } from "./registry.js";
