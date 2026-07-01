/**
 * Metric shapes for §5.2 — SMR / SoV / Visibility / PriorityGap + decompositions.
 * Pure types — no IO, no pg.
 * Shared verbatim with Phase 5 Next.js dashboard.
 */

import type { LanguageCode } from "./types.js";

// ---------------------------------------------------------------------------
// Core metric scalars
// ---------------------------------------------------------------------------

/**
 * Share of Model Response = brand_hits / N_total (snapshot, §5.2).
 * Denominator is `run.n_total` — NEVER the count of judgments.
 */
export interface SMR {
  metric: "smr";
  value: number; // [0,1] point estimate (brandHits / nTotal)
  brandHits: number;
  nTotal: number; // run.n_total snapshot
  evidenceRefs: string[]; // response_raw_id[]
  /**
   * 95% Wilson score interval for the proportion (hi-end audit MUST #3). Optional
   * so legacy SMR constructors stay valid; populated by computeSMR. Reporting a
   * point estimate without bounds is statistically indefensible and blocks A/B
   * inference (a "SMR=0.15" at n=100 could be [0.09, 0.24]).
   */
  ci95?: { lower: number; upper: number };
  /** True when nTotal < 100 (under-powered — the point estimate is noisy). */
  lowPower?: boolean;
}

/**
 * 95% Wilson score confidence interval for a binomial proportion hits/n.
 * Better than the normal approximation at small n and near 0/1 (where SMR lives).
 * PURE. z=1.96 for 95%.
 */
export function wilsonInterval(hits: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 0 };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/**
 * Share of Model CITATION = citation_hits / N_total (hi-end audit MUST #2).
 *
 * Distinct from SMR (mention-based): a CITATION is the brand presented as a
 * clickable/linked SOURCE or explicit attribution, the signal the engine actually
 * sells. citation_hits ⊆ brand_hits (a citation requires a gate-passed mention),
 * so citationValue ≤ SMR.value always. Reported alongside SMR so a client sees
 * the gap between being *named* and being *cited* — the real conversion lever.
 */
export interface CitationShare {
  metric: "citation_share";
  value: number; // [0,1] citationHits / nTotal
  citationHits: number;
  nTotal: number;
  /** Fraction of mentions that were also citations: citationHits / brandHits (0 when no mentions). */
  citationOfMentionRate: number;
  evidenceRefs: string[]; // response_raw_id[] for cited rows
  /** 95% Wilson interval for the citation proportion. */
  ci95?: { lower: number; upper: number };
  lowPower?: boolean;
}

/**
 * Share of model RECOMMENDATION = recommendation_hits / N_total (SOTA v2 R1).
 *
 * A RECOMMENDATION is the answer AFFIRMATIVELY advising the brand (best/top list
 * item or recommend-verb). recommendation_hits ⊆ brand_hits, so recommendationValue
 * ≤ SMR. Reported alongside SMR/citation so a client sees the full funnel:
 * mentioned → cited → RECOMMENDED. Deterministic LOWER BOUND (conservative
 * detector); not a precise semantic judgment.
 */
export interface RecommendationShare {
  metric: "recommendation_share";
  value: number; // [0,1] recommendationHits / nTotal
  recommendationHits: number;
  nTotal: number;
  /** Fraction of mentions that were also recommendations (0 when no mentions). */
  recommendationOfMentionRate: number;
  evidenceRefs: string[];
  ci95?: { lower: number; upper: number };
  lowPower?: boolean;
}

/**
 * "Early-position word share" (Position-Adjusted Word Count, GEO KDD'24).
 *
 * Mean over brand-mentioned responses of the brand's position-weighted word
 * share (earlier words weigh more, w(i)=1/(1+i)), in [0,1]. A COMPLEMENT to
 * inverse-rank Visibility: it captures how much of the answer — weighted to the
 * front — is brand text, not just whether/where the brand is ranked.
 *
 * HONESTY (§7): descriptive word-allocation/position measure only; NOT a causal
 * "influence" measure and NOT a citation. Surface label: "early-position word
 * share", never "influence".
 */
