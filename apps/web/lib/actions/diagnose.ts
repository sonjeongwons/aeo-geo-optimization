"use server";

/**
 * apps/web/lib/actions/diagnose.ts
 *
 * Server Action: free-diagnostic funnel (P5-T12).
 *
 * Flow:
 *   1. Check per-IP/day hard cost cap (§11 budget gate). Block if exceeded.
 *   2. Find the pre-configured demo/lead customer (DEMO_CUSTOMER_SLUG env var).
 *   3. Assemble RunCycleDeps from the demo customer's DB rows.
 *   4. Call runCycle({ customerId, kind: 'baseline' }, deps) synchronously.
 *   5. redirect() to /diagnose/[runId] (the result page).
 *
 * IMPORTANT: The diagnostic runs ONLY for the demo/lead-scoped customer —
 * NOT for an arbitrary cold URL. An arbitrary URL has no template/brands/
 * questions/budget configured and would require Phase 1 genTemplate + a real
 * customer row + real Gemini spend, all of which are out of Phase 5 scope.
 * The "URL or brand name" input is used for display only (stored on the run
 * row as a tag — future work) and does not change which customer is measured.
 *
 * Per-IP cap:
 *   In-memory Map keyed by {ip}:{YYYY-MM-DD}. Default 3 diagnoses per IP per
 *   day (overridable via DIAGNOSE_IP_DAILY_CAP env var). This is appropriate
 *   for a single-process Next.js deployment; for multi-replica deployments a
 *   Redis or DB counter should replace it.
 *
 * §0: never fabricates metrics — real RunReport or error.
 * §11: tied to the §11 budget gate (weeklyUsdCap on the demo customer).
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { DEMO_CUSTOMER_SLUG } from "../demo";
import { findCustomerBySlug } from "@engine/db/repo";
import {
  findLatestCompletedBaselineRun,
  findBrandsByCustomer,
  findCompetitorsByCustomer,
  findActiveQuestions,
  findCustomerLanguages,
  findBudget,
  findEnabledModels,
  insertLlmCall,
  lookupResponseCache,
  insertResponseCache,
  sumCostSince,
  customerHasPriorLlmCall,
} from "@engine/db/repo";
import { buildRegistry } from "@engine/providers/registry";
import { runCycle } from "@engine/pipeline/runCycle";
import { runResponse } from "@engine/pipeline/runResponse";
import { Ledger } from "@engine/cost/ledger";
import { evidenceRequiredGate } from "@engine/guardrails/evidenceRequiredGate";
import { wireSurfaces } from "@engine/surfaces/wireSurfaces";
import type { ModelRef, CustomerLanguage, Budget, Question } from "@engine/domain/types";

// ---------------------------------------------------------------------------
// Per-IP/day cap
// ---------------------------------------------------------------------------

/**
 * In-memory rate-limit store: Map<"{ip}:{date}", count>
 * Entries older than today are never evicted (bounded to daily reset naturally).
 * Max memory: O(unique-IPs × 1) — negligible.
 */
const ipDayHits = new Map<string, number>();

