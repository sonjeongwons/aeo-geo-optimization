/**
 * apps/web/app/(app)/reports/[snapshotId]/page.tsx
 *
 * Full weekly report page — renders the IMMUTABLE as-delivered RunReport
 * from report_snapshot.report_json.
 *
 * CRITICAL: This reads the SNAPSHOT (not a live recompute via assembleReport).
 * The report is labeled "as delivered" — numbers never drift on a later re-judge.
 *
 * Security:
 *  - Auth enforced by (app) layout.
 *  - Ownership check: snapshot.customer_id === session.customerId (404 on mismatch).
 *  - snapshotId comes from the URL param — NOT trusted as an ownership proof.
 *
 * §0 disclosure: DisclosureFooter always rendered.
 */

import { redirect, notFound } from "next/navigation";
import { requireCustomerScope } from "../../../../lib/session";
import { getReportSnapshot } from "../../../../lib/engine.server";
import { toWireReport } from "../../../../lib/wire";
import { StatCard } from "../../../../components/StatCard";
import { TrendChart } from "../../../../components/TrendChart";
import { CoverageMatrix } from "../../../../components/CoverageMatrix";
import { BreakdownTable } from "../../../../components/BreakdownTable";
import { GapList } from "../../../../components/GapList";
import { DisclosureFooter } from "../../../../components/DisclosureFooter";
import type { RunReport } from "@engine/domain/metrics.types";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ReportSnapshotPage({
  params,
}: {
  params: Promise<{ snapshotId: string }>;
}) {
  // Auth enforced by layout; get customerId here for the ownership check.
  let customerId: string;
  try {
    customerId = await requireCustomerScope();
  } catch {
    redirect("/login");
  }

  const { snapshotId } = await params;
  if (!snapshotId) {
    notFound();
  }

  // Fetch the snapshot.
  const snapshot = await getReportSnapshot(snapshotId);

  // Ownership check — fail-closed: 404 on mismatch or missing row.
  // Return 404 (not 403) to avoid existence leakage.
  if (!snapshot || snapshot.customer_id !== customerId) {
    notFound();
  }

  // Parse the immutable as-delivered RunReport from report_json.
  const reportJson = snapshot.report_json as RunReport;
  const wire = toWireReport(reportJson);

  // Metadata display values.
  const weekLabel =
    snapshot.week_start instanceof Date
      ? snapshot.week_start.toLocaleDateString("ko-KR", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : String(snapshot.week_start);

  const generatedAtLabel =
    snapshot.generated_at instanceof Date
      ? snapshot.generated_at.toLocaleString("ko-KR")
      : String(snapshot.generated_at);

  const smrVal = parseFloat(String(snapshot.smr));
  const visibilityVal = parseFloat(String(snapshot.visibility));
  const abstainRate = parseFloat(String(snapshot.abstain_rate));
  const wowDelta =
    snapshot.wow_smr_delta != null
      ? parseFloat(String(snapshot.wow_smr_delta))
      : null;

  const topSov =
    wire.sov.length > 0
      ? wire.sov.reduce((best, s) => (s.value > best.value ? s : best), wire.sov[0]!)
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
      {/* Page header */}
      <header>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            marginBottom: "4px",
          }}
        >
          <h1
            style={{
              fontSize: "var(--text-h1-size)",
              fontWeight: "var(--text-h1-weight)",
              lineHeight: "var(--text-h1-line)",
              margin: 0,
              color: "var(--text)",
            }}
          >
            주간 리포트 — {weekLabel}
          </h1>
          {/* "As delivered" badge */}
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              padding: "2px 8px",
              borderRadius: "4px",
              border: "1px solid var(--accent)",
              color: "var(--accent)",
              flexShrink: 0,
            }}
          >
            배달 시점 고정
          </span>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          생성: {generatedAtLabel} &nbsp;·&nbsp; 이후 재판정 후에도 이 수치는
          변경되지 않습니다.
        </p>
        <div
          style={{
            marginTop: "8px",
          }}
        >
          <a
            href="/reports"
            style={{
              fontSize: "var(--text-caption-size)",
              color: "var(--text-muted)",
              textDecoration: "none",
            }}
          >
            ← 리포트 목록
          </a>
        </div>
      </header>

      {/* KPI StatCards */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "16px",
        }}
      >
        <StatCard
          label="SMR (Share of Model Response)"
          value={smrVal === 0 ? "0.0%" : `${(smrVal * 100).toFixed(1)}%`}
          delta={wowDelta}
          subLabel={`${wire.smr.brandHits} / ${wire.smr.nTotal} 응답`}
        />
        <StatCard
          label="Visibility"
          value={`${(visibilityVal * 100).toFixed(2)}%`}
          subLabel="역순위 합 / N"
        />
        {topSov ? (
          <StatCard
            label={`상위 경쟁사 SoV (${topSov.entityName})`}
            value={`${(topSov.value * 100).toFixed(1)}%`}
            subLabel={`${topSov.entityMentions} / ${topSov.totalMentions} 언급`}
          />
        ) : (
          <StatCard
            label="경쟁사 SoV"
            value="—"
            subLabel="경쟁사 데이터 없음"
          />
        )}
        <StatCard
          label="Abstain Rate"
          value={`${(abstainRate * 100).toFixed(1)}%`}
          caveat={
            abstainRate > 0.15 ? "기권율 높음 — 판정 신뢰도 주의" : undefined
          }
          subLabel={`${wire.abstainCount} 기권`}
        />
      </section>

      {/* Model coverage matrix */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 16px 0",
            color: "var(--text)",
          }}
        >
          모델별 커버리지
        </h2>
        <CoverageMatrix byModel={wire.decomposition.byModel} />
      </section>

      {/* Language breakdown */}
      {wire.decomposition.byLanguage.length > 0 && (
        <section className="card" style={{ padding: "20px 24px" }}>
          <h2
            style={{
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              margin: "0 0 16px 0",
              color: "var(--text)",
            }}
          >
            언어별 SMR
          </h2>
          <BreakdownTable
            kind="byLanguage"
            byLanguage={wire.decomposition.byLanguage}
          />
        </section>
      )}

      {/* SoV breakdown */}
      {wire.sov.length > 0 && (
        <section className="card" style={{ padding: "20px 24px" }}>
          <h2
            style={{
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              margin: "0 0 16px 0",
              color: "var(--text)",
            }}
          >
            경쟁사 Share of Voice
          </h2>
          <BreakdownTable kind="sov" sov={wire.sov} />
        </section>
      )}

      {/* Priority Gap */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 16px 0",
            color: "var(--text)",
          }}
        >
          우선순위 콘텐츠 갭 (전체 {wire.priorityGap.questions.length}개)
        </h2>
        <GapList
          questions={wire.priorityGap.questions}
          limit={20}
          showEvidence
        />
      </section>

      {/* §0 / §7 disclosure */}
      <DisclosureFooter selfJudgeBiasDisclosure={wire.selfJudgeBiasDisclosure} />

      {/* Run metadata */}
      <div
        style={{
          borderTop: "1px solid var(--border)",
          paddingTop: "12px",
          fontSize: "11px",
          color: "var(--text-muted)",
          fontVariantNumeric: "tabular-nums",
          display: "flex",
          flexWrap: "wrap",
          gap: "16px",
        }}
      >
        <span>스냅샷 ID: {snapshot.id}</span>
        <span>런 ID: {snapshot.run_id}</span>
        <span>종류: {wire.kind}</span>
        <span>N={wire.smr.nTotal}</span>
      </div>
    </div>
  );
}