export interface PawcShare {
  metric: "pawc";
  value: number; // [0,1] mean over sampled responses
  /** Number of brand-mentioned responses that contributed (PAWC>0). */
  sampledResponses: number;
  evidenceRefs: string[]; // response_raw_id[]
}

/**
 * Visibility = Σ(1 / brand_rank) / N_total.
 * rank is 1-based ordinal among {brand ∪ tracked competitors} by first offset.
 */
export interface Visibility {
  metric: "visibility";
  value: number;
  invRankSum: number;
  nTotal: number;
  evidenceRefs: string[];
}

/**
 * Share of Voice = entity_mentions / (brand_mentions + competitor_mentions).
 * Denominator counts ALL mentions (brand + all tracked competitors).
 */
export interface SoV {
  metric: "sov";
  entityName: string;
  value: number; // [0,1]
  entityMentions: number;
  totalMentions: number; // brand + all competitors
  evidenceRefs: string[];
}

/**
 * Priority Gap = questions where brand SMR is low and competitor presence is high.
 * Used to identify the highest-leverage content gaps.
 */
export interface PriorityGapQuestion {
  questionId: string;
  questionText: string;
  brandSMR: number;
  competitorPresence: number; // fraction of responses where any competitor mentioned
  gapScore: number; // higher = bigger gap = higher priority
  evidenceRefs: string[];
}

export interface PriorityGap {
  metric: "priority_gap";
  questions: PriorityGapQuestion[];
  nTotal: number;
}

// ---------------------------------------------------------------------------
// Decomposition slices (§5.2 "分解 뷰")
// ---------------------------------------------------------------------------

export interface SMRByModel {
  modelId: string;
  smr: number;
  brandHits: number;
  judgedOk: number;
  evidenceRefs: string[];
}

export interface SMRByLanguage {
  language: LanguageCode;
  smr: number;
  brandHits: number;
  judgedOk: number;
  evidenceRefs: string[];
}

export interface SMRByQuestion {
  questionId: string;
  questionText: string;
  language: LanguageCode;
  smr: number;
  brandHits: number;
  judgedOk: number;
  evidenceRefs: string[];
}

export interface SMRDecomposition {
  byModel: SMRByModel[];
  byLanguage: SMRByLanguage[];
  byQuestion: SMRByQuestion[];
}

/**
 * Per-engine CITATION share (SOTA sweep proposal D). Mirrors SMRByModel but for
 * the citation channel: citationHits = citation_present ∧ brand_mentioned ∧ pass,
 * denominator = frozen work_unit count for the model. Surfaces the
 * "mention behaves differently from clickable-citation, per engine" insight.
 */
export interface CitationByModel {
  modelId: string;
  citationShare: number; // citationHits / sliceTotal
  citationHits: number;
  sliceTotal: number; // frozen work_unit count for this model
  ci95: { lower: number; upper: number };
  lowPower: boolean; // sliceTotal < 100
  evidenceRefs: string[];
}

/**
 * Per-PROMPT mention rate with a Wilson CI (SOTA sweep proposal C — "Don't
 * Measure Once", arXiv 2604.07585). One row per (question, model, language)
 * sampling cell: mentionRate = brandHits / nSamples, with a 95% Wilson interval
 * and a lowPower flag (nSamples < 30) — most cells at N=3–5 are flagged, which
 * is the HONEST outcome. This interval is strictly NOISIER than the run-level
 * SMR CI (smaller n); it is NOT claimed to be tighter or more certain.
 */
export interface PerPromptVisibility {
  questionId: string;
  modelId: string;
  language: LanguageCode;
  mentionRate: number;
  brandHits: number;
  nSamples: number;
  ci95: { lower: number; upper: number };
  lowPower: boolean; // nSamples < 30
  evidenceRefs: string[];
  /**
   * Partially-pooled rate shrunk toward the run-level mean (SOTA v2 R3). SEPARATE
   * from mentionRate/ci95 — a better point estimate for noisy small-n cells, but
   * NEVER a substitute for the raw measurement (lowPower still keys off raw n).
   * Optional so legacy consumers are unaffected.
   */
  pooledRate?: number;
  pooledCi95?: { lower: number; upper: number };
}

