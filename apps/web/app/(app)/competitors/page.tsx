/**
 * apps/web/app/(app)/competitors/page.tsx
 *
 * Competitors page — Share of Voice (SoV) breakdown.
 *
 * Reads the latest report_snapshot's sov[] array
 * (immutable as-delivered report_json, not a live recompute).
 *
 * Single cyan brand ramp vs neutral slate-gray competitor ramp —
 * brand always reads as the protagonist.
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
import { BreakdownTable } from "../../../components/BreakdownTable";
import { DisclosureFooter } from "../../../components/DisclosureFooter";
import { SELF_JUDGE_BIAS_DISCLOSURE } from "@engine/domain/metrics.types";
import type { RunReport } from "@engine/domain/metrics.types";

export const dynamic = "force-dynamic";

export default async function CompetitorsPage() {
  let customerId: string;
  try {
    customerId = await requireCustomerScope();
  } catch {
    redirect("/login");
  }

  const snapshots = await listReportSnapshots(customerId);

  if (snapshots.length === 0) {
    return (
      <EmptyPage message="경쟁사 데이터가 없습니다. 첫 주간 리포트 생성 후 표시됩니다." />
    );
  }

  const latestMeta = snapshots[0]!;
  const latestFull = await getReportSnapshot(latestMeta.id);
  if (!latestFull || latestFull.customer_id !== customerId) {
    redirect("/login");
  }

  const reportJson = latestFull.report_json as RunReport;
  const wire = toWireReport(reportJson);
  const sov = wire.sov;

  const weekLabel =
    latestFull.week_start instanceof Date
      ? latestFull.week_start.toLocaleDateString("ko-KR", {
          month: "long",
          day: "numeric",
        })
      : String(latestFull.week_start);

  // W7.2 / §7 honesty — identify the brand by ENTITY IDENTITY, not by sorted
  // position. computeSoV always emits the brand entry first in the source
  // array; capture its name BEFORE re-sorting. Sorting by value desc puts the
  // highest-mentioned entity at index 0, which is a COMPETITOR whenever the
  // owner is losing — so position-0 must never be assumed to be the brand.
  const brandName = sov.length > 0 ? sov[0]!.entityName : null;
  const sorted = [...sov].sort((a, b) => b.value - a.value);
  const totalMentions =
    sorted.length > 0 ? sorted[0]!.totalMentions : 0;

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
          경쟁사 비교 (SoV)
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          기준 주: {weekLabel} &nbsp;·&nbsp; 전체 언급 {totalMentions}회 기준
        </p>
      </header>

      {/* Visual SoV bar comparison */}
      {sorted.length > 0 && (
        <section className="card" style={{ padding: "20px 24px" }}>
          <h2
            style={{
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              margin: "0 0 16px 0",
              color: "var(--text)",
            }}
          >
            Share of Voice 비교
          </h2>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            {sorted.map((entity) => {
              // W7.2 — brand is matched by identity (entityName), not by rank.
              const isBrand = entity.entityName === brandName;
              const barColor = isBrand ? "var(--accent)" : "#64748B";
              const pct = (entity.value * 100).toFixed(1);
              return (
                <div key={entity.entityName}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "4px",
                      fontSize: "var(--text-body-size)",
                    }}
                  >
                    <span
                      style={{
                        fontWeight: isBrand ? 700 : 400,
                        color: isBrand ? "var(--text)" : "var(--text-muted)",
                      }}
                    >
                      {entity.entityName}
                      {isBrand && (
                        <span
                          style={{
                            marginLeft: "6px",
                            fontSize: "10px",
                            color: "var(--accent)",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          브랜드
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 600,
                        color: isBrand ? "var(--accent)" : "var(--text-muted)",
                      }}
                    >
                      {pct}%
                    </span>
                  </div>
                  <div
                    style={{
                      height: "8px",
                      backgroundColor: "var(--border)",
                      borderRadius: "4px",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        backgroundColor: barColor,
                        borderRadius: "4px",
                        transition: "width 0.3s ease",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "var(--text-muted)",
                      marginTop: "3px",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {entity.entityMentions} / {entity.totalMentions} 전체 언급
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* SoV table */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 16px 0",
            color: "var(--text)",
          }}
        >
          SoV 상세 데이터
        </h2>
        <BreakdownTable kind="sov" sov={sov} />
      </section>

      <DisclosureFooter selfJudgeBiasDisclosure={wire.selfJudgeBiasDisclosure} />
    </div>
  );
}

function EmptyPage({ message }: { message: string }) {
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
        경쟁사 비교 (SoV)
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "var(--text-body-size)" }}>
        {message}
      </p>
      <DisclosureFooter selfJudgeBiasDisclosure={SELF_JUDGE_BIAS_DISCLOSURE} />
    </div>
  );
}
