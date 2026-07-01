/**
 * apps/web/app/(app)/billing/page.tsx
 *
 * Billing page — per-customer, authenticated (TenantGuard enforced by (app) layout).
 *
 * Displays:
 *  - Current plan (tier, base price, period)
 *  - Usage gauge (LLM provider cost vs monthly cap)
 *  - Question × language scope (what drives the price)
 *  - Projected / current invoice
 *  - Invoice history
 *  - §1 "월단위·무약정 — 언제든 해지" cancel panel
 *  - §0 no-guarantee caveat near plan terms
 *
 * Architecture:
 *  - Server Component: reads data server-side, no raw SQL.
 *  - All reads go through engine.server.ts facade (server-only).
 *  - Billing mutation (cancel) is a Server Action in lib/actions/billing.ts.
 *  - UsageGauge and billing-specific inline components are client components.
 */

import { redirect } from "next/navigation";
import { requireCustomerScopeWithSession } from "../../../lib/session";
import {
  getSubscription,
  listInvoices,
  sumLlmUsageForPeriod,
  findActiveQuestions,
  findCustomerLanguages,
  findEnabledModels,
} from "../../../lib/engine.server";
import {
  priceForScope,
  usdToKrw,
  applyMargin,
  computeVat,
  DEFAULT_FX_RATE_KRW_PER_USD,
  OVERAGE_MARGIN_MULTIPLIER,
} from "@engine/billing/pricing";
import { UsageGauge } from "../../../components/UsageGauge";
import { CancelPanel } from "./CancelPanel";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatKrw(krw: number | string): string {
  const n = typeof krw === "string" ? parseFloat(krw) : krw;
  return "₩" + Math.round(n).toLocaleString("ko-KR");
}

function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function periodLabel(start: Date | string, end: Date | string): string {
  const s = typeof start === "string" ? new Date(start) : start;
  return `${s.getUTCFullYear()}년 ${s.getUTCMonth() + 1}월`;
}