// ---------------------------------------------------------------------------
// Report DTO (§7 verifiable-numbers gate)
// DESIGN: NO free-text claims field — narrative superlatives are structurally
// impossible. Every metric traces to evidence_refs → response_raw rows → raw
// answer_text (§7#7).
// ---------------------------------------------------------------------------

export interface MetricTuple {
  metric: string;
  value: number;
  nTotal: number;
  evidenceRefs: string[]; // response_raw_id[]
}

export interface RunReport {
  runId: string;
  customerId: string;
  kind: "baseline" | "operating";
  generatedAt: Date;

  // Core metrics
  smr: SMR;
  visibility: Visibility;
  sov: SoV[];
  priorityGap: PriorityGap;

  /**
   * Share of model CITATION (hi-end audit MUST #2). Optional so legacy report
   * constructors stay valid; populated by assembleReport(). Surfaced next to SMR
   * so the mention→citation gap is visible to the client.
   */
  citationShare?: CitationShare;

  /**
   * Share of model recommendation (SOTA v2 R1). Optional; populated by
   * assembleReport(). The third funnel tier: mentioned → cited → RECOMMENDED.
   */
  recommendationShare?: RecommendationShare;

  /**
   * Early-position word share (PAWC, GEO KDD'24). Optional; populated by
   * assembleReport(). Complements Visibility — descriptive, not causal (§7).
   */
  pawc?: PawcShare;

  /**
   * Per-engine citation share (SOTA sweep D). Optional; populated by
   * assembleReport(). "mention vs clickable-citation, per engine".
   */
  citationByModel?: CitationByModel[];

  /**
   * Per-prompt mention rate + Wilson CI (SOTA sweep C). Optional; populated by
   * assembleReport(). Noisier than run-level SMR — most cells flagged lowPower.
   */
  perPromptVisibility?: PerPromptVisibility[];

  /**
   * Earned-source corpus (v2-critic #1): third-party domains the engines cite for
   * our prompts, ranked as a targeting list. Optional; empty until grounding is
   * enabled. Type is structural to avoid a metrics.types→metrics import cycle.
   */
  earnedSources?: {
    nResponses: number;
    domains: Array<{
      domain: string;
      citedResponses: number;
      fetchedResponses: number;
      brandCoCitedResponses: number;
      citationRate: number;
      ci95: { lower: number; upper: number };
      lowPower: boolean;
      citedWhenFetchedRate: number;
    }>;
  };

  /**
   * Cross-engine cited-domain overlap (SOTA v5 X25). Optional; populated by
   * assembleReport() from the same grounding signals as earnedSources. Empty
   * pairs until ≥2 engines carry grounding. When meanJaccard is low, cited-domain
   * targeting should be per-engine, not pooled. Structural type (import-cycle-safe).
   */
  engineOverlap?: {
    engines: string[];
    threshold: number;
    meanJaccard: number | null;
    pairs: Array<{
      engineA: string;
      engineB: string;
      jaccard: number;
      cosine: number;
      intersectionSize: number;
      unionSize: number;
      nDomainsA: number;
      nDomainsB: number;
      pooledSafe: boolean;
      lowData: boolean;
    }>;
  };

  /**
   * Variance-component decomposition + D-study (SOTA v5 X10). Optional; populated
   * by assembleReport() from the per-prompt visibility cells. Replaces the binary
   * lowPower intuition with a Var(θ̂)-driven adequacy signal + a run/prompt budget.
   * currentSe is null when the SE is not finite (design not estimable). Structural.
   */
  samplingAdequacy?: {
    estimable: boolean;
    sigma2Prompt: number;
    sigma2Resid: number;
    icc: number | null;
    nPrompts: number;
    nTotal: number;
    targetSe: number;
    currentSe: number | null;
    samplingAdequate: boolean;
    recommendedRunsPerPrompt: number | null;
    recommendedPrompts: number | null;
    note: string;
  };

