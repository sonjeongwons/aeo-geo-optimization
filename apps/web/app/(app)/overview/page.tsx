/**
 * apps/web/app/(app)/page.tsx
 *
 * Overview — main dashboard page.
 *
 * Displays:
 *  - 4 KPI StatCards: SMR, Visibility, top SoV vs competitor, abstain-rate
 *  - SMR-over-time line chart (from report_snapshot history — O(snapshots))
 *  - This-week priority-gap preview (top 5 gaps)
 *  - Coverage matrix (models × mentioned)
 *
 * Architecture:
 *  - Server Component: fetches data server-side via tenant-scoped API routes.
 *  - All reads go through engine.server.ts facade (server-only).
 *  - Auth is enforced by the (app) layout (TenantGuard).
 *
 * Empty/zero states: explicit "SMR 0% — before-state" copy for the §14
 * before/after story.
 *
 * §0 disclosure: DisclosureFooter always rendered.
 */

import { redirect } from "next/navigation";
import { requireCustomerScope } from "../../../lib/session";
import {
  listReportSnapshots,
  getReportSnapshot,
} from "../../../lib/engine.server";
import { toWireReport } from "../../../lib/wire";
import { StatCard } from "../../../components/StatCard";
import { TrendChart } from "../../../components/TrendChart";
import { CoverageMatrix } from "../../../components/CoverageMatrix";
import { GapList } from "../../../components/GapList";
import { DisclosureFooter } from "../../../components/DisclosureFooter";
import { DeltaBadge } from "../../../components/DeltaBadge";
import type { RunReport } from "@engine/domain/metrics.types";
import type { TrendPoint } from "../../../components/TrendChart";
import { SELF_JUDGE_BIAS_DISCLOSURE } from "@engine/domain/metrics.types";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function OverviewPage() {
  // Auth enforced by layout; just get the customerId here.
  let customerId: string;
  try {
    customerId = await requireCustomerScope();
  } catch {
    redirect("/login");
  }

  // Load all snapshots for this customer (tenant-scoped by repo fn).
  const snapshots = await listReportSnapshots(customerId);

  // Pre-first-run state: no snapshots yet.
  if (snapshots.length === 0) {
    return (
      <div
        style={{
          padding: "var(--gutter)",
          maxWidth: "var(--content-max)",
          margin: "0 auto",
        }}
      >
        <ZeroState />
        <DisclosureFooter selfJudgeBiasDisclosure={SELF_JUDGE_BIAS_DISCLOSURE} />
      </div>
    );
  }

  // Latest snapshot for the KPI cards.
  const latestMeta = snapshots[0]!;
  const latestFull = await getReportSnapshot(latestMeta.id);

  // Fail-closed: ownership already enforced by listReportSnapshots,
  // but double-check the full snapshot.
  if (!latestFull || latestFull.customer_id !== customerId) {
    redirect("/login");
  }

  const reportJson = latestFull.report_json as RunReport;
  const wire = toWireReport(reportJson);

  // Trend data: snapshot history (oldest → newest).
  const trendSeries: TrendPoint[] = [...snapshots]
    .reverse()
    .map((s) => ({
      weekStart:
        s.week_start instanceof Date
          ? s.week_start.toISOString()
          : String(s.week_start),
      smr: parseFloat(String(s.smr)),
      visibility: parseFloat(String(s.visibility)),
    }));

  // KPI values
  const smrValue = parseFloat(String(latestFull.smr));
  const visibilityValue = parseFloat(String(latestFull.visibility));
  const abstainRate = parseFloat(String(latestFull.abstain_rate));
  const wowDelta =
    latestFull.wow_smr_delta != null
      ? parseFloat(String(latestFull.wow_smr_delta))
      : null;

  // Top competitor SoV
  const topSov =
    wire.sov.length > 0
      ? wire.sov.reduce(
          (best, s) => (s.value > best.value ? s : best),
          wire.sov[0]!,
        )
      : null;

  const weekStart =
    latestFull.week_start instanceof Date
      ? latestFull.week_start.toLocaleDateString("ko-KR", {
          month: "long",
          day: "numeric",
        })
      : String(latestFull.week_start);

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
        <h1
          style={{
            fontSize: "var(--text-h1-size)",
            fontWeight: "var(--text-h1-weight)",
            lineHeight: "var(--text-h1-line)",
            margin: "0 0 4px 0",
            color: "var(--text)",
          }}
        >
          개요
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          기준 주: {weekStart} &nbsp;·&nbsp; {snapshots.length}주 데이터
        </p>
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
          value={smrValue === 0 ? "0.0%" : `${(smrValue * 100).toFixed(1)}%`}
          delta={wowDelta}
          subLabel={`${wire.smr.brandHits} / ${wire.smr.nTotal} 응답`}
        />
        <StatCard
          label="Visibility"
          value={`${(visibilityValue * 100).toFixed(2)}%`}
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
            abstainRate > 0.15
              ? "기권율 높음 — 판정 신뢰도 주의"
              : undefined
          }
          subLabel={`${wire.abstainCount} 기권`}
        />
        {wire.citationShare && (
          <StatCard
            label="SMR (Citation / 인용)"
            value={`${(wire.citationShare.value * 100).toFixed(1)}%`}
            subLabel={`언급 중 ${(wire.citationShare.citationOfMentionRate * 100).toFixed(0)}%가 클릭 가능한 인용`}
            caveat={
              wire.citationShare.value < wire.smr.value
                ? "인용은 언급의 부분집합 — 트래픽 레버"
                : undefined
            }
          />
        )}
        {wire.recommendationShare && (
          <StatCard
            label="SMR (Recommendation / 추천)"
            value={`${(wire.recommendationShare.value * 100).toFixed(1)}%`}
            subLabel={`언급 중 ${(wire.recommendationShare.recommendationOfMentionRate * 100).toFixed(0)}%가 추천`}
            caveat="퍼널 최종 단계 (보수적 하한값)"
          />
        )}
        {wire.pawc && (
          <StatCard
            label="조기 위치 단어점유율 (PAWC)"
            value={`${(wire.pawc.value * 100).toFixed(1)}%`}
            subLabel="답변 초반 가중 브랜드 비중 (참고)"
          />
        )}
        {wire.samplingAdequacy && (
          <StatCard
            label="표본 적정성 (SE)"
            value={
              wire.samplingAdequacy.currentSe != null
                ? `±${(wire.samplingAdequacy.currentSe * 100).toFixed(1)}%`
                : "측정 불가"
            }
            subLabel={
              !wire.samplingAdequacy.estimable
                ? "프롬프트/반복 부족으로 분해 불가"
                : wire.samplingAdequacy.currentSe == null
                  ? "결과가 상수(0%/100%) — SE 식별 불가"
                  : wire.samplingAdequacy.samplingAdequate
                    ? `목표 ±${(wire.samplingAdequacy.targetSe * 100).toFixed(0)}% 충족`
                    : `프롬프트 ${wire.samplingAdequacy.recommendedPrompts ?? "?"}개 권장`
            }
            caveat={
              wire.samplingAdequacy.estimable &&
              wire.samplingAdequacy.currentSe != null &&
              !wire.samplingAdequacy.samplingAdequate
                ? "표본 부족 — 추정 노이즈 큼"
                : undefined
            }
          />
        )}
        {(() => {
          const eo = wire.engineOverlap;
          if (!eo) return null;
          const reliable = eo.pairs.filter((p) => !p.lowData);
          if (reliable.length === 0) return null; // no adequately-sampled pair
          const meanJ = reliable.reduce((s, p) => s + p.jaccard, 0) / reliable.length;
          const poolable = reliable.filter((p) => p.pooledSafe).length;
          return (
            <StatCard
              label="엔진간 인용도메인 중첩 (Jaccard)"
              value={meanJ.toFixed(2)}
              subLabel={`${eo.engines.length}개 엔진 · ${poolable}/${reliable.length} 페어 풀링 가능`}
              caveat={meanJ < eo.threshold ? "중첩 낮음 — 엔진별 타깃팅 권장" : undefined}
            />
          );
        })()}
      </section>

      {/* SMR Trend chart */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 16px 0",
            color: "var(--text)",
          }}
        >
          SMR 트렌드
        </h2>
        <TrendChart data={trendSeries} series={["smr", "visibility"]} height={200} />
      </section>

      {/* Coverage matrix (models × mentioned) */}
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

      {/* Priority Gap preview (top 5) */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "16px",
          }}
        >
          <h2
            style={{
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              margin: 0,
              color: "var(--text)",
            }}
          >
            우선순위 콘텐츠 갭 (상위 5개)
          </h2>
          <a
            href="/gaps"
            style={{
              fontSize: "var(--text-caption-size)",
              color: "var(--accent)",
              textDecoration: "none",
            }}
          >
            전체 보기 →
          </a>
        </div>
        <GapList
          questions={wire.priorityGap.questions}
          limit={5}
          showEvidence={false}
        />
      </section>

      {/* §0 disclosure footer */}
      <DisclosureFooter selfJudgeBiasDisclosure={wire.selfJudgeBiasDisclosure} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zero-state component (pre-first-run)
