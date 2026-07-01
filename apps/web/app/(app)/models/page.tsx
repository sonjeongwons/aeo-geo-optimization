/**
 * apps/web/app/(app)/models/page.tsx
 *
 * Models breakdown page — SMR decomposition by LLM model.
 *
 * Reads the latest report_snapshot's decomposition.byModel
 * (immutable as-delivered report_json, not a live recompute).
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
import { SmrBarList } from "../../../components/SmrBarList";
import { BreakdownTable } from "../../../components/BreakdownTable";
import { DisclosureFooter } from "../../../components/DisclosureFooter";
import { SELF_JUDGE_BIAS_DISCLOSURE } from "@engine/domain/metrics.types";
import type { RunReport } from "@engine/domain/metrics.types";

export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  let customerId: string;
  try {
    customerId = await requireCustomerScope();
  } catch {
    redirect("/login");
  }

  const snapshots = await listReportSnapshots(customerId);

  if (snapshots.length === 0) {
    return (
      <EmptyPage message="모델별 데이터가 없습니다. 첫 주간 리포트 생성 후 표시됩니다." />
    );
  }

  const latestMeta = snapshots[0]!;
  const latestFull = await getReportSnapshot(latestMeta.id);
  if (!latestFull || latestFull.customer_id !== customerId) {
    redirect("/login");
  }

  const reportJson = latestFull.report_json as RunReport;
  const wire = toWireReport(reportJson);
  const byModel = wire.decomposition.byModel;

  const weekLabel =
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
          모델별 SMR
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          기준 주: {weekLabel} &nbsp;·&nbsp; 최신 주간 리포트 (배달 시점 고정)
        </p>
      </header>

      {/* Bar chart (visual) */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 16px 0",
            color: "var(--text)",
          }}
        >
          모델별 브랜드 언급률
        </h2>
        {byModel.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "var(--text-body-size)" }}>
            모델 데이터 없음
          </p>
        ) : (
          <SmrBarList data={byModel} kind="model" />
        )}
      </section>

      {/* Detailed table */}
      <section className="card" style={{ padding: "20px 24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 16px 0",
            color: "var(--text)",
          }}
        >
          모델 상세 데이터
        </h2>
        <BreakdownTable kind="byModel" byModel={byModel} />
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
        모델별 SMR
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "var(--text-body-size)" }}>
        {message}
      </p>
      <DisclosureFooter selfJudgeBiasDisclosure={SELF_JUDGE_BIAS_DISCLOSURE} />
    </div>
  );
}
