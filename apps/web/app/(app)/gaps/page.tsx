/**
 * apps/web/app/(app)/gaps/page.tsx
 *
 * Priority Gaps page — questions where brand SMR is low and competitor
 * presence is high. Sorted by gapScore desc (highest-leverage first).
 *
 * Reads the latest report_snapshot's priorityGap.questions
 * (immutable as-delivered report_json, not a live recompute).
 *
 * Expandable rows show evidence refs, EvidenceDrawer for raw answer_text.
 *
 * Auth enforced by (app) layout.
 * §0 disclosure always visible.
 */

import { redirect } from "next/navigation";
import { requireCustomerScope } from "../../../lib/session";
import {
  listReportSnapshots,
  getReportSnapshot,
} from "../../../lib/engine.server";
import { toWireReport } from "../../../lib/wire";
import { GapListWithEvidence } from "../../../components/GapListWithEvidence";
import { DisclosureFooter } from "../../../components/DisclosureFooter";
import { SELF_JUDGE_BIAS_DISCLOSURE } from "@engine/domain/metrics.types";
import type { RunReport } from "@engine/domain/metrics.types";

export const dynamic = "force-dynamic";

export default async function GapsPage() {
  let customerId: string;
  try {
    customerId = await requireCustomerScope();
  } catch {
    redirect("/login");
  }

  const snapshots = await listReportSnapshots(customerId);

  if (snapshots.length === 0) {
    return (
      <div
        style={{
          padding: "var(--gutter)",
          maxWidth: "var(--content-max)",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--section-gap)",
        }}
      >
        <h1
          style={{
            fontSize: "var(--text-h1-size)",
            fontWeight: "var(--text-h1-weight)",
            color: "var(--text)",
            margin: 0,
          }}
        >
          우선순위 콘텐츠 갭
        </h1>
        <p
          style={{
            color: "var(--text-muted)",
            fontSize: "var(--text-body-size)",
          }}
        >
          갭 데이터가 없습니다. 첫 주간 리포트 생성 후 표시됩니다.
        </p>
        <DisclosureFooter selfJudgeBiasDisclosure={SELF_JUDGE_BIAS_DISCLOSURE} />
      </div>
    );
  }

  const latestMeta = snapshots[0]!;
  const latestFull = await getReportSnapshot(latestMeta.id);
  if (!latestFull || latestFull.customer_id !== customerId) {
    redirect("/login");
  }

  const reportJson = latestFull.report_json as RunReport;
  const wire = toWireReport(reportJson);
  const questions = wire.priorityGap.questions;

  const weekLabel =
    latestFull.week_start instanceof Date
      ? latestFull.week_start.toLocaleDateString("ko-KR", {
          month: "long",
          day: "numeric",
        })
      : String(latestFull.week_start);

  // Summary stats
  const topGapScore =
    questions.length > 0
      ? Math.max(...questions.map((q) => q.gapScore))
      : null;
  const avgBrandSMR =
    questions.length > 0
      ? questions.reduce((sum, q) => sum + q.brandSMR, 0) / questions.length
      : null;

  return (
    <div
      style={{
        padding: "var(--gutter)",
        maxWidth: "var(--content-max)",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "var(--section-gap)",
      }}
    >
      {/* Header */}
      <header>
        <h1
          style={{
            fontSize: "var(--text-h1-size)",
            fontWeight: "var(--text-h1-weight)",
            lineHeight: "var(--text-h1-line)",
            margin: "0 0 4px 0",
            color: "var(--text)",
          }}
        >
          우선순위 콘텐츠 갭
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          기준 주: {weekLabel} &nbsp;·&nbsp; {questions.length}개 질문
          &nbsp;·&nbsp; 갭 점수 높은 순 (브랜드 SMR 낮음 + 경쟁사 존재 높음)
        </p>
      </header>

      {/* Summary cards */}
      {questions.length > 0 && (
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          <SummaryCard
            label="총 질문 수"
            value={`${questions.length}`}
          />
          {topGapScore !== null && (
            <SummaryCard
              label="최고 갭 점수"
              value={topGapScore.toFixed(2)}
              highlight
            />
          )}
          {avgBrandSMR !== null && (
            <SummaryCard
              label="평균 브랜드 SMR"
              value={`${(avgBrandSMR * 100).toFixed(1)}%`}
            />
          )}
        </div>
      )}

      {/* Gap list — full with evidence expansion */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 16px 0",
            color: "var(--text)",
          }}
        >
          갭 질문 목록
        </h2>
        <p
          style={{
            margin: "0 0 16px 0",
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          행을 클릭하면 증거 응답 ID를 펼쳐 볼 수 있습니다.
          증거 버튼을 클릭하면 원문 응답이 표시됩니다.
        </p>
        {/* W7.1 — client wrapper wires the 증거 button to EvidenceDrawer. */}
        <GapListWithEvidence questions={questions} limit={50} />
      </section>

      {/* Evidence note */}
      <div
        style={{
          padding: "12px 16px",
          backgroundColor: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)",
          fontSize: "var(--text-caption-size)",
          color: "var(--text-muted)",
        }}
      >
        §7#7 — 모든 갭 지표는 response_raw 원문 응답으로 추적 가능합니다.
        증거 버튼 클릭 시 해당 응답 원문이 표시됩니다 (테넌트 소유 확인 후).
      </div>

      <DisclosureFooter selfJudgeBiasDisclosure={wire.selfJudgeBiasDisclosure} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local summary card
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        padding: "16px 20px",
        border: `1px solid ${highlight ? "var(--warning)" : "var(--border)"}`,
        borderRadius: "var(--radius-card)",
        backgroundColor: "var(--bg-elev)",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        minWidth: "140px",
      }}
    >
      <span
        style={{
          fontSize: "var(--text-caption-size)",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: "28px",
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          color: highlight ? "var(--warning)" : "var(--accent)",
          lineHeight: 1.2,
        }}
      >
        {value}
      </span>
    </div>
  );
}
