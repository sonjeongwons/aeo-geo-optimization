/**
 * /r/[token] — Signed weekly-report permalink (P5-T16).
 *
 * Public page (no session required). Renders the immutable as-delivered
 * report_snapshot for the emailed link without requiring login.
 *
 * Security invariants:
 *  - Token is verified server-side via HMAC-SHA256 over snapshotId:customerId.
 *  - Non-enumerable: knowing a snapshotId alone does not yield a valid token.
 *  - Bound to exactly one snapshot + customer.
 *  - Tampered/unknown token → notFound() (404). Never 403 (no existence leak).
 *  - No other tenant data is reachable via this route.
 *  - The snapshot is read from report_snapshot.report_json (IMMUTABLE as-delivered).
 *
 * Layout mirrors the weekly-report view from the authed dashboard, labeled
 * "as delivered" so the emailed numbers are permanently visible at this URL.
 * Includes §0 no-guarantee + self-judge-bias disclosures (always visible).
 */

import { notFound } from "next/navigation";
import { getReportSnapshot, recordSecurityAudit } from "@engine/db/repo";
import { redactToken } from "@engine/security/securityAudit";
import { toWireReport } from "../../../lib/wire";
import { verifyReportToken } from "../../../lib/actions/reportToken";
import { StatCard } from "../../../components/StatCard";
import { CoverageMatrix } from "../../../components/CoverageMatrix";
import { GapList } from "../../../components/GapList";
import { DisclosureFooter } from "../../../components/DisclosureFooter";
import type { RunReport } from "@engine/domain/metrics.types";

// Server Component — Node runtime (never Edge; reads pg via engine facade).
export const runtime = "nodejs";

// Snapshots are immutable as-delivered; no revalidation needed.
// Long cache is safe — the content never changes after delivery.
export const revalidate = 86400; // 24 hours

interface ReportPermalinkPageProps {
  params: Promise<{ token: string }>;
}

