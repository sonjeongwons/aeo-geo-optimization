/**
 * src/metrics/aggregate.ts
 *
 * §5.2 metric computation by PLAIN SQL over current_judgment view.
 *
 * DESIGN invariants (enforced here):
 *
 * 1. SMR denominator = run.n_total (SNAPSHOTTED before execution), NOT the count
 *    of judgments.  Error/abstain rows stay in the denominator and never inflate
 *    the numerator (§5.2).
 *
 * 2. Only rows with guardrail_status='pass' count toward brand_hits /
 *    inv_rank_sum.  Downgraded rows are excluded from the numerator but still
 *    persisted and counted in N_total.
 *
 * 3. Latest-judgment-wins: we read from the `current_judgment` VIEW which
 *    applies DISTINCT ON (response_raw_id) ORDER BY captured_at DESC.
 *    Re-judging a response appends a row; the view automatically picks the
 *    latest — no double-counting.
 *
 * 4. run_smr_overall VIEW (built by DB migration 0003) pre-aggregates the
 *    per-run totals (brand_hits, judged_ok, inv_rank_sum).  aggregate.ts joins
 *    that to run.n_total to derive SMR / Visibility.  Decompositions (by model,
 *    language, question) are computed by separate GROUP BY queries over
 *    current_judgment.
 *
 * 5. SoV denominator = total mentions of BRAND + ALL tracked competitors
 *    (§5.2 definition).  This is computed from competitors_found JSONB in
 *    current_judgment rows.
 *
 * 6. Priority Gap = questions where brand SMR is low AND competitor presence
 *    is high (§5.2).  gapScore = competitorPresence − brandSMR  (higher is
 *    worse, i.e., higher priority to fix).
 *
 * All functions accept a `runId` and pull data from the DB.  They are pure
 * side-effecting queries — no mutation.
 */

import { sql } from "kysely";
import { getDb } from "../db/kysely.js";
import { countWorkUnitsBySlice } from "../db/repo.js";
import { wilsonInterval } from "../domain/metrics.types.js";
import { computePawc } from "./pawc.js";
import {
  tallyCitationShareByModel,
  tallyPerPromptVisibility,
} from "./promptVisibility.js";
import { computeGroundingGap, isSearchEngineSelfRef, type GroundingTrace } from "../judge/groundingGap.js";
import { aggregateEarnedSources, type ResponseSourceSignal, type EarnedSourceCorpus } from "./earnedSources.js";
import { computeEngineOverlap as computeEngineOverlapPure, type EngineOverlapReport } from "./engineOverlap.js";
import { estimateVarianceComponents, dStudy, type PromptTally } from "./varianceComponents.js";
import type {
  SMR,
  CitationShare,
  RecommendationShare,
  CitationByModel,
  PerPromptVisibility,
  PawcShare,
  Visibility,
  SoV,
  PriorityGap,
  PriorityGapQuestion,
  SMRByModel,
  SMRByLanguage,
  SMRByQuestion,
  SMRDecomposition,
} from "../domain/metrics.types.js";
import type { CurrentJudgmentRow } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function db() {
  return getDb();
}

/**
 * Fetch the run.n_total snapshot for the given runId.
 * Throws if the run is not found or n_total is null (plan phase not complete).
 */
async function fetchNTotal(runId: string): Promise<number> {
  const row = await db()
    .selectFrom("run")
    .select("n_total")
    .where("id", "=", runId)
    .executeTakeFirst();

  if (!row) {
    throw new Error(`aggregate: run not found: ${runId}`);
  }
  if (row.n_total === null) {
    throw new Error(
      `aggregate: run.n_total is null for runId=${runId} — plan phase not complete`
    );
  }
  return row.n_total;
}

/**
 * Fetch all current judgments for a run (from the latest-judgment-wins view).
 */
async function fetchJudgments(runId: string): Promise<CurrentJudgmentRow[]> {
  return db()
    .selectFrom("current_judgment")
    .selectAll()
    .where("run_id", "=", runId)
    .execute();
}

/**
 * Parse competitors_found JSONB field into a typed array.
 * Handles cases where the DB returns a parsed object or a JSON string.
 */
function parseCompetitorsFound(
  raw: unknown
): Array<{ name: string; rank: number | null }> {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Array<{ name: string; rank: number | null }>;
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    return raw as Array<{ name: string; rank: number | null }>;
  }
  return [];
}

