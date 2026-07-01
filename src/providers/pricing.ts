/**
 * Per-model price table + priceUsd() computation.
 *
 * DESIGN.md §11 / "Cost design":
 *   - gemini-2.5-flash-lite: cheap monitor (operating cycle generation default)
 *   - gemini-2.5-flash: baseline generation default + judge default
 *   - gemini-2.5-pro: judge escalation on parse failure ONLY
 *
 * Prices are in USD per million tokens (input/output separate).
 * These mirror the values that must be seeded into the `model` DB table
 * by T10 loadTemplate, but are duplicated here so the adapter can compute
 * cost at call time without a DB round-trip.
 *
 * Pure — no IO.
 */

// ---------------------------------------------------------------------------
// Price row
// ---------------------------------------------------------------------------

export interface ModelPriceRow {
  modelId: string;
  provider: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  isCheapMonitor: boolean;
  isJudge: boolean;
}

// ---------------------------------------------------------------------------
// Canonical price table (USD per million tokens)
// ---------------------------------------------------------------------------

/**
 * Authoritative price table.  Values sourced from the Gemini pricing page as
 * of the design phase.  Update here AND in the DB model seed if prices change.
 *
 * Non-Gemini providers are stubs — prices are 0 until real adapters are wired.
 */
export const MODEL_PRICE_TABLE: ModelPriceRow[] = [
  // Gemini — real adapters
  {
    modelId: "gemini-2.5-flash-lite",
    provider: "gemini",
    inputUsdPerMtok: 0.10,   // $0.10 / 1M input tokens
    outputUsdPerMtok: 0.40,   // $0.40 / 1M output tokens
    isCheapMonitor: true,
    isJudge: false,
  },
  {
    modelId: "gemini-2.5-flash",
    provider: "gemini",
    inputUsdPerMtok: 0.30,   // $0.30 / 1M input tokens
    outputUsdPerMtok: 2.50,  // $2.50 / 1M output tokens
    isCheapMonitor: false,
    isJudge: true,
  },
  {
    modelId: "gemini-2.5-pro",
    provider: "gemini",
    inputUsdPerMtok: 1.25,   // $1.25 / 1M input tokens  (<=200k context)
    outputUsdPerMtok: 10.00, // $10.00 / 1M output tokens
    isCheapMonitor: false,
    isJudge: true,
  },

  // Stubs — prices 0 until real adapters are wired (v1-b)
  {
    modelId: "gpt-4o",
    provider: "openai",
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    isCheapMonitor: false,
    isJudge: false,
  },
  {
    modelId: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    isCheapMonitor: false,
    isJudge: false,
  },
  {
    modelId: "llama-3.3-70b-versatile",
    provider: "llama-groq",
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    isCheapMonitor: false,
    isJudge: false,
  },
  {
    modelId: "mistral-large-latest",
    provider: "mistral",
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    isCheapMonitor: false,
    isJudge: false,
  },
  {
    modelId: "deepseek-chat",
    provider: "deepseek",
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    isCheapMonitor: false,
    isJudge: false,
  },
  {
    modelId: "sonar",
    provider: "perplexity",
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    isCheapMonitor: false,
    isJudge: false,
  },
  {
    modelId: "grok-2",
    provider: "grok",
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    isCheapMonitor: false,
    isJudge: false,
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const _priceIndex = new Map<string, ModelPriceRow>(
  MODEL_PRICE_TABLE.map((row) => [row.modelId, row])
);

/**
 * Look up price row by model ID. Returns undefined if unknown.
 */
export function getPriceRow(modelId: string): ModelPriceRow | undefined {
  return _priceIndex.get(modelId);
}

/**
 * Compute USD cost for a call.
 *
 * @param modelId       The model used.
 * @param inputTokens   Number of input tokens consumed.
 * @param outputTokens  Number of output tokens consumed.
 * @returns USD cost (>= 0). Returns 0 for unknown models (stubs).
 *
 * Formula: (inputTokens / 1_000_000) * inputUsdPerMtok
 *        + (outputTokens / 1_000_000) * outputUsdPerMtok
 */
export function priceUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const row = _priceIndex.get(modelId);
  if (!row) {
    // Unknown model — stub, cost = 0.
    return 0;
  }
  const inputCost = (inputTokens / 1_000_000) * row.inputUsdPerMtok;
  const outputCost = (outputTokens / 1_000_000) * row.outputUsdPerMtok;
  return inputCost + outputCost;
}
