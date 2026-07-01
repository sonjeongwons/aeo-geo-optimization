/**
 * apps/web/app/(app)/approvals/deploy/page.tsx
 *
 * Deploy approval page — per-customer, authenticated.
 *
 * Lists content_deploy_queue rows for the session customer's assets,
 * joined with content_asset for display context (format, language, channel).
 *
 * Approve action:
 *  → calls approveDeployRowForCustomer(assetId, customerId, sessionEmail)
 *  → records approver email for §12 audit trail
 *
 * SECURITY:
 *  - requireCustomerScope() enforces auth + tenant scoping.
 *  - customerId NEVER comes from URL params — always from the session.
 *  - Approving another tenant's asset returns a not-found error (fail-closed).
 *
 * §12 AUDIT: approver email (session.email) is stamped on content_deploy_queue.approved_by.
 */

import { redirect } from "next/navigation";
import { requireCustomerScopeWithSession } from "../../../../lib/session";
import { ApprovalTable, StatusBadge } from "../../../../components/ApprovalTable";
import { approveDeploy } from "../../../../lib/actions/approvals";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Deploy queue row shape (enriched with asset info)
// ---------------------------------------------------------------------------

interface DeployQueueRow {
  queue_id: string;
  asset_id: string;
  format: string;
  language: string;
  channel_class: string;
  gate_status: string;
  queue_status: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Server-side data loading
// ---------------------------------------------------------------------------

async function loadDeployQueueForCustomer(
  customerId: string,
): Promise<DeployQueueRow[]> {
  // We need a join: content_deploy_queue JOIN content_asset WHERE asset.customer_id = customerId
  // Using getDb() directly (server component — safe, no client exposure).
  // This mirrors the pattern used in session.ts findAppUserById.
  const { getDb } = await import("@engine/db/kysely");
  const db = getDb();

  const rows = await db
    .selectFrom("content_deploy_queue as cdq")
    .innerJoin("content_asset as ca", "ca.id", "cdq.asset_id")
    .select([
      "cdq.id as queue_id",
      "cdq.asset_id",
      "ca.format",
      "ca.language",
      "ca.channel_class",
      "ca.gate_status",
      "cdq.status as queue_status",
      "cdq.approved_by",
      "cdq.approved_at",
      "cdq.created_at",
    ])
    .where("ca.customer_id", "=", customerId)
    // Show actionable rows first: queued + not-yet-approved, then others
    .orderBy("cdq.created_at", "asc")
    .execute();

  return rows.map((r) => ({
    queue_id: r.queue_id,
    asset_id: r.asset_id,
    format: r.format,
    language: r.language,
    channel_class: r.channel_class,
    gate_status: r.gate_status,
    queue_status: r.queue_status,
    approved_by: r.approved_by,
    approved_at:
      r.approved_at instanceof Date
        ? r.approved_at.toLocaleDateString("ko-KR")
        : r.approved_at
        ? String(r.approved_at)
        : null,
    created_at:
      r.created_at instanceof Date
        ? r.created_at.toLocaleDateString("ko-KR")
        : String(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DeployApprovalPage() {
  let customerId: string;
  try {
    const scope = await requireCustomerScopeWithSession();
    customerId = scope.customerId;
  } catch {
    redirect("/login");
  }

  const queueRows = await loadDeployQueueForCustomer(customerId);

  // Separate pending (not yet approved) from approved/published rows.
  const pendingRows = queueRows.filter(
    (r) => r.approved_by === null && (r.queue_status === "queued" || r.queue_status === "leased"),
  );
  const approvedRows = queueRows.filter((r) => r.approved_by !== null);

  // Table row shape (keyed by asset_id for the action)
  type TableRow = DeployQueueRow & Record<string, unknown>;
  const pendingTableRows: TableRow[] = pendingRows.map((r) => ({ ...r }));
  const approvedTableRows: TableRow[] = approvedRows.map((r) => ({ ...r }));

  const columns = [
    {
      header: "에셋 ID",
      key: "asset_id" as const,
      width: "160px",
      render: (val: unknown) => (
        <code
          style={{
            fontSize: "11px",
            color: "var(--text-muted)",
            fontFamily: "monospace",
          }}
        >
          {String(val).slice(0, 8)}…
        </code>
      ),
    },
    {
      header: "형식",
      key: "format" as const,
      render: (val: unknown) => (
        <StatusBadge status={String(val).replace(/_/g, " ")} />
      ),
    },
    {
      header: "언어",
      key: "language" as const,
      width: "80px",
      render: (val: unknown) => (
        <span
          style={{
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
            textTransform: "uppercase",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {String(val)}
        </span>
      ),
    },
    {
      header: "채널",
      key: "channel_class" as const,
      render: (val: unknown) => (
        <span
          style={{
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          {String(val).replace(/_/g, " ")}
        </span>
      ),
    },
    {
      header: "게이트 상태",
      key: "gate_status" as const,
      render: (val: unknown) => <StatusBadge status={String(val)} />,
    },
    {
      header: "큐 상태",
      key: "queue_status" as const,
      render: (val: unknown) => <StatusBadge status={String(val)} />,
    },
    {
      header: "등록일",
      key: "created_at" as const,
      align: "right" as const,
      render: (val: unknown) => (
        <span
          style={{
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {String(val)}
        </span>
      ),
    },
  ];

  return (
    <main
      style={{
        padding: "32px 24px",
        maxWidth: "1200px",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "24px",
      }}
    >
      {/* Page header */}
      <header style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <h1
          style={{
            fontSize: "var(--text-h1-size)",
            fontWeight: "var(--text-h1-weight)",
            lineHeight: "var(--text-h1-line)",
            margin: 0,
            color: "var(--text)",
          }}
        >
          배포 승인
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-body-size)",
            color: "var(--text-muted)",
            lineHeight: "var(--text-body-line)",
          }}
        >
          §11/§12 배포 승인: 콘텐츠 배포 대기열의 에셋을 검토하고 승인합니다.
          승인자 이메일이 감사 기록에 영구적으로 남습니다.
        </p>
      </header>

      {/* Summary counts */}
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
        <SummaryCard
          label="승인 대기"
          value={String(pendingRows.length)}
          highlight={pendingRows.length > 0}
        />
        <SummaryCard
          label="승인 완료"
          value={String(approvedRows.length)}
        />
        <SummaryCard
          label="전체 배포 행"
          value={String(queueRows.length)}
        />
      </div>

      {/* Pending approval section */}
      <section style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: 0,
            color: "var(--text)",
          }}
        >
          승인 대기 에셋
        </h2>
        <ApprovalTable
          columns={columns}
          rows={pendingTableRows}
          idKey="asset_id"
          onAction={approveDeploy}
          actionLabel="승인"
          actionPendingLabel="승인 중..."
          actionColumnHeader="승인"
          emptyLabel="승인 대기 중인 에셋이 없습니다."
        />
      </section>

      {/* Already-approved section */}
      {approvedRows.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <h2
            style={{
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              margin: 0,
              color: "var(--text)",
            }}
          >
            승인 완료 에셋
          </h2>
          <div
            style={{
              overflowX: "auto",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-card)",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "var(--text-body-size)",
                color: "var(--text)",
              }}
            >
              <thead>
                <tr
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      style={{
                        padding: "10px 16px",
                        textAlign: col.align ?? "left",
                        fontSize: "12px",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "var(--text-muted)",
                        whiteSpace: "nowrap",
                        width: col.width,
                      }}
                    >
                      {col.header}
                    </th>
                  ))}
                  <th
                    style={{
                      padding: "10px 16px",
                      textAlign: "right",
                      fontSize: "12px",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    승인자
                  </th>
                </tr>
              </thead>
              <tbody>
                {approvedTableRows.map((row, i) => (
                  <tr
                    key={row.queue_id}
                    style={{
                      backgroundColor:
                        i % 2 === 1 ? "var(--bg-subtle)" : "var(--bg-elev)",
                      borderBottom: "1px solid var(--border)",
                      height: "40px",
                    }}
                  >
                    {columns.map((col) => {
                      const val = row[col.key as keyof typeof row];
                      return (
                        <td
                          key={col.key}
                          style={{
                            padding: "0 16px",
                            textAlign: col.align ?? "left",
                            fontVariantNumeric: "tabular-nums",
                            verticalAlign: "middle",
                          }}
                        >
                          {col.render
                            ? col.render(val)
                            : val === null || val === undefined
                            ? <span style={{ color: "var(--text-muted)" }}>—</span>
                            : String(val)}
                        </td>
                      );
                    })}
                    <td
                      style={{
                        padding: "0 16px",
                        textAlign: "right",
                        verticalAlign: "middle",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "var(--text-caption-size)",
                          color: "var(--positive)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {row.approved_by ?? "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Disclosure */}
      <footer
        style={{
          padding: "16px",
          borderTop: "1px solid var(--border)",
          fontSize: "var(--text-caption-size)",
          color: "var(--text-muted)",
          lineHeight: "var(--text-caption-line)",
        }}
      >
        <p style={{ margin: 0 }}>
          §11/§12 배포 승인: 승인은 취소할 수 없으며 마지막 서명자가 기록됩니다.
          승인된 에셋은 배포 파이프라인에 의해 처리됩니다.
          승인자 이메일이 감사 기록(url_registry.approver_audit)에 영구적으로 기록됩니다.
        </p>
        <p style={{ margin: "8px 0 0 0" }}>
          성과(노출)는 보장하지 않습니다 — 배포 승인은 콘텐츠 게시의 선결 조건이며 결과를 보장하지 않습니다.
        </p>
      </footer>
    </main>
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
          color: highlight ? "var(--warning)" : "var(--text)",
          lineHeight: 1.2,
        }}
      >
        {value}
      </span>
    </div>
  );
}
