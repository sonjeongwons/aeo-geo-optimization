/**
 * apps/web/app/(staff)/templates/page.tsx
 *
 * Staff console — §5.5 Industry Template Review / Activate / Edit
 *
 * STAFF-ONLY: requireStaff() in the (staff) layout guards this page.
 * Customers cannot reach this surface.
 *
 * Displays:
 *  - All industry_template rows (across all industries), grouped by industry.
 *  - Status badges: DRAFT / REVIEWED / ACTIVE.
 *  - Review / Activate / Edit (new draft) action buttons.
 *  - A prominent confirm warning for Activate (heavy, side-effectful: demotes
 *    prior active + emits YAML + upserts DB rows for the whole industry).
 *  - reviewed_by stamped as §12 audit identity = staff session email.
 *
 * Architecture:
 *  - Server Component: reads all templates server-side.
 *  - Action buttons are client-side forms invoking Server Actions from
 *    lib/actions/templates.ts.
 *  - No customer data is accessed here.
 *
 * Design: dark navy/cyan gpto-style, dense B2B data table.
 */

import { listAllIndustryTemplates } from "../../../lib/engine.server";
import { TemplateActions } from "./TemplateActions";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TemplateStatus = "draft" | "reviewed" | "active";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(status: TemplateStatus): { label: string; color: string; bg: string } {
  switch (status) {
    case "draft":
      return { label: "DRAFT", color: "#93A0B8", bg: "rgba(147,160,184,0.10)" };
    case "reviewed":
      return { label: "REVIEWED", color: "#22D3EE", bg: "rgba(34,211,238,0.10)" };
    case "active":
      return { label: "ACTIVE", color: "#34D399", bg: "rgba(52,211,153,0.10)" };
  }
}