// ---------------------------------------------------------------------------
// computeSMR
// ---------------------------------------------------------------------------

/**
 * Compute Share of Model Response = brand_hits / n_total.
 *
 * Uses the run_smr_overall view (pre-aggregated by migration 0003) for the
 * brand_hits count, then divides by run.n_total (the snapshotted denominator).
 *
 * evidenceRefs = response_raw_id[] for rows where brand_mentioned=true AND
 * guardrail_status='pass'.
 */
export async function computeSMR(runId: string): Promise<SMR> {
  const nTotal = await fetchNTotal(runId);

  // Read from the pre-aggregated run_smr_overall view.
  const overall = await db()
    .selectFrom("run_smr_overall")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirst();

  const brandHits = overall ? parseInt(overall.brand_hits, 10) : 0;

  // Collect evidence refs (response_raw_id[] for pass+brand_mentioned rows).
  const evidenceRows = await db()
    .selectFrom("current_judgment")
    .select("response_raw_id")
    .where("run_id", "=", runId)
    .where("brand_mentioned", "=", true)
    .where("guardrail_status", "=", "pass")
    .execute();

  const evidenceRefs = evidenceRows.map((r) => r.response_raw_id);

  return {
    metric: "smr",
    value: nTotal > 0 ? brandHits / nTotal : 0,
    brandHits,
    nTotal,
    evidenceRefs,
    // Hi-end audit MUST #3: 95% Wilson interval + under-power flag.
    ci95: wilsonInterval(brandHits, nTotal),
    lowPower: nTotal < 100,
  };
}

// ---------------------------------------------------------------------------
// computeCitationShare (hi-end audit MUST #2)
// ---------------------------------------------------------------------------

/**
 * Compute Share of Model CITATION = citation_hits / n_total.
 *
 * citation_hits comes from run_smr_overall (migration 0020), which counts only
 * rows that are a gate-passed, grounded MENTION *and* carry citation_present —
 * so citationHits ≤ brandHits and the citation rate can never exceed SMR.
 *
 * Reported next to SMR so the client sees the gap between being NAMED (mention)
 * and being CITED (linked source) — the conversion lever the engine actually moves.
 *
 * evidenceRefs = response_raw_id[] for cited, gate-passed rows.
 */
export async function computeCitationShare(runId: string): Promise<CitationShare> {
  const nTotal = await fetchNTotal(runId);

  const overall = await db()
    .selectFrom("run_smr_overall")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirst();

  const citationHits = overall?.citation_hits ? parseInt(overall.citation_hits, 10) : 0;
  const brandHits = overall?.brand_hits ? parseInt(overall.brand_hits, 10) : 0;

  // Evidence refs: cited + gate-passed + grounded-mention rows.
  const evidenceRows = await db()
    .selectFrom("current_judgment")
    .select("response_raw_id")
    .where("run_id", "=", runId)
    .where("citation_present", "=", true)
    .where("brand_mentioned", "=", true)
    .where("guardrail_status", "=", "pass")
    .execute();

  return {
    metric: "citation_share",
    value: nTotal > 0 ? citationHits / nTotal : 0,
    citationHits,
    nTotal,
    citationOfMentionRate: brandHits > 0 ? citationHits / brandHits : 0,
    evidenceRefs: evidenceRows.map((r) => r.response_raw_id),
    ci95: wilsonInterval(citationHits, nTotal),
    lowPower: nTotal < 100,
  };
}

// ---------------------------------------------------------------------------
// computeRecommendationShare (SOTA v2 R1)
// ---------------------------------------------------------------------------

/**
 * Compute Share of Model RECOMMENDATION = recommendation_hits / n_total.
 *
 * recommendation_hits (run_smr_overall, migration 0022) counts rows that are a
 * gate-passed grounded MENTION *and* carry recommendation_present — so
 * recommendationHits ≤ brandHits and the rate can never exceed SMR. The third
 * funnel tier (mentioned → cited → recommended). Deterministic LOWER BOUND.
 */