// ---------------------------------------------------------------------------

function ZeroState() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "40vh",
        gap: "16px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-metric-size)",
          fontWeight: "var(--text-metric-weight)",
          fontVariantNumeric: "tabular-nums",
          color: "var(--text-muted)",
        }}
      >
        SMR 0%
      </div>
      <p
        style={{
          fontSize: "var(--text-h2-size)",
          fontWeight: "var(--text-h2-weight)",
          color: "var(--text)",
          margin: 0,
        }}
      >
        아직 어떤 모델도 브랜드를 언급하지 않음
      </p>
      <p
        style={{
          fontSize: "var(--text-body-size)",
          color: "var(--text-muted)",
          maxWidth: "480px",
          margin: 0,
          lineHeight: "var(--text-body-line)",
        }}
      >
        이것이 <strong style={{ color: "var(--accent)" }}>before</strong> 입니다.
        첫 주간 리포트가 생성되면 여기에 SMR 추이가 표시됩니다.
        기준 진단을 먼저 실행해 주세요.
      </p>
      <p
        style={{
          fontSize: "var(--text-caption-size)",
          color: "var(--warning)",
          margin: 0,
        }}
      >
        현 위치 진단입니다 — 노출을 보장하지 않습니다. (§0)
      </p>
    </div>
  );
}
