/**
 * apps/web/app/(app)/reports/page.tsx
 *
 * Weekly reports list page.
 *
 * Lists delivered report_snapshots (week_start, SMR, WoW delta)
 * for the session customer, ordered newest first.
 *
 * Each row links to /reports/[snapshotId] for the full immutable snapshot.
 *
 * Auth enforced by (app) layout.
 */

import { redirect } from "next/navigation";
import { requireCustomerScope } from "../../../lib/session";
import { listReportSnapshots } from "../../../lib/engine.server";
import { DeltaBadge } from "../../../components/DeltaBadge";

export const dynamic = "force-dynamic";

export default async function ReportsListPage() {
  let customerId: string;
  try {
    customerId = await requireCustomerScope();
  } catch {
    redirect("/login");
  }

  const snapshots = await listReportSnapshots(customerId);

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
          주간 리포트
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          배달 시점의 불변 스냅샷 — 재판정 후에도 수치가 변하지 않습니다.
          {snapshots.length > 0 &&
            ` &nbsp;·&nbsp; ${snapshots.length}개 리포트`}
        </p>
      </header>

      {snapshots.length === 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "30vh",
            gap: "12px",
            textAlign: "center",
            color: "var(--text-muted)",
          }}
        >
          <p style={{ fontSize: "var(--text-h2-size)", margin: 0 }}>
            아직 리포트가 없습니다
          </p>
          <p
            style={{
              fontSize: "var(--text-body-size)",
              margin: 0,
              maxWidth: "400px",
            }}
          >
            첫 번째 운영 주간 리포트가 생성되면 여기에 표시됩니다.
            현재 기준 진단 리포트를 먼저 실행하세요.
          </p>
        </div>
      ) : (
        <section className="card" style={{ padding: 0, overflow: "hidden" }}>
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
                  {[
                    { label: "기준 주", align: "left" },
                    { label: "SMR", align: "right" },
                    { label: "WoW", align: "right" },
                    { label: "Visibility", align: "right" },
                    { label: "기권율", align: "right" },
                    { label: "생성일", align: "right" },
                    { label: "보기", align: "right" },
                  ].map((col) => (
                    <th
                      key={col.label}
                      style={{
                        padding: "10px 16px",
                        textAlign: col.align as "left" | "right",
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
                      {col.label}
                    </th>
                  ))}
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
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })
                      : String(s.week_start);

                  const genLabel =
                    s.generated_at instanceof Date
                      ? s.generated_at.toLocaleDateString("ko-KR", {
                          month: "short",
                          day: "numeric",
                        })
                      : String(s.generated_at);

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
                      <td
                        style={{
                          padding: "0 16px",
                          color: "var(--text)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {wkLabel}
                        {idx === 0 && (
                          <span
                            style={{
                              marginLeft: "8px",
                              fontSize: "10px",
                              color: "var(--accent)",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                            }}
                          >
                            최신
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "0 16px",
                          textAlign: "right",
                          color: smrVal > 0 ? "var(--accent)" : "var(--text-muted)",
                          fontWeight: 600,
                        }}
                      >
                        {(smrVal * 100).toFixed(1)}%
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
                        {(visVal * 100).toFixed(2)}%
                      </td>
                      <td
                        style={{
                          padding: "0 16px",
                          textAlign: "right",
                          color:
                            absRate > 0.15 ? "var(--warning)" : "var(--text-muted)",
                        }}
                      >
                        {(absRate * 100).toFixed(1)}%
                      </td>
                      <td
                        style={{
                          padding: "0 16px",
                          textAlign: "right",
                          color: "var(--text-muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {genLabel}
                      </td>
                      <td style={{ padding: "0 16px", textAlign: "right" }}>
                        <a
                          href={`/reports/${s.id}`}
                          style={{
                            fontSize: "var(--text-caption-size)",
                            color: "var(--accent)",
                            textDecoration: "none",
                            fontWeight: 600,
                          }}
                        >
                          상세 보기 →
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

      {/* Immutability note */}
      <p
        style={{
          fontSize: "11px",
          color: "var(--text-muted)",
          margin: 0,
        }}
      >
        각 리포트는 배달 시점의 불변 스냅샷입니다.
        이후 재판정이 발생해도 리포트의 수치는 변경되지 않습니다.
        현 위치 진단 — 노출을 보장하지 않습니다. (§0)
      </p>
    </div>
  );
}