  // Decompositions
  decomposition: SMRDecomposition;

  // Structured metric tuples for the verifiable-numbers gate
  metrics: MetricTuple[];

  // Abstain rate (DESIGN: "abstain-rate floor note")
  abstainCount: number;
  abstainRate: number; // abstainCount / nTotal

  /**
   * Measurement basis & limits disclosure (DESIGN §7 / §5.4 + research
   * DESIGN-research-aeo-geo.md ranks 4/11/13). Covers: mention-vs-citation basis,
   * relative SoV, single-engine self-judge bias, single-actor uplift upper-bound
   * (competitive decay), and schema-as-hygiene-not-a-citation-lever. Rendered to
   * the client (email + dashboard) so clients are never over-promised (§7 honesty).
   */
  selfJudgeBiasDisclosure: string;

  /**
   * Measurement-quality health (hi-end audit MUST #7). Derived from abstainRate:
   * when a large fraction of judgments abstain/downgrade, the SMR denominator
   * effectively shrinks and the residual sample is biased — so a customer-facing
   * quality status (good/warn/critical) is surfaced rather than reporting a
   * number that looks precise but rests on a degraded sample. Optional so legacy
   * report constructors stay valid; populated by assembleReport().
   */
  measurementQuality?: MeasurementQuality;
}

export type MeasurementQualityStatus = "good" | "warn" | "critical";

export interface MeasurementQuality {
  status: MeasurementQualityStatus;
  abstainRate: number;
  /** Customer-facing one-line interpretation. */
  note: string;
}

/**
 * Derive measurement-quality status from the abstain/downgrade rate.
 * Thresholds: WARN > 0.2, CRITICAL > 0.4 (DESIGN-hiend-audit MUST #7).
 * PURE.
 */
export function computeMeasurementQuality(abstainRate: number): MeasurementQuality {
  const pct = Math.round(abstainRate * 100);
  const status: MeasurementQualityStatus =
    abstainRate > 0.4 ? "critical" : abstainRate > 0.2 ? "warn" : "good";
  const note =
    status === "good"
      ? "Measurement quality is healthy: the judged sample is well-grounded."
      : status === "warn"
        ? `Caution: ${pct}% of judgments abstained or were downgraded — interpret SMR with care; the residual sample may be biased.`
        : `Low confidence: ${pct}% of judgments abstained or were downgraded — SMR is unreliable for this run. Re-measure or widen sampling before drawing conclusions.`;
  return { status, abstainRate, note };
}

// Comprehensive measurement disclosure — used in the report assembler and
// surfaced in every RunReport at generation time (email + dashboard).
// Kept §7-honest: it never promises absolute citation lift and is explicit about
// what is measured and the single-engine limit until a 2nd provider key arrives.
export const SELF_JUDGE_BIAS_DISCLOSURE =
  "Measurement basis & limits: SMR and Share-of-Voice are MENTION-based — they count whether the brand is " +
  "named in the answer text (absorption), which is distinct from a clickable CITATION (a linked source), " +
  "something answer engines provide far less often. Share-of-Voice is reported RELATIVE to tracked competitors. " +
  "Judgments are produced by a Gemini self-judge; bias toward Gemini responses cannot be excluded and coverage " +
  "is single-engine until a second provider key is added — set JUDGE_PROVIDER (e.g. 'perplexity') with the matching key to " +
  "substitute an independent, higher-citing judge (the substitution is wired in code). " +
  "Any method-uplift figures from the literature are single-actor upper bounds and decay as competitors adopt the " +
  "same tactics (C-SEO Bench, NeurIPS 2025). Structured data (JSON-LD / schema.org) is used for entity disambiguation " +
  "and indexing hygiene only — it is NOT claimed as a measured citation-lift lever (Ahrefs controlled study: ~0 effect).";
