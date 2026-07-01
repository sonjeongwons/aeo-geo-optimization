/**
 * Pure domain types — no IO, no pg, no @google/genai.
 * Shared verbatim with Phase 5 Next.js dashboard.
 *
 * DESIGN.md §5.1: Response atom, StoredMention, Run, ModelRef, LanguageCode.
 */

// ---------------------------------------------------------------------------
// Language / locale
// ---------------------------------------------------------------------------

/** ISO 639-1 (or 639-1 + script subtag, e.g. "zh-TW") language code. */
export type LanguageCode = string;

// ---------------------------------------------------------------------------
// Models / Providers
// ---------------------------------------------------------------------------

export type Modality = "chat" | "serp" | "scrape";

export type SurfaceCapability =
  | "generate"    // can produce free-text answers
  | "judge"       // can act as LLM judge
  | "structured"; // supports forced-JSON / responseSchema

export interface ModelRef {
  /** Primary key in the `model` table. E.g. "gemini-2.5-flash-lite". */
  id: string;
  provider: string;
  modality: Modality;
  capabilities: SurfaceCapability[];
  isCheapMonitor: boolean;
  isJudge: boolean;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Response atom (§5.1)
// ---------------------------------------------------------------------------

export type ResponseStatus = "ok" | "not_configured" | "error" | "cached";

/**
 * One (question × model × language × sample) measurement.
 * Maps to the `response_raw` hypertable row.
 */
export interface ResponseRaw {
  capturedAt: Date;
  id: string; // uuid
  runId: string;
  customerId: string;
  questionId: string;
  modelId: string;
  language: LanguageCode;
  sampleIdx: number;
  temperature: number;
  requestHash: string;
  promptVersion: string;
  answerText: string | null;
  providerMeta: Record<string, unknown> | null;
  status: ResponseStatus;
}

// ---------------------------------------------------------------------------
// Mention judgment (§5.4)
// ---------------------------------------------------------------------------

export type Provenance = "judge" | "fallback" | "abstain";
export type Sentiment = "positive" | "neutral" | "negative";
export type GuardrailStatus = "pass" | "downgraded_abstain";

/**
 * One judgment row for a response.
 * Maps to the `mention_judgment` hypertable row.
 * DESIGN: denormalized (response_status + coords) so SMR aggregates are single-table.
 * DESIGN: re-judging appends a new row; `current_judgment` view picks the latest.
 */
export interface StoredMention {
  capturedAt: Date;
  id: string; // uuid
  responseRawId: string;
  runId: string;
  customerId: string;
  questionId: string;
  modelId: string;
  language: LanguageCode;
  responseStatus: ResponseStatus;
  brandMentioned: boolean;
  brandRank: number | null;
  sentiment: Sentiment | null;
  competitorsFound: Array<{ name: string; rank: number | null }>;
  evidenceQuote: string | null;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  provenance: Provenance;
  judgeModel: string | null;
  judgeRaw: unknown | null;
  guardrailStatus: GuardrailStatus;
}

// ---------------------------------------------------------------------------
// Run (§5.7)
// ---------------------------------------------------------------------------

export type RunKind = "baseline" | "operating";

export type RunStatus =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "over_budget";

export interface Run {
  id: string; // uuid
  customerId: string;
  kind: RunKind;
  status: RunStatus;
  nSamples: number;
  temperature: number;
  /** Snapshotted BEFORE execution — frozen SMR denominator (§5.2). */
  nTotal: number | null;
  plannedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Work unit (planning / idempotency)
// ---------------------------------------------------------------------------

export type WorkUnitStatus = "pending" | "done" | "skipped" | "error";

export interface WorkUnit {
  runId: string;
  questionId: string;
  modelId: string;
  language: LanguageCode;
  sampleIdx: number;
  status: WorkUnitStatus;
  responseRawId: string | null;
  /** Derived at plan time; NOT stored — used for cache check + request_hash. */
  prompt?: string;
  requestHash?: string;
}

// ---------------------------------------------------------------------------
// Customer / brand / competitor
// ---------------------------------------------------------------------------

export interface Customer {
  id: string;
  slug: string;
  createdAt: Date;
}

export interface Brand {
  id: string;
  customerId: string;
  name: string;
  aliases: string[];
}

export interface Competitor {
  id: string;
  customerId: string;
  name: string;
  aliases: string[];
}

export interface Question {
  id: string;
  customerId: string;
  text: string;
  language: LanguageCode;
  funnelStage: string | null;
  densityTier: DensityTier;
  active: boolean;
}

export type DensityTier = "core" | "secondary" | "longtail";

export interface CustomerLanguage {
  customerId: string;
  language: LanguageCode;
  weight: number;
}

export interface Budget {
  customerId: string;
  maxModels: number;
  maxSamples: number;
  maxLanguages: number;
  weeklyUsdCap: number;
  monthlyUsdCap: number;
}

// ---------------------------------------------------------------------------
// LLM call ledger
// ---------------------------------------------------------------------------

export type LlmCallPurpose = "generation" | "judge";

export interface LlmCall {
  ts: Date;
  id: string;
  customerId: string;
  runId: string;
  purpose: LlmCallPurpose;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  cacheHit: boolean;
  responseRawId: string | null;
}
