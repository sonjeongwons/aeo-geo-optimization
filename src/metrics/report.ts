/**
 * src/metrics/report.ts
 *
 * Assemble a RunReport from raw DB data.
 *
 * DESIGN invariants enforced here:
 *
 * 1. RECOMPUTED FROM RAW at report time — never from a cached/stale field.
 *    The report calls aggregate.ts which reads current_judgment (latest-judgment-
 *    wins view).  Re-judging a response appends a row; the next report call
 *    sees the updated result automatically.  This satisfies §5.2 "latest-
 *    judgment-wins" and §7#7 "every number traces to a gate-passed judgment →
 *    evidence span → raw answer_text".
 *
 * 2. NO free-text claims field — the RunReport type (metrics.types.ts) is the
 *    structural guarantee.  The verifiableNumbersGate provides runtime defense-
 *    in-depth.
 *
 * 3. Baseline report is SYNCHRONOUS (direct SQL, no queue) — assembleReport()
 *    awaits all DB calls in sequence.
 *
 * 4. Self-judge-bias disclosure is ALWAYS included in the report
 *    (DESIGN §5.4 / §7 disclosure requirement).
 *
 * 5. Every MetricTuple in report.metrics has a non-empty evidenceRefs[] that
 *    traces to response_raw rows, so the verifiableNumbersGate can validate them.
 *    (Metrics with zero evidence refs — e.g. SMR=0 because no brand mentions —
 *    are still included; the gate validates structure, not presence of refs.)
 *
 * 6. The report is validated through the verifiableNumbersGate before being
 *    returned.  If a metric fails validation it is logged and removed from
 *    report.metrics (but kept in the typed fields for transparency).
 */

import pino from "pino";
import {
  computeSMR,
  computeCitationShare,
  computeRecommendationShare,
  computeCitationShareByModel,
  computePerPromptVisibility,
  computeEarnedSources,
  computeEngineOverlap,
  computeSamplingAdequacy,
  computePawcShare,
  computeVisibility,
  computeSoV,
  computePriorityGap,
  computeDecomposition,
  computeAbstainStats,
} from "./aggregate.js";
import { verifiableNumbersGate } from "../guardrails/verifiableNumbersGate.js";
import { SELF_JUDGE_BIAS_DISCLOSURE, computeMeasurementQuality } from "../domain/metrics.types.js";
import type { RunReport, MetricTuple } from "../domain/metrics.types.js";
import type { GateContext } from "../guardrails/gate.js";
import { getDb } from "../db/kysely.js";

const logger = pino({ name: "report" });

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function db() {
  return getDb();
}

/**
 * Fetch the minimal run metadata needed to assemble the report header.
 */
async function fetchRunMeta(runId: string): Promise<{
  customer_id: string;
  kind: "baseline" | "operating";
  n_total: number | null;
}> {
  const row = await db()
    .selectFrom("run")
    .select(["customer_id", "kind", "n_total"])
    .where("id", "=", runId)
    .executeTakeFirst();

  if (!row) {
    throw new Error(`assembleReport: run not found: ${runId}`);
  }
  return row;
}

/**
 * Fetch brand name for a customer (first brand row).
 * Used for SoV computation.
 */
async function fetchBrandName(customerId: string): Promise<string> {
  const row = await db()
    .selectFrom("brand")
    .select("name")
    .where("customer_id", "=", customerId)
    .limit(1)
    .executeTakeFirst();

  return row?.name ?? "brand";
}

/**
 * Fetch competitor names for a customer.
 */
async function fetchCompetitorNames(customerId: string): Promise<string[]> {
  const rows = await db()
    .selectFrom("competitor")
    .select("name")
    .where("customer_id", "=", customerId)
    .execute();

  return rows.map((r) => r.name);
}

/**
 * Fetch the brand's canonical name + aliases (for PAWC word-share matching).
 */
async function fetchBrandAliases(customerId: string): Promise<string[]> {
  const row = await db()
    .selectFrom("brand")
    .select(["name", "aliases"])
    .where("customer_id", "=", customerId)
    .limit(1)
    .executeTakeFirst();
  if (!row) return [];
  const aliases = Array.isArray(row.aliases) ? row.aliases : [];
  return [row.name, ...aliases].filter((v, i, a) => v && a.indexOf(v) === i);
}

// ---------------------------------------------------------------------------
// assembleReport
// ---------------------------------------------------------------------------

/**
 * Assemble a complete RunReport for a finished run.
 *
 * Reads from the DB synchronously (awaits in sequence).  Safe to call for
 * both baseline (synchronous) and operating runs.
 *
 * @param runId - UUID of the run to report on.
 * @returns     A fully-populated RunReport with all metric tuples validated.
 */