type StatusBadge = "draft" | "issued" | "paid" | "void";
function invoiceStatusLabel(status: string): string {
  const labels: Record<StatusBadge, string> = {
    draft: "초안",
    issued: "발행됨",
    paid: "결제완료",
    void: "취소됨",
  };
  return labels[status as StatusBadge] ?? status;
}
function invoiceStatusClass(status: string): string {
  if (status === "paid") return "badge badge-active";
  if (status === "issued") return "badge badge-reviewed";
  if (status === "void") return "badge badge-error";
  return "badge badge-draft";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function BillingPage() {
  // Fail-closed: redirect to login if no session.
  let customerId: string;
  try {
    const result = await requireCustomerScopeWithSession();
    customerId = result.customerId;
  } catch {
    redirect("/login");
  }

  // Load billing data in parallel.
  const now = new Date();
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );

  const [subscription, invoices, llmUsageUsd, activeQuestions, customerLanguages, enabledModels] =
    await Promise.all([
      getSubscription(customerId),
      listInvoices(customerId),
      sumLlmUsageForPeriod(customerId, periodStart, periodEnd),
      // Real scope reads — same counts close.ts uses for billing (single source of truth).
      findActiveQuestions(customerId),
      findCustomerLanguages(customerId),
      findEnabledModels(),
    ]);

  // Compute current scope pricing using the SAME pure functions and constants as
  // close.ts so the displayed quote equals what close.ts would bill (BHB-2 fix).
  const chatModelCount = Math.max(
    1,
    enabledModels.filter((m) => m.modality === "chat").length
  );
  const scopeForDisplay = {
    questionCount: activeQuestions.length,
    languageCount: customerLanguages.length,
    models: chatModelCount,
    samples: 3, // §5.3 default sampling depth — matches close.ts readCustomerScope
  };
  const priceEstimate = priceForScope(scopeForDisplay);

  // Compute overage/VAT using the SAME helpers and constants as close.ts.
  // Current period spend (null = no CAGG data yet = treat as $0).
  const spentUsd = llmUsageUsd ?? 0;
  const providerCostKrw = usdToKrw(spentUsd, DEFAULT_FX_RATE_KRW_PER_USD);
  const overageKrw = applyMargin(providerCostKrw, OVERAGE_MARGIN_MULTIPLIER);
  const preTaxKrw = priceEstimate.baseKrw + overageKrw;
  const vatKrw = computeVat(preTaxKrw);
  const projectedTotalKrw = preTaxKrw + vatKrw;

  // Monthly USD cap: read from budget or use a default (subscription may not have it).
  const monthlyCap = 50; // $50 default internal cost cap; real value from budget table

  // Cache hit rate: not available without a separate query here; omit for now.
  const cacheHitRate: number | null = null;

  const currentPeriodLabel = periodLabel(periodStart, periodEnd);

  return (
    <main
      style={{
        maxWidth: "var(--content-max)",
        margin: "0 auto",
        padding: "var(--gutter)",
        color: "var(--text)",
      }}
    >
      {/* Page header */}
      <div style={{ marginBottom: "32px" }}>
        <h1
          style={{
            fontSize: "var(--text-h1-size)",
            fontWeight: "var(--text-h1-weight)",
            lineHeight: "var(--text-h1-line)",
            margin: "0 0 4px 0",
            color: "var(--text)",
          }}
        >
          청구 및 구독
        </h1>
        <p
          style={{
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
            margin: 0,
          }}
        >
          월단위 · 무약정 — VAT 별도 · 성과(노출) 보장 없음
        </p>
      </div>

      <div style={{ display: "grid", gap: "24px" }}>
        {/* Current plan card */}
        <section className="card" style={{ padding: "24px" }}>
          <h2
            style={{
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              margin: "0 0 20px 0",
              color: "var(--text)",
            }}
          >
            현재 플랜
          </h2>

          {subscription ? (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  marginBottom: "16px",
                }}
              >
                <span
                  style={{
                    fontSize: "var(--text-metric-size)",
                    fontWeight: "var(--text-metric-weight)",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--accent)",
                  }}
                >
                  {formatKrw(subscription.base_krw)}
                </span>
                <span
                  style={{
                    fontSize: "var(--text-body-size)",
                    color: "var(--text-muted)",
                  }}
                >
                  / 월 (VAT 별도)
                </span>
                <span
                  className={
                    subscription.status === "active"
                      ? "badge badge-active"
                      : "badge badge-warning"
                  }
                >
                  {subscription.status === "active"
                    ? "활성"
                    : subscription.status === "trialing"
                    ? "체험 중"
                    : subscription.status === "paused"
                    ? "일시 정지"
                    : "해지됨"}
                </span>
              </div>

              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "var(--text-body-size)",
                }}
              >
                <tbody>
                  {[
                    { label: "플랜 티어", value: subscription.plan_tier },
                    {
                      label: "현재 청구 기간",
                      value: `${formatDate(subscription.current_period_start)} ~ ${formatDate(subscription.current_period_end)}`,
                    },
                    {
                      label: "다음 갱신",
                      value: subscription.cancel_at_period_end
                        ? `${formatDate(subscription.current_period_end)} (해지 예정)`
                        : formatDate(subscription.current_period_end),
                    },
                  ].map((row) => (
                    <tr
                      key={row.label}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <td
                        style={{
                          padding: "10px 0",
                          color: "var(--text-muted)",
                          width: "160px",
                        }}
                      >
                        {row.label}
                      </td>
                      <td style={{ padding: "10px 0", color: "var(--text)" }}>
                        {row.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {subscription.cancel_at_period_end && (
                <p
                  style={{
                    marginTop: "16px",
                    padding: "12px",
                    backgroundColor: "rgba(251, 191, 36, 0.08)",
                    border: "1px solid var(--warning)",
                    borderRadius: "6px",
                    fontSize: "var(--text-caption-size)",
                    color: "var(--warning)",
                    margin: "16px 0 0 0",
                  }}
                >
                  해지가 예약되었습니다. 청구 기간 종료 시까지 서비스가 유지됩니다.
                  기간 내 재활성화하면 중단 없이 이용 가능합니다.
                </p>
              )}
            </div>
          ) : (
            <div
              style={{ color: "var(--text-muted)", fontSize: "var(--text-body-size)" }}
            >
              활성 구독이 없습니다. 영업팀에 문의하세요.
            </div>
          )}
        </section>

        {/* Usage gauge */}
        <section className="card" style={{ padding: "24px" }}>
          <h2
            style={{
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              margin: "0 0 20px 0",
              color: "var(--text)",
            }}
          >
            이번 달 LLM 사용량
          </h2>
          <UsageGauge
            spentUsd={spentUsd}
            capUsd={monthlyCap}
            cacheHitRate={cacheHitRate}
            periodLabel={currentPeriodLabel}
          />
        </section>

        {/* Scope and projected invoice */}
        <section className="card" style={{ padding: "24px" }}>
          <h2
            style={{
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              margin: "0 0 20px 0",
              color: "var(--text)",
            }}
          >
            가격 산정 기준
          </h2>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: "16px",
              marginBottom: "20px",
            }}
          >
            {[
              {
                label: "활성 질문 수",
                value: `${scopeForDisplay.questionCount}개`,
                desc: "가격 산정 기준 #1",
              },
              {
                label: "대상 언어 수",
                value: `${scopeForDisplay.languageCount}개`,
                desc: "가격 산정 기준 #2",
              },
              {
                label: "모델 수",
                value: `${scopeForDisplay.models}개`,
                desc: "측정 모델 (채팅)",
              },
              {
                label: "QxL 셀",
                value: `${priceEstimate.breakdown.qxlCells}개`,
                desc: "질문 × 언어",
              },
            ].map((stat) => (
              <div
                key={stat.label}
                style={{
                  padding: "16px",
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--text-muted)",
                    marginBottom: "6px",
                  }}
                >
                  {stat.label}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-h2-size)",
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text)",
                    marginBottom: "4px",
                  }}
                >
                  {stat.value}
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--text-muted)",
                  }}
                >
                  {stat.desc}
                </div>
              </div>
            ))}
          </div>

          {/* Projected invoice breakdown */}
          <div
            style={{
              borderTop: "1px solid var(--border)",
              paddingTop: "16px",
            }}
          >
            <p
              style={{
                fontSize: "var(--text-caption-size)",
                color: "var(--text-muted)",
                marginBottom: "12px",
              }}
            >
              예상 청구 ({currentPeriodLabel})
            </p>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "var(--text-body-size)",
              }}
            >
              <tbody>
                {[
                  {
                    label: `월정액 (${priceEstimate.tier} 티어)`,
                    amount: formatKrw(priceEstimate.baseKrw),
                  },
                  {
                    label: `LLM 사용량 초과 (마진 ${OVERAGE_MARGIN_MULTIPLIER}× 포함)`,
                    amount: formatKrw(overageKrw),
                  },
                  {
                    label: "부가가치세 (VAT 10%)",
                    amount: formatKrw(vatKrw),
                  },
                ].map((row) => (
                  <tr
                    key={row.label}
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <td
                      style={{ padding: "10px 0", color: "var(--text-muted)" }}
                    >
                      {row.label}
                    </td>
                    <td
                      style={{
                        padding: "10px 0",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--text)",
                      }}
                    >
                      {row.amount}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td
                    style={{
                      padding: "12px 0",
                      fontWeight: 600,
                      color: "var(--text)",
                    }}
                  >
                    예상 합계
                  </td>
                  <td
                    style={{
                      padding: "12px 0",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                      color: "var(--accent)",
                      fontSize: "var(--text-h2-size)",
                    }}
                  >
                    {formatKrw(projectedTotalKrw)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p
              style={{
                fontSize: "11px",
                color: "var(--text-muted)",
                marginTop: "8px",
              }}
            >
              * 예상 금액입니다. 실제 청구는 매월 1일 확정됩니다.
              성과(노출) 보장 없음 (§0).
            </p>
          </div>
        </section>

        {/* Invoice history */}
        <section className="card" style={{ padding: "24px" }}>
          <h2
            style={{
              fontSize: "var(--text-h2-size)",
              fontWeight: "var(--text-h2-weight)",
              margin: "0 0 20px 0",
              color: "var(--text)",
            }}
          >
            청구서 내역
          </h2>

          {invoices.length === 0 ? (
            <p
              style={{
                color: "var(--text-muted)",
                fontSize: "var(--text-body-size)",
              }}
            >
              발행된 청구서가 없습니다. 매월 1일 이전 달 청구서가 발행됩니다.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "var(--text-body-size)",
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid var(--border)",
                      textAlign: "left",
                    }}
                  >
                    {[
                      "청구 기간",
                      "기본료",
                      "사용량",
                      "VAT",
                      "합계",
                      "상태",
                      "발행일",
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "10px 8px",
                          color: "var(--text-muted)",
                          fontWeight: 500,
                          fontSize: "12px",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr
                      key={inv.id}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <td
                        style={{
                          padding: "10px 8px",
                          color: "var(--text)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {periodLabel(inv.period_start, inv.period_end)}
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--text)",
                        }}
                      >
                        {formatKrw(inv.base_krw)}
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--text)",
                        }}
                      >
                        {formatKrw(inv.usage_overage_krw)}
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--text-muted)",
                        }}
                      >
                        {formatKrw(inv.vat_krw)}
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 600,
                          color: "var(--accent)",
                        }}
                      >
                        {formatKrw(inv.total_krw)}
                      </td>
                      <td style={{ padding: "10px 8px" }}>
                        <span className={invoiceStatusClass(inv.status)}>
                          {invoiceStatusLabel(inv.status)}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          color: "var(--text-muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {inv.issued_at ? formatDate(inv.issued_at) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Cancel panel — §1 month-to-month/no-lock-in */}
        {subscription && !subscription.cancel_at_period_end && (
          <CancelPanel
            periodEnd={
              typeof subscription.current_period_end === "string"
                ? subscription.current_period_end
                : subscription.current_period_end.toISOString()
            }
          />
        )}

        {/* §0 no-guarantee footer */}
        <footer
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: "16px",
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
            lineHeight: "20px",
          }}
        >
          <p style={{ margin: "0 0 4px 0" }}>
            <span style={{ color: "var(--warning)" }}>
              성과(노출) 보장 없음:
            </span>{" "}
            본 서비스는 AI 엔진에서의 브랜드 노출 현황을 진단하고 최적화를
            지원합니다. 특정 노출 성과나 순위를 보장하지 않습니다.
          </p>
          <p style={{ margin: 0 }}>
            월단위 구독 · 무약정 · 언제든 해지 가능 · VAT 별도 청구.
            결제는 B2B 인보이스 방식으로 진행됩니다.
          </p>
        </footer>
      </div>
    </main>
  );
}