export async function computeRecommendationShare(runId: string): Promise<RecommendationShare> {
  const nTotal = await fetchNTotal(runId);

  const overall = await db()
    .selectFrom("run_smr_overall")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirst();

  const recommendationHits = overall?.recommendation_hits
    ? parseInt(overall.recommendation_hits, 10)
    : 0;
  const brandHits = overall?.brand_hits ? parseInt(overall.brand_hits, 10) : 0;

  const evidenceRows = await db()
    .selectFrom("current_judgment")
    .select("response_raw_id")
    .where("run_id", "=", runId)
    .where("recommendation_present", "=", true)
    .where("brand_mentioned", "=", true)
    .where("guardrail_status", "=", "pass")
    .execute();

  return {
    metric: "recommendation_share",
    value: nTotal > 0 ? recommendationHits / nTotal : 0,
    recommendationHits,
    nTotal,
    recommendationOfMentionRate: brandHits > 0 ? recommendationHits / brandHits : 0,
    evidenceRefs: evidenceRows.map((r) => r.response_raw_id),
    ci95: wilsonInterval(recommendationHits, nTotal),
    lowPower: nTotal < 100,
  };
}

// ---------------------------------------------------------------------------
// computeEarnedSources (v2-critic #1 — earned-source corpus, unblocked by v3 grounding)
// ---------------------------------------------------------------------------

/**
 * Aggregate the THIRD-PARTY domains the engines cited across the run into a
 * "who gets cited for our prompts" targeting graph. Reads each response's
 * grounding trace from response_raw.provider_meta.grounding (populated only when
 * GEMINI_GROUNDING is on) and the brand_mentioned flag from current_judgment.
 *
 * §0: reads engine-returned URLs only — never fetches anything. Returns an empty
 * corpus (nResponses=0) when no response carried grounding data (the honest
 * "not yet measurable" state until grounding is enabled).
 */
/**
 * Build per-response earned-source signals from the grounding traces stored in
 * response_raw.provider_meta. Shared by computeEarnedSources + computeEngineOverlap
 * so the grounding-read logic lives in one place. Returns [] when no response
 * carried grounding (the honest "not yet measurable" state).
 */
async function fetchSourceSignals(runId: string): Promise<ResponseSourceSignal[]> {
  const judgments = await db()
    .selectFrom("current_judgment")
    .select(["response_raw_id", "brand_mentioned", "model_id"])
    .where("run_id", "=", runId)
    .execute();
  const mentionedBy = new Map(judgments.map((j) => [j.response_raw_id, j.brand_mentioned]));

  const ids = judgments.map((j) => j.response_raw_id);
  if (ids.length === 0) return [];

  const rows = await db()
    .selectFrom("response_raw")
    .select(["id", "model_id", "provider_meta"])
    .where("id", "in", ids)
    .execute();

  const signals: ResponseSourceSignal[] = [];
  for (const row of rows) {
    const meta = (typeof row.provider_meta === "string"
      ? safeJson(row.provider_meta)
      : row.provider_meta) as { grounding?: GroundingTrace } | null;
    const grounding = meta?.grounding;
    if (!grounding) continue; // no retrieval trace for this response
    const gap = computeGroundingGap(grounding);
    // Exclude search-engine self-reference surfaces (e.g. "google.com" chunks that
    // Gemini grounding emits for its own search surface) — they are not targetable
    // third-party earned sources (§7 targeting honesty). See groundingGap.ts.
    signals.push({
      citedDomains: gap.citedDomains.filter((d) => !isSearchEngineSelfRef(d)),
      fetchedDomains: gap.fetchedDomains.filter((d) => !isSearchEngineSelfRef(d)),
      brandMentioned: mentionedBy.get(row.id) ?? false,
      modelId: row.model_id,
    });
  }
  return signals;
}

export async function computeEarnedSources(runId: string): Promise<EarnedSourceCorpus> {
  const signals = await fetchSourceSignals(runId);
  return aggregateEarnedSources(signals);
}

/**
 * Cross-engine cited-domain overlap (X25) — reuses the earned-source signals.
 * Groups by modelId and computes per-engine-pair Jaccard/cosine so the report can
 * decide pooled-vs-per-engine targeting. Empty pairs until ≥2 engines carry
 * grounding (honest "not yet measurable").
 */
export async function computeEngineOverlap(runId: string): Promise<EngineOverlapReport> {
  const signals = await fetchSourceSignals(runId);
  return computeEngineOverlapPure(signals);
}