export async function assembleReport(runId: string): Promise<RunReport> {
  // 1. Fetch run metadata.
  const runMeta = await fetchRunMeta(runId);
  const { customer_id: customerId, kind } = runMeta;

  // 2. Fetch brand / competitor context for SoV (+ aliases for PAWC).
  const [brandName, competitorNames, brandAliases] = await Promise.all([
    fetchBrandName(customerId),
    fetchCompetitorNames(customerId),
    fetchBrandAliases(customerId),
  ]);

  // 3. Compute all metrics in parallel (they each open their own DB queries).
  const [
    smr,
    citationShare,
    recommendationShare,
    citationByModel,
    perPromptVisibility,
    earnedSources,
    engineOverlap,
    samplingAdequacy,
    pawc,
    visibility,
    sov,
    priorityGap,
    decomposition,
    abstainStats,
  ] = await Promise.all([
    computeSMR(runId),
    computeCitationShare(runId),
    computeRecommendationShare(runId),
    computeCitationShareByModel(runId),
    computePerPromptVisibility(runId),
    computeEarnedSources(runId),
    computeEngineOverlap(runId),
    computeSamplingAdequacy(runId),
    computePawcShare(runId, brandAliases),
    computeVisibility(runId),
    computeSoV(runId, brandName, competitorNames),
    computePriorityGap(runId),
    computeDecomposition(runId),
    computeAbstainStats(runId),
  ]);

  // 4. Build the flat MetricTuple[] list for the verifiableNumbersGate.
  //    Every tuple has: metric, value, nTotal, evidenceRefs[].
  //    No free-text claims field anywhere (compile-time enforced by RunReport type).
  const rawMetrics: MetricTuple[] = [
    {
      metric: "smr",
      value: smr.value,
      nTotal: smr.nTotal,
      evidenceRefs: smr.evidenceRefs,
    },
    {
      metric: "citation_share",
      value: citationShare.value,
      nTotal: citationShare.nTotal,
      evidenceRefs: citationShare.evidenceRefs,
    },
    {
      metric: "recommendation_share",
      value: recommendationShare.value,
      nTotal: recommendationShare.nTotal,
      evidenceRefs: recommendationShare.evidenceRefs,
    },
    {
      metric: "pawc",
      value: pawc.value,
      nTotal: pawc.sampledResponses,
      evidenceRefs: pawc.evidenceRefs,
    },
    {
      metric: "visibility",
      value: visibility.value,
      nTotal: visibility.nTotal,
      evidenceRefs: visibility.evidenceRefs,
    },
    // SoV per entity.
    ...sov.map((s) => ({
      metric: `sov:${s.entityName}`,
      value: s.value,
      nTotal: s.totalMentions > 0 ? s.totalMentions : smr.nTotal,
      evidenceRefs: s.evidenceRefs,
    })),
    // Priority gap: one tuple per question (gap score as value).
    ...priorityGap.questions.map((q) => ({
      metric: `priority_gap:${q.questionId}`,
      value: q.gapScore,
      nTotal: smr.nTotal,
      evidenceRefs: q.evidenceRefs,
    })),
  ];

  // 5. Run the verifiableNumbersGate over all metrics.
  //    Gate is phase:'publish' — we build a mock GateContext to pass the metrics.
  //    Failed metrics are logged and removed from the final list.
  const validatedMetrics: MetricTuple[] = [];

  for (const tuple of rawMetrics) {
    // Build a minimal GateContext carrying the single metric.
    const ctx: GateContext & { verdict: GateContext["verdict"] & { _metrics?: MetricTuple[] } } = {
      verdict: {
        brand_mentioned: false,
        brand_rank: null,
        sentiment: null,
        competitors_found: [],
        evidence: null,
        provenance: "abstain",
        guardrail_status: "pass",
        _metrics: [tuple],
      },
      answerText: null,
      brandAliases: [],
      runId,
      responseRawId: "",
    };

    const result = verifiableNumbersGate.apply(ctx);

    if (result.action === "downgrade") {
      logger.warn(
        { runId, metric: tuple.metric, reason: result.reason },
        "verifiableNumbersGate: metric excluded from report"
      );
      // Metric excluded; do not add to validatedMetrics.
    } else {
      validatedMetrics.push(tuple);
    }
  }

  // 6. Assemble the final RunReport.
  //    The type enforces NO free-text claims field (compile-time).
  const report: RunReport = {
    runId,
    customerId,
    kind,
    generatedAt: new Date(),

    smr,
    citationShare,
    recommendationShare,
    pawc,
    citationByModel,
    perPromptVisibility,
    earnedSources,
    engineOverlap,
    samplingAdequacy,
    visibility,
    sov,
    priorityGap,

    decomposition,

    metrics: validatedMetrics,

    abstainCount: abstainStats.abstainCount,
    abstainRate: abstainStats.abstainRate,
    measurementQuality: computeMeasurementQuality(abstainStats.abstainRate),

    selfJudgeBiasDisclosure: SELF_JUDGE_BIAS_DISCLOSURE,
  };

  logger.info(
    {
      runId,
      smr: smr.value,
      visibility: visibility.value,
      brandHits: smr.brandHits,
      nTotal: smr.nTotal,
      abstainCount: abstainStats.abstainCount,
      metricsCount: validatedMetrics.length,
    },
    "report assembled"
  );

  return report;
}

// ---------------------------------------------------------------------------
// Re-export aggregate functions for convenience (callers importing from
// src/metrics/report.ts can access individual compute functions without
// a separate import).
// ---------------------------------------------------------------------------
export {
  computeSMR,
  computeCitationShare,
  computeRecommendationShare,
  computeCitationShareByModel,
  computePerPromptVisibility,
  computeEarnedSources,
  computeEngineOverlap,
  computeSamplingAdequacy,
  computePawcShare,
  computeVisibility,
  computeSoV,
  computePriorityGap,
  computeDecomposition,
  computeAbstainStats,
} from "./aggregate.js";