/** Maximum diagnose calls per IP per day. Override via DIAGNOSE_IP_DAILY_CAP. */
const IP_DAILY_CAP: number = (() => {
  const v = process.env["DIAGNOSE_IP_DAILY_CAP"];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

function todayKey(ip: string): string {
  const d = new Date();
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${ip}:${date}`;
}

/**
 * Check and increment the per-IP/day hit counter.
 * Returns true if the request is allowed (cap not exceeded).
 */
function checkIpCap(ip: string): boolean {
  const key = todayKey(ip);
  const count = ipDayHits.get(key) ?? 0;
  if (count >= IP_DAILY_CAP) return false;
  ipDayHits.set(key, count + 1);
  return true;
}

// ---------------------------------------------------------------------------
// State returned on error (Server Action result shape)
// ---------------------------------------------------------------------------

export interface DiagnoseState {
  error?: string;
}

// ---------------------------------------------------------------------------
// Server Action
// ---------------------------------------------------------------------------

/**
 * runDiagnose — Server Action for the free-diagnostic funnel.
 *
 * Bound to the marketing page form via `action={runDiagnose}`.
 * On success: redirects to /diagnose/[runId].
 * On error: returns { error } for the form to display.
 */
export async function runDiagnose(
  _prevState: DiagnoseState,
  formData: FormData,
): Promise<DiagnoseState> {
  // -------------------------------------------------------------------------
  // 1. Resolve caller IP from request headers.
  // -------------------------------------------------------------------------
  const headerStore = await headers();
  const ip =
    headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headerStore.get("x-real-ip") ??
    "unknown";

  // -------------------------------------------------------------------------
  // 2. Per-IP/day cost cap (§11 budget gate).
  //    Hard block — no LLM spend is incurred when capped.
  // -------------------------------------------------------------------------
  if (!checkIpCap(ip)) {
    return {
      error: `일일 진단 한도(${IP_DAILY_CAP}회)를 초과했습니다. 내일 다시 시도해 주세요.`,
    };
  }

  // Capture the user-supplied brand/URL label (display only — does not change
  // which customer is measured; the demo customer is always used).
  const _brandInput = String(formData.get("url") ?? "").trim();

  // -------------------------------------------------------------------------
  // 3. Find the demo customer.
  // -------------------------------------------------------------------------
  const customer = await findCustomerBySlug(DEMO_CUSTOMER_SLUG);
  if (!customer) {
    return {
      error:
        "데모 고객이 아직 설정되지 않았습니다. 관리자에게 문의해 주세요.",
    };
  }
  const customerId = customer.id;

  // -------------------------------------------------------------------------
  // 3b. REUSE an existing baseline run for the demo customer if one exists.
  //     The free-diagnostic shows the customer's CURRENT position (§5.7), so a
  //     pre-seeded demo customer should redirect to its latest baseline rather
  //     than synchronously re-running a full baseline cycle (which can be 1000+
  //     work-units / many minutes on the free Gemini tier inside one request).
  //     A fresh cycle only runs when no baseline exists yet.
  // -------------------------------------------------------------------------
  const existingBaseline = await findLatestCompletedBaselineRun(customerId);
  if (existingBaseline) {
    redirect(`/diagnose/${existingBaseline.id}`);
  }

  // -------------------------------------------------------------------------
  // 4. Load all context rows in parallel.
  // -------------------------------------------------------------------------
  const [brands, competitorRows, questionRows, langRows, budgetRow, allEnabledModels] =
    await Promise.all([
      findBrandsByCustomer(customerId),
      findCompetitorsByCustomer(customerId),
      findActiveQuestions(customerId),
      findCustomerLanguages(customerId),
      findBudget(customerId),
      findEnabledModels(),
    ]);

  if (brands.length === 0) {
    return { error: "데모 고객에 브랜드가 설정되지 않았습니다." };
  }
  if (!budgetRow) {
    return { error: "데모 고객의 예산이 설정되지 않았습니다." };
  }

  // -------------------------------------------------------------------------
  // 5. Build provider registry (read-only; re-used per-request).
  // -------------------------------------------------------------------------
  const registry = buildRegistry();

  const adapters = new Map(
    registry
      .all()
      .filter((a) => a.status === "ready")
      .map((a) => [a.provider, a]),
  );

  const judgeAdapter = registry.get("gemini");
  if (!judgeAdapter || judgeAdapter.status !== "ready") {
    return {
      error:
        "진단 엔진이 현재 준비 중입니다(GEMINI_API_KEY 미설정). 잠시 후 다시 시도해 주세요.",
    };
  }

  // -------------------------------------------------------------------------
  // 6. Assemble typed deps.
  // -------------------------------------------------------------------------
  const brand = brands[0]!;
  const competitors = competitorRows.map((c) => ({
    name: c.name,
    aliases: c.aliases,
  }));

  const questions: Question[] = questionRows.map((q) => ({
    id: q.id,
    customerId,
    text: q.text,
    language: q.language,
    funnelStage: q.funnel_stage,
    densityTier: q.density_tier,
    active: true,
  }));

  const languages: CustomerLanguage[] = langRows.map((l) => ({
    customerId,
    language: l.language,
    weight: parseFloat(l.weight),
  }));

  const budget: Budget = {
    customerId,
    maxModels: budgetRow.max_models,
    maxSamples: budgetRow.max_samples,
    maxLanguages: budgetRow.max_languages,
    weeklyUsdCap: parseFloat(budgetRow.weekly_usd_cap),
    monthlyUsdCap: parseFloat(budgetRow.monthly_usd_cap),
  };

  // Wire v1-b surface adapters (baseline only: SERP surfaces, no scrape).
  const { surfaceModels, surfaceAdapters } = wireSurfaces({
    registryAdapters: registry.all(),
    runKind: "baseline",
  });
  for (const [key, adapter] of surfaceAdapters) {
    adapters.set(key, adapter);
  }

  const readyProviders = new Set(adapters.keys());
  const chatModels: ModelRef[] = allEnabledModels
    .filter((m) => readyProviders.has(m.provider))
    .map((m) => ({
      id: m.id,
      provider: m.provider,
      modality: "chat" as const,
      capabilities: [
        "generate" as const,
        "judge" as const,
        "structured" as const,
      ],
      isCheapMonitor: m.is_cheap_monitor,
      isJudge: m.is_judge,
      inputUsdPerMtok: parseFloat(m.input_usd_per_mtok),
      outputUsdPerMtok: parseFloat(m.output_usd_per_mtok),
      enabled: true,
    }));

  const models: ModelRef[] = [...chatModels, ...surfaceModels];

  // Cost reader (for preflight budget check).
  const costReader = {
    getRollingSpendUsd: async (
      cid: string,
      windowDays: number,
    ): Promise<number | null> => {
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
      return sumCostSince(cid, since);
    },
  };

  // Ledger (llm_call rows).
  const ledger = new Ledger({
    insertLlmCall: async (row) => {
      await insertLlmCall({
        customerId: row.customerId,
        runId: row.runId,
        purpose: row.purpose,
        provider: row.provider,
        modelId: row.modelId,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        usd: row.usd,
        cacheHit: row.cacheHit,
        responseRawId: row.responseRawId,
      });
    },
  });

  // Cache functions.
  const cacheFns = {
    findByHash: async (requestHash: string) => {
      const row = await lookupResponseCache(requestHash);
      if (!row) return null;
      return { answerText: row.answer_text, createdAt: row.created_at };
    },
    upsert: async (requestHash: string, answerText: string) => {
      await insertResponseCache({ requestHash, answerText });
    },
  };

  // Inline response handler (baseline = synchronous, no queue).
  const responseRunHandler = async (
    payload: Parameters<
      NonNullable<Parameters<typeof runCycle>[1]["responseRunHandler"]>
    >[0],
    runResponseDeps: Parameters<
      NonNullable<Parameters<typeof runCycle>[1]["responseRunHandler"]>
    >[1],
  ) => {
    await runResponse(payload, runResponseDeps);
  };

  const hasPriorCall = await customerHasPriorLlmCall(customerId);

  // -------------------------------------------------------------------------
  // 7. Run the baseline cycle (synchronous, in-process).
  // -------------------------------------------------------------------------
  let report;
  try {
    report = await runCycle({ customerId, kind: "baseline" }, {
      responseRunHandler,
      customerSlug: DEMO_CUSTOMER_SLUG,
      brand: { name: brand.name, aliases: brand.aliases },
      competitors,
      questions,
      models,
      languages,
      budget,
      adapters,
      judgeAdapter,
      costReader,
      ledger,
      cacheFns,
      gates: [evidenceRequiredGate],
      isNewCustomer: !hasPriorCall,
      currentCycleIndex: 0,
    });
  } catch (err) {
    return {
      error: `진단 실패: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!report) {
    return {
      error:
        "진단이 완료되었으나 리포트를 생성할 수 없습니다 (예산 초과 또는 활성 질문 없음).",
    };
  }

  // -------------------------------------------------------------------------
  // 8. Redirect to the result page.
  //    redirect() throws internally — it must not be inside a try/catch.
  // -------------------------------------------------------------------------
  redirect(`/diagnose/${report.runId}`);
}
