/**
 * apps/web/app/(app)/approvals/claims/page.tsx
 *
 * §7 Claim sign-off page — per-customer, authenticated.
 *
 * Lists:
 *  - Content assets with gate_status='needs_human' for the customer's content sets.
 *  - Unsigned claim_source rows for the customer.
 *
 * Sign action:
 *  → calls signClaimSourceForCustomer(claimId, customerId, sessionEmail) via Server Action
 *  → re-gates affected assets at $0 (no LLM)
 *
 * SECURITY:
 *  - requireCustomerScope() enforces authentication + tenant scoping server-side.
 *  - The customerId is NEVER read from URL params — always from the session.
 *  - Signing a row owned by another tenant returns a not-found error (fail-closed).
 *
 * §12 AUDIT: the signer email (session.email) is stamped on claim_source.verified_by.
 */

import { redirect } from "next/navigation";
import { requireCustomerScopeWithSession } from "../../../../lib/session";
import {
  findClaimSources,
} from "../../../../lib/engine.server";
import { ApprovalTable, StatusBadge } from "../../../../components/ApprovalTable";
import { signClaim } from "../../../../lib/actions/approvals";
import type { ClaimSourceRow } from "@engine/db/schema";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ClaimsApprovalPage() {
  let customerId: string;
  try {
    const scope = await requireCustomerScopeWithSession();
    customerId = scope.customerId;
  } catch {
    redirect("/login");
  }

  // Load all claim_source rows for this customer.
  const allClaims: ClaimSourceRow[] = await findClaimSources(customerId);

  // Unsigned claims are those awaiting human verification.
  const unsignedClaims = allClaims.filter((c) => c.verified_by === null);

  // All claims for display (show signed ones too for audit visibility).
  const tableRows = allClaims.map((c) => ({
    id: c.id,
    claim_text: c.claim_text,
    claim_kind: c.claim_kind,
    source_kind: c.source_kind,
    verified_by: c.verified_by ?? null,
    status: c.verified_by ? "signed" : "unsigned",
    created_at: c.created_at instanceof Date
      ? c.created_at.toLocaleDateString("ko-KR")
      : String(c.created_at),
  }));

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
          클레임 서명
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-body-size)",
            color: "var(--text-muted)",
            lineHeight: "var(--text-body-line)",
          }}
        >
          §7 콘텐츠 게이트에서 인간 검토가 필요한 클레임을 확인하고 서명합니다.
          서명 후 해당 에셋은 $0 비용으로 재검토됩니다 (LLM 없음).
        </p>
      </header>

      {/* Summary counts */}
      <div
        style={{
          display: "flex",
          gap: "16px",
          flexWrap: "wrap",
        }}
      >
        <SummaryCard
          label="전체 클레임"
          value={String(allClaims.length)}
        />
        <SummaryCard
          label="미서명 클레임"
          value={String(unsignedClaims.length)}
          highlight={unsignedClaims.length > 0}
        />
        <SummaryCard
          label="서명 완료"
          value={String(allClaims.length - unsignedClaims.length)}
        />
      </div>

      {/* Claims table */}
      <section style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: 0,
            color: "var(--text)",
          }}
        >
          클레임 목록
        </h2>

        <ApprovalTable
          columns={[
            {
              header: "클레임 텍스트",
              key: "claim_text",
              width: "35%",
              render: (val) => (
                <span
                  style={{
                    display: "block",
                    maxWidth: "400px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "var(--text-body-size)",
                    color: "var(--text)",
                  }}
                  title={String(val)}
                >
                  {String(val)}
                </span>
              ),
            },
            {
              header: "종류",
              key: "claim_kind",
              width: "110px",
              render: (val) => (
                <StatusBadge status={String(val)} />
              ),
            },
            {
              header: "출처 종류",
              key: "source_kind",
              width: "150px",
              render: (val) => (
                <span
                  style={{
                    fontSize: "var(--text-caption-size)",
                    color: "var(--text-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {String(val).replace(/_/g, " ")}
                </span>
              ),
            },
            {
              header: "상태",
              key: "status",
              width: "110px",
              render: (val) => (
                <StatusBadge status={String(val)} />
              ),
            },
            {
              header: "서명자",
              key: "verified_by",
              render: (val) =>
                val ? (
                  <span
                    style={{
                      fontSize: "var(--text-caption-size)",
                      color: "var(--text-muted)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {String(val)}
                  </span>
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>—</span>
                ),
            },
            {
              header: "등록일",
              key: "created_at",
              align: "right",
              render: (val) => (
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
          ]}
          rows={tableRows}
          idKey="id"
          onAction={signClaim}
          actionLabel="서명"
          actionPendingLabel="서명 중..."
          actionColumnHeader="서명"
          emptyLabel="클레임이 없습니다. 콘텐츠 생성 후 클레임이 등록됩니다."
        />
      </section>

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
          §7 클레임 서명: 서명은 해당 클레임이 외부적으로 검증 가능함을 확인하는 행위입니다.
          서명자 이메일이 감사 기록에 남습니다. 서명 후 해당 에셋은 자동으로 재검토됩니다.
        </p>
        <p style={{ margin: "8px 0 0 0" }}>
          성과(노출)는 보장하지 않습니다 — 클레임 서명은 콘텐츠 배포의 선결 조건이며 결과를 보장하지 않습니다.
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