function formatDate(d: Date | null): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d as string) : d;
  return dt.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function StaffTemplatesPage() {
  const templates = await listAllIndustryTemplates();

  // Group by industry for display.
  const byIndustry = new Map<string, typeof templates>();
  for (const t of templates) {
    const group = byIndustry.get(t.industry) ?? [];
    group.push(t);
    byIndustry.set(t.industry, group);
  }

  return (
    <div>
      {/* Page header */}
      <div style={{ marginBottom: "28px" }}>
        <h1
          style={{
            fontSize: "24px",
            fontWeight: 600,
            lineHeight: "32px",
            margin: "0 0 6px 0",
            color: "#E6EAF2",
          }}
        >
          산업 템플릿 관리
        </h1>
        <p style={{ fontSize: "13px", color: "#93A0B8", margin: 0 }}>
          §5.5 템플릿 라이프사이클: DRAFT → REVIEWED → ACTIVE
          <br />
          활성화(Activate)는 해당 산업의 이전 ACTIVE 템플릿을 REVIEWED로 강등하고
          YAML을 재생성합니다. 되돌릴 수 없습니다.
        </p>
      </div>

      {/* Warning banner */}
      <div
        style={{
          padding: "12px 16px",
          background: "rgba(251,191,36,0.07)",
          border: "1px solid rgba(251,191,36,0.30)",
          borderRadius: "6px",
          marginBottom: "24px",
          fontSize: "13px",
          color: "#FBBF24",
          lineHeight: "20px",
        }}
      >
        <strong>스태프 전용 영역.</strong> 이 페이지의 작업은 고객에게 즉시 영향을
        미칩니다. Activate는 YAML 재생성 + DB upsert를 수행합니다. 신중하게
        진행하세요.
      </div>

      {templates.length === 0 ? (
        <div
          style={{
            padding: "48px",
            textAlign: "center",
            color: "#93A0B8",
            fontSize: "14px",
            border: "1px solid #1E2A44",
            borderRadius: "8px",
          }}
        >
          등록된 템플릿이 없습니다.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {Array.from(byIndustry.entries()).map(([industry, rows]) => (
            <section
              key={industry}
              style={{
                background: "#121A2E",
                border: "1px solid #1E2A44",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              {/* Industry header */}
              <div
                style={{
                  padding: "14px 20px",
                  borderBottom: "1px solid #1E2A44",
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "#E6EAF2",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  {industry}
                </span>
                <span
                  style={{
                    fontSize: "11px",
                    color: "#93A0B8",
                    background: "rgba(30,42,68,0.8)",
                    padding: "2px 8px",
                    borderRadius: "10px",
                    border: "1px solid #1E2A44",
                  }}
                >
                  {rows.length}개 버전
                </span>
              </div>

              {/* Template table */}
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "13px",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        background: "#0F1626",
                        borderBottom: "1px solid #1E2A44",
                      }}
                    >
                      {[
                        "버전",
                        "상태",
                        "검토자",
                        "검토일",
                        "생성일",
                        "질문수",
                        "경쟁사수",
                        "작업",
                      ].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: "10px 16px",
                            textAlign: "left",
                            color: "#93A0B8",
                            fontWeight: 500,
                            fontSize: "11px",
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t, idx) => {
                      const badge = statusBadge(t.status);
                      const qCount = Array.isArray(t.questions) ? t.questions.length : "—";
                      const cCount = Array.isArray(t.competitors) ? t.competitors.length : "—";

                      return (
                        <tr
                          key={t.id}
                          style={{
                            borderBottom:
                              idx < rows.length - 1 ? "1px solid #1E2A44" : "none",
                            background:
                              idx % 2 === 0 ? "transparent" : "#0F1626",
                          }}
                        >
                          {/* Version */}
                          <td
                            style={{
                              padding: "12px 16px",
                              color: "#E6EAF2",
                              fontVariantNumeric: "tabular-nums",
                              fontWeight: 600,
                            }}
                          >
                            v{t.version}
                          </td>

                          {/* Status badge */}
                          <td style={{ padding: "12px 16px" }}>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "2px 8px",
                                borderRadius: "4px",
                                fontSize: "10px",
                                fontWeight: 700,
                                letterSpacing: "0.06em",
                                color: badge.color,
                                background: badge.bg,
                                border: `1px solid ${badge.color}33`,
                              }}
                            >
                              {badge.label}
                            </span>
                          </td>

                          {/* Reviewed by */}
                          <td
                            style={{
                              padding: "12px 16px",
                              color: t.reviewed_by ? "#E6EAF2" : "#93A0B8",
                              fontSize: "12px",
                              maxWidth: "160px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {t.reviewed_by ?? "—"}
                          </td>

                          {/* Reviewed at */}
                          <td
                            style={{
                              padding: "12px 16px",
                              color: "#93A0B8",
                              fontSize: "12px",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {formatDate(t.reviewed_at)}
                          </td>

                          {/* Created at */}
                          <td
                            style={{
                              padding: "12px 16px",
                              color: "#93A0B8",
                              fontSize: "12px",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {formatDate(t.created_at)}
                          </td>

                          {/* Question count */}
                          <td
                            style={{
                              padding: "12px 16px",
                              color: "#E6EAF2",
                              fontVariantNumeric: "tabular-nums",
                              textAlign: "right",
                              paddingRight: "24px",
                            }}
                          >
                            {qCount}
                          </td>

                          {/* Competitor count */}
                          <td
                            style={{
                              padding: "12px 16px",
                              color: "#E6EAF2",
                              fontVariantNumeric: "tabular-nums",
                              textAlign: "right",
                              paddingRight: "24px",
                            }}
                          >
                            {cCount}
                          </td>

                          {/* Actions (client component for confirm dialogs) */}
                          <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>
                            <TemplateActions
                              templateId={t.id}
                              status={t.status}
                              industry={t.industry}
                              version={t.version}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Footer note */}
      <div
        style={{
          marginTop: "32px",
          paddingTop: "16px",
          borderTop: "1px solid #1E2A44",
          fontSize: "11px",
          color: "#93A0B8",
          lineHeight: "18px",
        }}
      >
        §5.5 DRAFT → REVIEWED → ACTIVE (두 단계 강제). 활성화 시 YAML 생성 +
        loadTemplate() DB upsert 실행.
        <br />
        Edit은 기존 행을 변경하지 않고 새로운 DRAFT 버전을 생성합니다 (불변 이력).
      </div>
    </div>
  );
}
