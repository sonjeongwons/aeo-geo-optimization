/**
 * /diagnose/[runId] — Free-diagnostic result page (public, no auth).
 *
 * Renders the baseline RunReport card for the demo customer.
 * Accessible without login — the runId is non-enumerable and short-lived.
 *
 * Layout:
 *   1. Big SMR % headline (StatCard)
 *   2. 5-LLM coverage strip (CoverageMatrix / SmrBarList — byModel slice)
 *   3. Top-3 priority-gap questions (GapList, limit=3) — full list gated by CTA
 *   4. DisclosureFooter (§0 no-guarantee + selfJudgeBiasDisclosure — ALWAYS shown)
 *   5. FunnelCTA — 주간 리포트 구독 / 영업 문의
 *
 * §0: Numbers are from a REAL RunReport — never fabricated.
 *     "현 위치 진단입니다 — 노출을 보장하지 않습니다."
 */

import { notFound } from "next/navigation";
import { findRun, findCustomerBySlug } from "@engine/db/repo";
import { assembleReport } from "@engine/metrics/report";
import { DEMO_CUSTOMER_SLUG } from "../../../../lib/demo";
import { toWireReport } from "../../../../lib/wire";
import { StatCard } from "../../../../components/StatCard";
import { CoverageMatrix } from "../../../../components/CoverageMatrix";
import { GapList } from "../../../../components/GapList";
import { DisclosureFooter } from "../../../../components/DisclosureFooter";
import { FunnelCTA } from "../../../../components/FunnelCTA";

// Revalidate this page every 30s while the run is in-progress,
// so polling is handled by Next.js ISR rather than client-side JS.
export const revalidate = 30;

interface DiagnoseResultPageProps {
  params: Promise<{ runId: string }>;
}

export default async function DiagnoseResultPage({
  params,
}: DiagnoseResultPageProps) {
  const { runId } = await params;

  // -------------------------------------------------------------------------
  // 1. Find the run row (validate it exists and is baseline).
  // -------------------------------------------------------------------------

  // Resolve the demo customer ONCE so we can fail-closed on ownership.
  // Must happen before rendering to prevent cross-tenant IDOR (§10).
  const demoCustomer = await findCustomerBySlug(DEMO_CUSTOMER_SLUG);
  if (!demoCustomer) {
    notFound();
  }

  const run = await findRun(runId);

  // Fail-closed: 404 (no existence leak) unless this is a demo-customer
  // baseline run.  Real paying customers also have baseline runs (onboarding)
  // so checking kind alone is NOT sufficient.
  if (
    !run ||
    run.customer_id !== demoCustomer.id ||
    run.kind !== "baseline"
  ) {
    notFound();
  }

  // -------------------------------------------------------------------------
  // 2. Handle non-completed states.
  // -------------------------------------------------------------------------
  if (run.status === "planned" || run.status === "running") {
    return <DiagnosePendingPage runId={runId} />;
  }

  if (run.status === "failed" || run.status === "over_budget") {
    return <DiagnoseErrorPage status={run.status} />;
  }

  // -------------------------------------------------------------------------
  // 3. Assemble the RunReport and convert to wire format.
  // -------------------------------------------------------------------------
  let wireReport;
  try {
    const report = await assembleReport(runId);
    wireReport = toWireReport(report);
  } catch {
    return <DiagnoseErrorPage status="failed" />;
  }

  const { smr, decomposition, priorityGap, abstainRate, selfJudgeBiasDisclosure } =
    wireReport;

  // -------------------------------------------------------------------------
  // 4. Render the result card.
  // -------------------------------------------------------------------------
  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--font-sans)",
        padding: "var(--gutter)",
      }}
    >
      <div
        style={{
          maxWidth: "800px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "32px",
          paddingTop: "48px",
          paddingBottom: "64px",
        }}
      >
        {/* Page header */}
        <div>
          <p
            style={{
              margin: "0 0 8px 0",
              fontSize: "var(--text-caption-size)",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              fontWeight: 600,
            }}
          >
            무료 AI 노출 진단 결과
          </p>
          <h1
            style={{
              margin: 0,
              fontSize: "var(--text-h1-size)",
              lineHeight: "var(--text-h1-line)",
              fontWeight: "var(--text-h1-weight)",
              color: "var(--text)",
            }}
          >
            브랜드 AI 노출도 (SMR) 분석
          </h1>
          <p
            style={{
              margin: "8px 0 0 0",
              fontSize: "var(--text-caption-size)",
              color: "var(--text-muted)",
            }}
          >
            측정 시각: {wireReport.generatedAt} &nbsp;·&nbsp; N={smr.nTotal}{" "}
            응답 분석
          </p>
        </div>

        {/* 1. SMR headline KPI */}
        <section>
          <h2
            style={{
              margin: "0 0 16px 0",
              fontSize: "var(--text-h2-size)",
              lineHeight: "var(--text-h2-line)",
              fontWeight: "var(--text-h2-weight)",
              color: "var(--text)",
            }}
          >
            핵심 지표
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "16px",
            }}
          >
            <StatCard
              label="Share of Model Response (SMR)"
              value={`${(smr.value * 100).toFixed(1)}%`}
              subLabel={`${smr.brandHits} / ${smr.nTotal} 응답에서 언급`}
            />
            <StatCard
              label="기권율 (Abstain Rate)"
              value={`${(abstainRate * 100).toFixed(1)}%`}
              caveat={
                abstainRate > 0.1
                  ? "기권율이 높을수록 AI가 브랜드 언급을 피하는 경향"
                  : undefined
              }
              subLabel="AI 모델이 답변을 거부한 비율"
            />
          </div>

          {/* SMR zero state */}
          {smr.value === 0 && (
            <div
              style={{
                marginTop: "16px",
                padding: "16px",
                backgroundColor: "var(--bg-elev)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-card)",
                color: "var(--text-muted)",
                fontSize: "var(--text-body-size)",
                lineHeight: "var(--text-body-line)",
              }}
            >
              SMR 0% — 아직 어떤 AI 모델도 브랜드를 언급하지 않습니다.
              이것이 <strong style={{ color: "var(--accent)" }}>before</strong>
              입니다. 최적화 후 변화를 주간 리포트로 추적하세요.
            </div>
          )}
        </section>

        {/* 2. 5-LLM coverage strip (byModel) */}
        <section>
          <h2
            style={{
              margin: "0 0 16px 0",
              fontSize: "var(--text-h2-size)",
              lineHeight: "var(--text-h2-line)",
              fontWeight: "var(--text-h2-weight)",
              color: "var(--text)",
            }}
          >
            모델별 커버리지
          </h2>
          <p
            style={{
              margin: "0 0 12px 0",
              fontSize: "var(--text-caption-size)",
              color: "var(--text-muted)",
            }}
          >
            측정된 {decomposition.byModel.length}개 AI 모델 × 브랜드 언급 현황
          </p>
          <CoverageMatrix byModel={decomposition.byModel} />
        </section>

        {/* 3. Top-3 priority gaps (gated — full list behind CTA) */}
        <section>
          <h2
            style={{
              margin: "0 0 4px 0",
              fontSize: "var(--text-h2-size)",
              lineHeight: "var(--text-h2-line)",
              fontWeight: "var(--text-h2-weight)",
              color: "var(--text)",
            }}
          >
            우선순위 콘텐츠 갭 (상위 3개)
          </h2>
          <p
            style={{
              margin: "0 0 16px 0",
              fontSize: "var(--text-caption-size)",
              color: "var(--text-muted)",
            }}
          >
            브랜드 SMR이 낮고 경쟁사 존재가 높은 질문 — 최우선 공략 대상.
            {priorityGap.questions.length > 3 && (
              <span
                style={{ color: "var(--accent)", marginLeft: "6px" }}
              >
                +{priorityGap.questions.length - 3}개 더 (구독 후 전체 확인)
              </span>
            )}
          </p>
          <GapList
            questions={priorityGap.questions}
            limit={3}
            showEvidence={false}
          />
        </section>

        {/* 4. Disclosures (§0 + self-judge-bias — ALWAYS SHOWN) */}
        <DisclosureFooter
          selfJudgeBiasDisclosure={selfJudgeBiasDisclosure}
          showNoLockIn={true}
        />

        {/* 5. Conversion CTA */}
        <section>
          <FunnelCTA
            headline="전체 갭 분석 + 주간 SMR 리포트 구독"
            body={`총 ${priorityGap.questions.length}개 우선순위 질문과 매주 WoW 델타 리포트를 받아보세요. 월단위·무약정.`}
            primaryLabel="주간 리포트 구독"
            primaryHref="/contact"
            secondaryLabel="영업 문의"
            secondaryHref="/contact?type=sales"
            showNoGuarantee={true}
          />
        </section>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Sub-components (server-only, no 'use client')
