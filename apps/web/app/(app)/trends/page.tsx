/**
 * apps/web/app/(app)/trends/page.tsx
 *
 * Trends page — multi-line SMR/Visibility over time.
 *
 * Reads from report_snapshot history (O(snapshots), no live re-aggregation).
 * Allows toggling between SMR and Visibility series.
 *
 * Auth enforced by (app) layout.
 * §0 disclosure always visible.
 */

import { redirect } from "next/navigation";
import { requireCustomerScope } from "../../../lib/session";
import { listReportSnapshots } from "../../../lib/engine.server";
import { TrendChart } from "../../../components/TrendChart";
import { DeltaBadge } from "../../../components/DeltaBadge";
import { DisclosureFooter } from "../../../components/DisclosureFooter";
import { formatPct } from "../../../lib/format";
import { SELF_JUDGE_BIAS_DISCLOSURE } from "@engine/domain/metrics.types";
import type { TrendPoint } from "../../../components/TrendChart";

export const dynamic = "force-dynamic";

export default async function TrendsPage() {
  let customerId: string;
  try {
    customerId = await requireCustomerScope();
  } catch {
    redirect("/login");
  }

  const snapshots = await listReportSnapshots(customerId);

  // Build trend series oldest → newest for chart rendering.
  const series: TrendPoint[] = [...snapshots]
    .reverse()
    .map((s) => ({
      weekStart:
        s.week_start instanceof Date
          ? s.week_start.toISOString()
          : String(s.week_start),
      smr: parseFloat(String(s.smr)),
      visibility: parseFloat(String(s.visibility)),
    }));

  // Summary stats
  const latestSmr =
    snapshots.length > 0 ? parseFloat(String(snapshots[0]!.smr)) : null;
  const latestWow =
    snapshots.length > 0 && snapshots[0]!.wow_smr_delta != null
      ? parseFloat(String(snapshots[0]!.wow_smr_delta))
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
          트렌드
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          주간 SMR / Visibility 시계열 — {snapshots.length}주 데이터 (재판정 영향 없음, 배달 시점 고정)
        </p>
      </header>

      {/* Summary row */}
      {latestSmr !== null && (
        <div
          style={{
            display: "flex",
            gap: "16px",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div className="card" style={{ padding: "16px 20px", minWidth: "160px" }}>
            <div
              style={{
                fontSize: "11px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--text-muted)",
                marginBottom: "4px",
              }}
            >
              최신 SMR
            </div>
            <div
              style={{
                fontSize: "28px",
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                color: "var(--accent)",
                display: "flex",
                alignItems: "baseline",
                gap: "8px",
              }}
            >
              {formatPct(latestSmr)}
              {latestWow !== null && (
                <DeltaBadge delta={latestWow} asPercent />
              )}
            </div>
          </div>
          <div className="card" style={{ padding: "16px 20px", minWidth: "160px" }}>
            <div
              style={{
                fontSize: "11px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--text-muted)",
                marginBottom: "4px",
              }}
            >
              측정 주 수
            </div>
            <div
              style={{
                fontSize: "28px",
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                color: "var(--text)",
              }}
            >
              {snapshots.length}
            </div>
          </div>
        </div>
      )}

      {/* SMR trend chart */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 16px 0",
            color: "var(--text)",
          }}
        >
          SMR 추이
        </h2>
        <TrendChart data={series} series={["smr"]} height={240} />
      </section>

      {/* Visibility trend chart */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 16px 0",
            color: "var(--text)",
          }}
        >
          Visibility 추이
        </h2>
        <TrendChart data={series} series={["visibility"]} height={240} />
      </section>

      {/* Combined chart */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 16px 0",
            color: "var(--text)",
          }}
        >
          SMR + Visibility 비교
        </h2>
        <TrendChart
          data={series}
          series={["smr", "visibility"]}
          height={240}
        />
        <p
          style={{
            margin: "12px 0 0 0",
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          시안(cyan) = SMR (브랜드 언급률) · 회색 = Visibility (역순위 합 기반)
        </p>
      </section>

      {/* Raw data table */}
      {snapshots.length > 0 && (
        <section className="card" style={{ padding: "20px 24px" }}>
          <h2
            style={{
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              margin: "0 0 16px 0",
              color: "var(--text)",
            }}
          >
            주간 데이터
          </h2>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "var(--text-body-size)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["기준 주", "SMR", "WoW", "Visibility", "기권율", "리포트"].map(
                    (h) => (
                      <th
                        key={h}
                        style={{
                          padding: "10px 16px",
                          textAlign: h === "기준 주" || h === "리포트" ? "left" : "right",
                          color: "var(--text-muted)",
                          fontWeight: 600,
                          fontSize: "var(--text-caption-size)",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          backgroundColor: "var(--bg-elev)",
                          position: "sticky",
                          top: 0,
                          zIndex: 1,
                        }}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s, idx) => {
                  const smrVal = parseFloat(String(s.smr));
                  const visVal = parseFloat(String(s.visibility));
                  const absRate = parseFloat(String(s.abstain_rate));
                  const wow =
                    s.wow_smr_delta != null
                      ? parseFloat(String(s.wow_smr_delta))
                      : null;
                  const wkLabel =
                    s.week_start instanceof Date
                      ? s.week_start.toLocaleDateString("ko-KR", {
                          month: "short",
                          day: "numeric",
                        })
                      : String(s.week_start);

                  return (
                    <tr
                      key={s.id}
                      style={{
                        backgroundColor:
                          idx % 2 === 0 ? "var(--bg-elev)" : "var(--bg-subtle)",
                        borderBottom: "1px solid var(--border)",
                        height: "var(--table-row-h)",
                      }}
                    >
                      <td style={{ padding: "0 16px", color: "var(--text-muted)" }}>
                        {wkLabel}
                      </td>
                      <td
                        style={{
                          padding: "0 16px",
                          textAlign: "right",
                          color: smrVal > 0 ? "var(--accent)" : "var(--text-muted)",
                          fontWeight: 600,
                        }}
                      >
                        {formatPct(smrVal)}
                      </td>
                      <td style={{ padding: "0 16px", textAlign: "right" }}>
                        <DeltaBadge delta={wow} asPercent />
                      </td>
                      <td
                        style={{
                          padding: "0 16px",
                          textAlign: "right",
                          color: "var(--text-muted)",
                        }}
                      >
                        {formatPct(visVal, 2)}
                      </td>
                      <td
                        style={{
                          padding: "0 16px",
                          textAlign: "right",
                          color:
                            absRate > 0.15 ? "var(--warning)" : "var(--text-muted)",
                        }}
                      >
                        {formatPct(absRate)}
                      </td>
                      <td style={{ padding: "0 16px" }}>
                        <a
                          href={`/reports/${s.id}`}
                          style={{
                            fontSize: "var(--text-caption-size)",
                            color: "var(--accent)",
                            textDecoration: "none",
                          }}
                        >
                          보기 →
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <DisclosureFooter selfJudgeBiasDisclosure={SELF_JUDGE_BIAS_DISCLOSURE} />
    </div>
  );
}