export default async function ReportPermalinkPage({
  params,
}: ReportPermalinkPageProps) {
  const { token } = await params;

  // -------------------------------------------------------------------------
  // 1. Verify the signed token (fail-closed: any issue → 404).
  //    verifyReportToken fetches the snapshot internally to obtain customerId
  //    for mac verification. Returns null on any failure.
  // -------------------------------------------------------------------------
  // Audit hook (MUST #6): record genuine forgery probes and successful accesses
  // to the append-only, hash-chained security_audit log. Malformed/garbage tokens
  // are intentionally NOT audited (avoids write amplification from bots/scanners).
  // Fire-and-forget: a failed audit write must never break the public route.
  const auditEvents: Array<{ reason: string; snapshotId: string | null }> = [];

  const verified = await verifyReportToken(
    token,
    // Inject the repo function — allows testing without Next.js context.
    (id) =>
      getReportSnapshot(id).then((row) =>
        row ? { id: row.id, customer_id: row.customer_id } : null,
      ),
    { onEvent: (reason, snapshotId) => auditEvents.push({ reason, snapshotId }) },
  );

  for (const ev of auditEvents) {
    if (ev.reason === "mac_mismatch") {
      void recordSecurityAudit({
        eventType: "report_token_forgery",
        outcome: "denied",
        subjectId: null,
        detail: { snapshotId: ev.snapshotId, route: "/r/[token]" },
        requestHash: redactToken(token),
      }).catch(() => {});
    } else if (ev.reason === "ok") {
      void recordSecurityAudit({
        eventType: "report_token_verify",
        outcome: "success",
        subjectId: null,
        detail: { snapshotId: ev.snapshotId, route: "/r/[token]" },
        requestHash: redactToken(token),
      }).catch(() => {});
    }
  }

  if (!verified) {
    notFound();
  }

  // -------------------------------------------------------------------------
  // 2. Load the full snapshot (report_json + metadata).
  //    We already fetched it inside verifyReportToken but we need the full row.
  //    A second fetch is acceptable: snapshots are immutable and small.
  // -------------------------------------------------------------------------
  const snapshot = await getReportSnapshot(verified.snapshotId);
  if (!snapshot) {
    // Should not happen (token verification already loaded it), but fail-closed.
    notFound();
  }

  // -------------------------------------------------------------------------
  // 3. Convert the immutable report_json to a WireRunReport (Dates → strings).
  // -------------------------------------------------------------------------
  const reportJson = snapshot.report_json as RunReport;
  const wireReport = toWireReport(reportJson);

  const { smr, visibility, abstainRate, sov, decomposition, priorityGap, selfJudgeBiasDisclosure } =
    wireReport;
  // Hi-end measurement additions (optional — present on newer reports).
  const citationShare = wireReport.citationShare;
  const recommendationShare = wireReport.recommendationShare;
  const pawc = wireReport.pawc;
  const samplingAdequacy = wireReport.samplingAdequacy;
  const engineOverlap = wireReport.engineOverlap;

  const weekStart =
    snapshot.week_start instanceof Date
      ? snapshot.week_start.toISOString().slice(0, 10)
      : String(snapshot.week_start).slice(0, 10);

  const generatedAt = wireReport.generatedAt;

  const wowDelta =
    snapshot.wow_smr_delta != null ? Number(snapshot.wow_smr_delta) : null;

  // -------------------------------------------------------------------------
  // 4. Render the as-delivered report snapshot.
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
          maxWidth: "880px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "32px",
          paddingTop: "48px",
          paddingBottom: "64px",
        }}
      >
        {/* ------------------------------------------------------------------ */}
        {/* Page header                                                          */}
        {/* ------------------------------------------------------------------ */}
        <header>
          {/* "As delivered" badge — immutable snapshot label */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              marginBottom: "12px",
              padding: "3px 10px",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              fontSize: "11px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--text-muted)",
              backgroundColor: "var(--bg-elev)",
            }}
          >
            주간 리포트 — as delivered
          </div>

          <h1
            style={{
              margin: "0 0 8px 0",
              fontSize: "var(--text-h1-size)",
              lineHeight: "var(--text-h1-line)",
              fontWeight: "var(--text-h1-weight)",
              color: "var(--text)",
            }}
          >
            AI 브랜드 노출도 주간 리포트
          </h1>

          <p
            style={{
              margin: 0,
              fontSize: "var(--text-caption-size)",
              color: "var(--text-muted)",
              lineHeight: "var(--text-caption-line)",
            }}
          >
            측정 기간 시작: {weekStart} &nbsp;·&nbsp; 생성 시각: {generatedAt}{" "}
            &nbsp;·&nbsp; N={smr.nTotal} 응답
          </p>
          <p
            style={{
              margin: "6px 0 0 0",
              fontSize: "var(--text-caption-size)",
              color: "var(--text-muted)",
            }}
          >
            이 링크는 발송 시점의 리포트를 그대로 보여줍니다 (이후 재측정으로 숫자가 바뀌지 않음).
          </p>
        </header>

        {/* ------------------------------------------------------------------ */}
        {/* 1. KPI StatCards                                                    */}
        {/* ------------------------------------------------------------------ */}
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
              label="SMR (Share of Model Response)"
              value={`${(smr.value * 100).toFixed(1)}%`}
              delta={wowDelta}
              subLabel={`${smr.brandHits} / ${smr.nTotal} 응답에서 언급`}
            />
            <StatCard
              label="Visibility"
              value={`${(visibility.value * 100).toFixed(1)}%`}
              subLabel={`브랜드 노출 가중 점수`}
            />
            {sov.length > 0 && sov[0] && (
              <StatCard
                label={`경쟁사 SoV — ${sov[0].entityName}`}
                value={`${(sov[0].value * 100).toFixed(1)}%`}
                subLabel="선두 경쟁사 점유율"
              />
            )}
            <StatCard
              label="기권율 (Abstain Rate)"
              value={`${(abstainRate * 100).toFixed(1)}%`}
              caveat={
                abstainRate > 0.1
                  ? "기권율이 높을수록 AI가 답변을 피하는 경향"
                  : undefined
              }
              subLabel="AI 모델이 답변을 거부한 비율"
            />
            {citationShare && (
              <StatCard
                label="SMR (Citation / 인용)"
                value={`${(citationShare.value * 100).toFixed(1)}%`}
                subLabel={`언급 중 ${(citationShare.citationOfMentionRate * 100).toFixed(0)}%가 클릭 가능한 인용(출처 링크)`}
                caveat={
                  citationShare.value < smr.value
                    ? "인용은 언급의 부분집합 — 트래픽으로 이어지는 핵심 레버"
                    : undefined
                }
              />
            )}
            {recommendationShare && (
              <StatCard
                label="SMR (Recommendation / 추천)"
                value={`${(recommendationShare.value * 100).toFixed(1)}%`}
                subLabel={`언급 중 ${(recommendationShare.recommendationOfMentionRate * 100).toFixed(0)}%가 실제 추천(best/top/권장)`}
                caveat="퍼널의 최종 단계: 언급 → 인용 → 추천 (보수적 하한값)"
              />
            )}
            {pawc && (
              <StatCard
                label="조기 위치 단어점유율 (PAWC)"
                value={`${(pawc.value * 100).toFixed(1)}%`}
                subLabel="답변 초반 가중 브랜드 단어 비중 (참고 지표, 인과 아님)"
              />
            )}
            {samplingAdequacy && (
              <StatCard
                label="표본 적정성 (표준오차)"
                value={
                  samplingAdequacy.currentSe != null
                    ? `±${(samplingAdequacy.currentSe * 100).toFixed(1)}%`
                    : "측정 불가"
                }
                subLabel={
                  !samplingAdequacy.estimable
                    ? "프롬프트/반복 부족으로 분산분해 불가"
                    : samplingAdequacy.currentSe == null
                      ? "결과가 상수(0%/100%) — 표준오차 식별 불가"
                      : samplingAdequacy.samplingAdequate
                        ? `목표 ±${(samplingAdequacy.targetSe * 100).toFixed(0)}% 충족 (분산분해 기반)`
                        : `목표 도달에 프롬프트 ${samplingAdequacy.recommendedPrompts ?? "?"}개 권장`
                }
                caveat={
                  samplingAdequacy.estimable &&
                  samplingAdequacy.currentSe != null &&
                  !samplingAdequacy.samplingAdequate
                    ? "표본 부족 — 추정치 노이즈 큼 (참고)"
                    : undefined
                }
              />
            )}
            {(() => {
              if (!engineOverlap) return null;
              const reliable = engineOverlap.pairs.filter((p) => !p.lowData);
              if (reliable.length === 0) return null; // no adequately-sampled pair
              const meanJ = reliable.reduce((s, p) => s + p.jaccard, 0) / reliable.length;
              const poolable = reliable.filter((p) => p.pooledSafe).length;
              return (
                <StatCard
                  label="엔진간 인용도메인 중첩 (Jaccard)"
                  value={meanJ.toFixed(2)}
                  subLabel={`${engineOverlap.engines.length}개 엔진 · ${poolable}/${reliable.length} 페어 풀링 가능`}
                  caveat={meanJ < engineOverlap.threshold ? "중첩 낮음 — 엔진별 타깃팅 권장" : undefined}
                />
              );
            })()}
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
              SMR 0% — 이 기간에는 어떤 AI 모델도 브랜드를 언급하지 않았습니다.
              이것이{" "}
              <strong style={{ color: "var(--accent)" }}>before</strong>입니다.
            </div>
          )}
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* 2. Model coverage matrix                                             */}
        {/* ------------------------------------------------------------------ */}
        <section>
          <h2
            style={{
              margin: "0 0 12px 0",
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
            {decomposition.byModel.length}개 AI 모델 × 브랜드 언급 현황
          </p>
          <CoverageMatrix byModel={decomposition.byModel} />
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* 3. Priority gap questions                                            */}
        {/* ------------------------------------------------------------------ */}
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
            우선순위 콘텐츠 갭
          </h2>
          <p
            style={{
              margin: "0 0 16px 0",
              fontSize: "var(--text-caption-size)",
              color: "var(--text-muted)",
            }}
          >
            브랜드 SMR이 낮고 경쟁사 존재가 높은 질문 — 최우선 공략 대상.
          </p>
          <GapList
            questions={priorityGap.questions}
            limit={20}
            showEvidence={false}
          />
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* 4. Disclosures (§0 + self-judge-bias — ALWAYS SHOWN)               */}
        {/* ------------------------------------------------------------------ */}
        <DisclosureFooter selfJudgeBiasDisclosure={selfJudgeBiasDisclosure} />

        {/* ------------------------------------------------------------------ */}
        {/* 5. Dashboard CTA (login to see live data)                           */}
        {/* ------------------------------------------------------------------ */}
        <div
          style={{
            padding: "20px 24px",
            backgroundColor: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-card)",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-body-size)",
              color: "var(--text)",
              fontWeight: 600,
            }}
          >
            최신 데이터 확인
          </p>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-caption-size)",
              color: "var(--text-muted)",
              lineHeight: "var(--text-caption-line)",
            }}
          >
            이 리포트는 발송 시점의 스냅샷입니다. 최신 트렌드 및 실시간 대시보드는
            로그인 후 확인하세요.
          </p>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <a
              href="/login"
              style={{
                display: "inline-block",
                padding: "8px 18px",
                backgroundColor: "var(--accent)",
                color: "#0B1020",
                borderRadius: "6px",
                fontSize: "var(--text-body-size)",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              대시보드 로그인
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