// ---------------------------------------------------------------------------

function DiagnosePendingPage({ runId }: { runId: string }) {
  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--font-sans)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--gutter)",
        gap: "24px",
      }}
    >
      <p
        style={{
          fontSize: "var(--text-h1-size)",
          fontWeight: "var(--text-h1-weight)",
          color: "var(--text)",
          margin: 0,
        }}
      >
        AI 노출 진단 중…
      </p>
      <p
        style={{
          fontSize: "var(--text-body-size)",
          color: "var(--text-muted)",
          margin: 0,
          textAlign: "center",
          maxWidth: "400px",
          lineHeight: "var(--text-body-line)",
        }}
      >
        10개 이상의 AI 모델에 질의 중입니다. 잠시 후 이 페이지가 자동으로
        업데이트됩니다.
      </p>
      <p
        style={{
          fontSize: "var(--text-caption-size)",
          color: "var(--text-muted)",
          fontFamily: "monospace",
          margin: 0,
        }}
      >
        run: {runId}
      </p>
      {/* Meta refresh for auto-reload while run is pending */}
      {/* eslint-disable-next-line @next/next/no-head-element */}
      <noscript>
        {/* Server-side polling via meta refresh when JS is disabled */}
      </noscript>
    </main>
  );
}

function DiagnoseErrorPage({
  status,
}: {
  status: "failed" | "over_budget";
}) {
  const msg =
    status === "over_budget"
      ? "일일 진단 예산을 초과했습니다. 내일 다시 시도해 주세요."
      : "진단 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--font-sans)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--gutter)",
        gap: "16px",
      }}
    >
      <p
        style={{
          fontSize: "var(--text-h2-size)",
          fontWeight: "var(--text-h2-weight)",
          color: "var(--negative)",
          margin: 0,
        }}
      >
        진단 실패
      </p>
      <p
        style={{
          fontSize: "var(--text-body-size)",
          color: "var(--text-muted)",
          margin: 0,
          textAlign: "center",
          maxWidth: "400px",
          lineHeight: "var(--text-body-line)",
        }}
      >
        {msg}
      </p>
      <a
        href="/"
        className="btn-primary"
        style={{ textDecoration: "none", display: "inline-block" }}
      >
        처음으로 돌아가기
      </a>
      {/* §0 always visible even on error */}
      <p
        style={{
          marginTop: "16px",
          fontSize: "var(--text-caption-size)",
          color: "var(--warning)",
        }}
      >
        현 위치 진단입니다 — 노출을 보장하지 않습니다.
      </p>
    </main>
  );
}