/**
 * Variance-component decomposition + D-study (X10) over the per-prompt visibility
 * cells: each (question,model,language) cell is one prompt tally {hits,n}, and
 * nSamples are the within-prompt replicates. Produces a Var(θ̂)-driven
 * samplingAdequacy + a runs/prompts budget for a disclosed target SE. currentSe
 * is null when not finite (design not estimable). PURE stats over DB reads.
 */
export async function computeSamplingAdequacy(
  runId: string,
  targetSe = 0.05,
): Promise<{
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
}> {
  const cells = await computePerPromptVisibility(runId);
  const tallies: PromptTally[] = cells.map((c) => ({ hits: c.brandHits, n: c.nSamples }));
  const vc = estimateVarianceComponents(tallies);

  // Current design: #cells prompts × the MEDIAN cell sample size (a balanced
  // approximation the scalar D-study can express).
  const samplesSorted = cells.map((c) => c.nSamples).sort((a, b) => a - b);
  const medianSamples = samplesSorted.length > 0 ? samplesSorted[Math.floor(samplesSorted.length / 2)]! : 1;
  const ds = dStudy(vc, {
    targetSe,
    nPromptsCurrent: Math.max(1, vc.nPrompts),
    nRunsPerPromptCurrent: Math.max(1, medianSamples),
  });

  // A CONSTANT outcome (every cell 0 or every cell 1) is estimable but has zero
  // total variance → dStudy refuses it (currentSe Infinity → null below). Surface
  // an honest note rather than the generic decomposition note (v10 Z1).
  const constantOutcome = vc.estimable && !(vc.sigma2Prompt + vc.sigma2Resid > 0);

  return {
    estimable: vc.estimable,
    sigma2Prompt: vc.sigma2Prompt,
    sigma2Resid: vc.sigma2Resid,
    icc: vc.icc,
    nPrompts: vc.nPrompts,
    nTotal: vc.nTotal,
    targetSe,
    currentSe: Number.isFinite(ds.currentSe) ? ds.currentSe : null,
    samplingAdequate: ds.samplingAdequate,
    recommendedRunsPerPrompt: ds.recommendedRunsPerPrompt,
    recommendedPrompts: ds.recommendedPrompts,
    note: constantOutcome
      ? "Outcome is constant (0% or 100%) across all prompts — the standard error is not identifiable from this degenerate sample."
      : vc.note,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// computePawcShare (SOTA sweep: GEO KDD early-position word share)
// ---------------------------------------------------------------------------

/**
 * Mean "early-position word share" (PAWC) over brand-mentioned, gate-passed
 * responses. Computed at report time from response_raw.answer_text — no stored
 * column, so it is purely additive and re-derivable.
 *
 * HONESTY (§7): a descriptive word-allocation/position measure, NOT a causal
 * influence or citation measure. Averaged ONLY over responses that are a
 * grounded mention (denominator = brand-hit rows), so it reads as "when we ARE
 * named, how much of the answer — weighted to the front — is us".
 */
export async function computePawcShare(
  runId: string,
  brandAliases: string[],
): Promise<PawcShare> {
  // Join the gate-passed brand-hit judgments to their raw answer text.
  const rows = await db()
    .selectFrom("current_judgment as cj")
    .innerJoin("response_raw as rr", "rr.id", "cj.response_raw_id")
    .select(["cj.response_raw_id as response_raw_id", "rr.answer_text as answer_text"])
    .where("cj.run_id", "=", runId)
    .where("cj.brand_mentioned", "=", true)
    .where("cj.guardrail_status", "=", "pass")
    .execute();

  let sum = 0;
  let n = 0;
  const evidenceRefs: string[] = [];
  for (const r of rows) {
    const p = computePawc(r.answer_text, brandAliases);
    if (p > 0) {
      sum += p;
      n += 1;
      evidenceRefs.push(r.response_raw_id);
    }
  }

  return {
    metric: "pawc",
    value: n > 0 ? sum / n : 0,
    sampledResponses: n,
    evidenceRefs,
  };
}

// ---------------------------------------------------------------------------
// computeVisibility
// ---------------------------------------------------------------------------

/**
 * Compute Visibility = Σ(1 / brand_rank) / n_total.
 *
 * brand_rank is the 1-based ordinal among {brand ∪ tracked competitors} by
 * first character offset (shared rule: domain/rank.ts, same for judge and
 * fallback — provenance-independent).
 *
 * Only rows with brand_mentioned=true AND guardrail_status='pass' contribute
 * to the sum.  Uses the inv_rank_sum pre-computed by run_smr_overall.
 */
export async function computeVisibility(runId: string): Promise<Visibility> {
  const nTotal = await fetchNTotal(runId);

  const overall = await db()
    .selectFrom("run_smr_overall")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirst();

  const invRankSum = overall?.inv_rank_sum
    ? parseFloat(overall.inv_rank_sum)
    : 0;

  // Collect evidence refs for ranked rows.
  const evidenceRows = await db()
    .selectFrom("current_judgment")
    .select("response_raw_id")
    .where("run_id", "=", runId)
    .where("brand_mentioned", "=", true)
    .where("guardrail_status", "=", "pass")
    .where("brand_rank", "is not", null)
    .execute();

  const evidenceRefs = evidenceRows.map((r) => r.response_raw_id);

  return {
    metric: "visibility",
    value: nTotal > 0 ? invRankSum / nTotal : 0,
    invRankSum,
    nTotal,
    evidenceRefs,
  };
}

// ---------------------------------------------------------------------------
// computeSoV
// ---------------------------------------------------------------------------

/**
 * Compute Share of Voice per entity (brand + each tracked competitor).
 *
 * SoV(entity) = entity_mentions / (brand_mentions + all_competitor_mentions)
 *
 * "mention" here = a current_judgment row with guardrail_status='pass' where
 * the entity appears.  For the brand that means brand_mentioned=true.  For
 * competitors we count occurrences in competitors_found[].
 *
 * Returns one SoV entry per entity (brand first, then competitors by name).
 * If total mentions = 0, all SoV values are 0.
 */
export async function computeSoV(
  runId: string,
  brandName: string,
  competitorNames: string[]
): Promise<SoV[]> {
  // Fetch all passing judgments for this run.
  const judgments = await db()
    .selectFrom("current_judgment")
    .selectAll()
    .where("run_id", "=", runId)
    .where("guardrail_status", "=", "pass")
    .execute();

  // Count brand mentions.
  let brandMentions = 0;
  const competitorMentions: Map<string, number> = new Map(
    competitorNames.map((n) => [n, 0])
  );
  // Map from response_raw_id to competitor names for evidenceRefs.
  const brandEvidenceSet = new Set<string>();
  const competitorEvidenceSets: Map<string, Set<string>> = new Map(
    competitorNames.map((n) => [n, new Set<string>()])
  );

  for (const j of judgments) {
    if (j.brand_mentioned) {
      brandMentions++;
      brandEvidenceSet.add(j.response_raw_id);
    }

    const comps = parseCompetitorsFound(j.competitors_found);
    for (const comp of comps) {
      // rank===null means the competitor was NOT found in the answer (absent).
      // Only count competitors that are actually present (rank !== null).
      if (comp.rank === null) continue;
      // Match by name (case-insensitive) against the tracked competitor list.
      const matched = competitorNames.find(
        (n) => n.toLowerCase() === comp.name.toLowerCase()
      );
      if (matched) {
        competitorMentions.set(matched, (competitorMentions.get(matched) ?? 0) + 1);
        competitorEvidenceSets.get(matched)!.add(j.response_raw_id);
      }
    }
  }

  // Total = brand + all competitors.
  const totalMentions =
    brandMentions +
    Array.from(competitorMentions.values()).reduce((a, b) => a + b, 0);

  const results: SoV[] = [];

  // Brand SoV.
  results.push({
    metric: "sov",
    entityName: brandName,
    value: totalMentions > 0 ? brandMentions / totalMentions : 0,
    entityMentions: brandMentions,
    totalMentions,
    evidenceRefs: Array.from(brandEvidenceSet),
  });

  // Competitor SoV.
  for (const [name, mentions] of competitorMentions) {
    results.push({
      metric: "sov",
      entityName: name,
      value: totalMentions > 0 ? mentions / totalMentions : 0,
      entityMentions: mentions,
      totalMentions,
      evidenceRefs: Array.from(competitorEvidenceSets.get(name) ?? new Set()),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// computePriorityGap
// ---------------------------------------------------------------------------

/**
 * Compute Priority Gap: questions where brand SMR is low AND competitor
 * presence is high.
 *
 * For each distinct (question_id, language) pair:
 *   - brandSMR = brand_hits_for_question / total_judgments_for_question
 *   - competitorPresence = fraction of responses with ≥1 competitor mentioned
 *   - gapScore = competitorPresence − brandSMR
 *
 * Questions are sorted descending by gapScore (largest gap first).
 *
 * NOTE: the per-question denominator uses the count of judgments for that
 * question (not run.n_total), because n_total spans all questions.
 */
export async function computePriorityGap(runId: string): Promise<PriorityGap> {
  const nTotal = await fetchNTotal(runId);

  // Fetch all passing judgments plus question text.
  const rows = await db()
    .selectFrom("current_judgment as cj")
    .innerJoin("question as q", "q.id", "cj.question_id")
    .select([
      "cj.question_id",
      "q.text as question_text",
      "cj.response_raw_id",
      "cj.brand_mentioned",
      "cj.competitors_found",
      "cj.guardrail_status",
    ])
    .where("cj.run_id", "=", runId)
    .execute();

  // Aggregate per question_id.
  const questionMap = new Map<
    string,
    {
      text: string;
      total: number;
      brandHits: number;
      competitorRows: number;
      evidenceRefs: Set<string>;
    }
  >();

  for (const row of rows) {
    const key = row.question_id;
    if (!questionMap.has(key)) {
      questionMap.set(key, {
        text: row.question_text,
        total: 0,
        brandHits: 0,
        competitorRows: 0,
        evidenceRefs: new Set(),
      });
    }
    const entry = questionMap.get(key)!;
    entry.total++;

    if (row.guardrail_status === "pass") {
      if (row.brand_mentioned) {
        entry.brandHits++;
        entry.evidenceRefs.add(row.response_raw_id);
      }

      const comps = parseCompetitorsFound(row.competitors_found);
      // Count competitor presence only when at least one competitor is actually
      // present (rank !== null).  rank===null means absent — do not inflate the
      // competitorPresence rate with absent-competitor placeholders.
      if (comps.some((c) => c.rank !== null)) {
        entry.competitorRows++;
        entry.evidenceRefs.add(row.response_raw_id);
      }
    }
  }

  const questions: PriorityGapQuestion[] = [];

  for (const [questionId, entry] of questionMap) {
    if (entry.total === 0) continue;
    const brandSMR = entry.brandHits / entry.total;
    const competitorPresence = entry.competitorRows / entry.total;
    const gapScore = competitorPresence - brandSMR;

    questions.push({
      questionId,
      questionText: entry.text,
      brandSMR,
      competitorPresence,
      gapScore,
      evidenceRefs: Array.from(entry.evidenceRefs),
    });
  }

  // Sort by gapScore descending (largest gap = highest priority).
  questions.sort((a, b) => b.gapScore - a.gapScore);

  return {
    metric: "priority_gap",
    questions,
    nTotal,
  };
}

// ---------------------------------------------------------------------------
// computeDecomposition
// ---------------------------------------------------------------------------

/**
 * Compute SMR decompositions: per-model, per-language, per-question.
 *
 * Each slice denominator is derived from the FROZEN work_unit table (all
 * scheduled units for the run, grouped by model/language/question) rather than
 * from the current_judgment row count.  This ensures that errored generations
 * (which produce no judgment row) and skipped work-units are counted exactly
 * as run.n_total counts them.
 *
 * DESIGN invariant (§5.2): sum-of-slice-denominators == run.n_total (because
 * work_unit rows are inserted in the plan phase — before execution — and
 * n_total is snapshotted from workUnits.length at the same time).  The equality
 * holds even when generation errors or skips produce no judgment row, because
 * the denominator comes from work_unit, not from current_judgment.
 *
 * Numerator = brand_hits over gate-passed current_judgment rows only (unchanged).
 * judgedOk is retained in the output struct for informational display but is NOT
 * the SMR denominator.
 *
 * evidenceRefs are the response_raw_id[] for the brand-hit rows.
 */
export async function computeDecomposition(
  runId: string
): Promise<SMRDecomposition> {
  // Fetch the frozen work_unit counts per (model, language, question) slice.
  // These form the per-slice denominators and include errored/skipped units.
  const wuSlices = await countWorkUnitsBySlice(runId);

  // Build denominator maps from work_unit counts.
  const modelDenomMap = new Map<string, number>();
  const langDenomMap = new Map<string, number>();
  const questionDenomMap = new Map<string, number>();

  for (const s of wuSlices) {
    modelDenomMap.set(s.model_id, (modelDenomMap.get(s.model_id) ?? 0) + s.count);
    langDenomMap.set(s.language, (langDenomMap.get(s.language) ?? 0) + s.count);
    questionDenomMap.set(s.question_id, (questionDenomMap.get(s.question_id) ?? 0) + s.count);
  }

  // Fetch gate-passed judgment rows for the numerator + judgedOk tracking.
  const judgments = await fetchJudgments(runId);

  // --- By Model ---
  const byModelMap = new Map<
    string,
    { brandHits: number; judgedOk: number; evidenceRefs: Set<string> }
  >();

  // --- By Language ---
  const byLangMap = new Map<
    string,
    { brandHits: number; judgedOk: number; evidenceRefs: Set<string> }
  >();

  // --- By Question (need text from question table) ---
  const byQuestionMap = new Map<
    string,
    {
      language: string;
      brandHits: number;
      judgedOk: number;
      evidenceRefs: Set<string>;
    }
  >();

  // Ensure every work_unit slice key has an entry, even if no judgment rows exist.
  for (const s of wuSlices) {
    if (!byModelMap.has(s.model_id)) {
      byModelMap.set(s.model_id, { brandHits: 0, judgedOk: 0, evidenceRefs: new Set() });
    }
    if (!byLangMap.has(s.language)) {
      byLangMap.set(s.language, { brandHits: 0, judgedOk: 0, evidenceRefs: new Set() });
    }
    if (!byQuestionMap.has(s.question_id)) {
      byQuestionMap.set(s.question_id, { language: s.language, brandHits: 0, judgedOk: 0, evidenceRefs: new Set() });
    }
  }

  for (const j of judgments) {
    const isPass = j.guardrail_status === "pass";
    const isOk = j.response_status === "ok" && isPass;
    const isBrandHit = j.brand_mentioned && isPass;

    // Model
    if (!byModelMap.has(j.model_id)) {
      byModelMap.set(j.model_id, { brandHits: 0, judgedOk: 0, evidenceRefs: new Set() });
    }
    const mEntry = byModelMap.get(j.model_id)!;
    if (isOk) mEntry.judgedOk++;  // informational only — NOT the SMR denominator
    if (isBrandHit) {
      mEntry.brandHits++;
      mEntry.evidenceRefs.add(j.response_raw_id);
    }

    // Language
    if (!byLangMap.has(j.language)) {
      byLangMap.set(j.language, { brandHits: 0, judgedOk: 0, evidenceRefs: new Set() });
    }
    const lEntry = byLangMap.get(j.language)!;
    if (isOk) lEntry.judgedOk++;
    if (isBrandHit) {
      lEntry.brandHits++;
      lEntry.evidenceRefs.add(j.response_raw_id);
    }

    // Question
    if (!byQuestionMap.has(j.question_id)) {
      byQuestionMap.set(j.question_id, { language: j.language, brandHits: 0, judgedOk: 0, evidenceRefs: new Set() });
    }
    const qEntry = byQuestionMap.get(j.question_id)!;
    if (isOk) qEntry.judgedOk++;
    if (isBrandHit) {
      qEntry.brandHits++;
      qEntry.evidenceRefs.add(j.response_raw_id);
    }
  }

  // Fetch question texts for the question decomposition.
  const questionIds = Array.from(byQuestionMap.keys());
  const questionTexts = new Map<string, string>();

  if (questionIds.length > 0) {
    const qRows = await db()
      .selectFrom("question")
      .select(["id", "text"])
      .where("id", "in", questionIds)
      .execute();
    for (const qr of qRows) {
      questionTexts.set(qr.id, qr.text);
    }
  }

  // SMR = brandHits / sliceTotal where sliceTotal is from frozen work_unit counts,
  // so errored/skipped units are counted exactly as n_total counts them.
  const byModel: SMRByModel[] = Array.from(byModelMap.entries()).map(
    ([modelId, e]) => {
      const sliceTotal = modelDenomMap.get(modelId) ?? 0;
      return {
        modelId,
        smr: sliceTotal > 0 ? e.brandHits / sliceTotal : 0,
        brandHits: e.brandHits,
        judgedOk: e.judgedOk,
        evidenceRefs: Array.from(e.evidenceRefs),
      };
    }
  );

  const byLanguage: SMRByLanguage[] = Array.from(byLangMap.entries()).map(
    ([language, e]) => {
      const sliceTotal = langDenomMap.get(language) ?? 0;
      return {
        language,
        smr: sliceTotal > 0 ? e.brandHits / sliceTotal : 0,
        brandHits: e.brandHits,
        judgedOk: e.judgedOk,
        evidenceRefs: Array.from(e.evidenceRefs),
      };
    }
  );

  const byQuestion: SMRByQuestion[] = Array.from(
    byQuestionMap.entries()
  ).map(([questionId, e]) => {
    const sliceTotal = questionDenomMap.get(questionId) ?? 0;
    return {
      questionId,
      questionText: questionTexts.get(questionId) ?? "",
      language: e.language,
      smr: sliceTotal > 0 ? e.brandHits / sliceTotal : 0,
      brandHits: e.brandHits,
      judgedOk: e.judgedOk,
      evidenceRefs: Array.from(e.evidenceRefs),
    };
  });

  return { byModel, byLanguage, byQuestion };
}

// ---------------------------------------------------------------------------
// computeCitationShareByModel (SOTA sweep proposal D)
// ---------------------------------------------------------------------------

/**
 * Per-engine citation share = citation_hits(model) / work_unit_count(model).
 *
 * Mirrors the SMR byModel slice but counts citations (citation_present ∧
 * brand_mentioned ∧ pass) over the SAME frozen work_unit denominators, with a
 * Wilson CI + lowPower flag per engine. Surfaces "mention vs clickable-citation,
 * per engine" — the channels-behave-differently insight, with NO uplift targets.
 */
export async function computeCitationShareByModel(
  runId: string,
): Promise<CitationByModel[]> {
  const [wuSlices, judgments] = await Promise.all([
    countWorkUnitsBySlice(runId),
    fetchJudgments(runId),
  ]);
  return tallyCitationShareByModel(wuSlices, judgments);
}

// ---------------------------------------------------------------------------
// computePerPromptVisibility (SOTA sweep proposal C)
// ---------------------------------------------------------------------------

/**
 * Per-prompt mention rate with a Wilson CI, one row per (question, model,
 * language) sampling cell. nSamples = frozen work_unit count for the cell;
 * brandHits = gate-passed mentions in the cell. lowPower flags nSamples < 30.
 *
 * HONESTY: this interval is strictly NOISIER than the run-level SMR CI (smaller
 * n); at the usual N=3–5 most cells are flagged lowPower — the honest outcome.
 * It is NOT presented as tighter or more certain than the run-level number.
 */
export async function computePerPromptVisibility(
  runId: string,
): Promise<PerPromptVisibility[]> {
  const [wuSlices, judgments] = await Promise.all([
    countWorkUnitsBySlice(runId),
    fetchJudgments(runId),
  ]);
  return tallyPerPromptVisibility(wuSlices, judgments);
}


// ---------------------------------------------------------------------------
// computeAbstainStats
// ---------------------------------------------------------------------------

/**
 * Compute abstain count and rate for a run.
 * abstain rows have provenance='abstain' OR guardrail_status='downgraded_abstain'.
 */
export async function computeAbstainStats(runId: string): Promise<{
  abstainCount: number;
  abstainRate: number;
}> {
  const nTotal = await fetchNTotal(runId);

  const row = await db()
    .selectFrom("current_judgment")
    .select(
      sql<string>`count(*) filter (
        where provenance = 'abstain' or guardrail_status = 'downgraded_abstain'
      )`.as("abstain_count")
    )
    .where("run_id", "=", runId)
    .executeTakeFirst();

  const abstainCount = parseInt(row?.abstain_count ?? "0", 10);

  return {
    abstainCount,
    abstainRate: nTotal > 0 ? abstainCount / nTotal : 0,
  };
}
