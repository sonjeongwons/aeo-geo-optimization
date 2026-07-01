/**
 * apps/web/app/(app)/settings/page.tsx
 *
 * Settings page — account and notification preferences.
 *
 * Phase 5 ships a minimal settings page showing:
 *  - Account info (email, role, customer ID)
 *  - Delivery preferences (email address for weekly reports)
 *  - §0 / §1 honesty footers
 *
 * Mutations (update email preferences, change password) are deferred
 * to a future phase; placeholders are shown with appropriate affordances.
 *
 * Auth enforced by (app) layout.
 */

import { redirect } from "next/navigation";
import { requireCustomerScopeWithSession } from "../../../lib/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let customerId: string;
  let email: string;
  let role: string;
  try {
    const result = await requireCustomerScopeWithSession();
    customerId = result.customerId;
    email = result.session.email;
    role = result.session.role;
  } catch {
    redirect("/login");
  }

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
          설정
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          계정 및 알림 설정
        </p>
      </header>

      {/* Account info card */}
      <section className="card" style={{ padding: "24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 20px 0",
            color: "var(--text)",
          }}
        >
          계정 정보
        </h2>

        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "var(--text-body-size)",
          }}
        >
          <tbody>
            {[
              { label: "이메일", value: email },
              { label: "역할", value: role === "owner" ? "소유자" : role === "member" ? "멤버" : role },
              {
                label: "고객 ID",
                value: customerId,
                mono: true,
              },
            ].map((row) => (
              <tr
                key={row.label}
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <td
                  style={{
                    padding: "12px 0",
                    color: "var(--text-muted)",
                    width: "160px",
                    fontSize: "var(--text-body-size)",
                  }}
                >
                  {row.label}
                </td>
                <td
                  style={{
                    padding: "12px 0",
                    color: "var(--text)",
                    fontFamily: row.mono ? "monospace" : undefined,
                    fontSize: row.mono ? "12px" : undefined,
                  }}
                >
                  {row.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Weekly report delivery */}
      <section className="card" style={{ padding: "24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 8px 0",
            color: "var(--text)",
          }}
        >
          주간 리포트 알림
        </h2>
        <p
          style={{
            margin: "0 0 20px 0",
            fontSize: "var(--text-body-size)",
            color: "var(--text-muted)",
            lineHeight: "var(--text-body-line)",
          }}
        >
          매주 주간 SMR 리포트가 아래 이메일로 자동 발송됩니다.
          이메일 주소 변경은 영업팀에 문의하세요.
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "12px 16px",
            backgroundColor: "var(--bg-subtle)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-card)",
          }}
        >
          <span
            style={{
              fontSize: "var(--text-body-size)",
              color: "var(--text)",
            }}
          >
            {email}
          </span>
          <span
            className="badge badge-active"
            style={{ flexShrink: 0 }}
          >
            활성
          </span>
        </div>

        <p
          style={{
            margin: "12px 0 0 0",
            fontSize: "var(--text-caption-size)",
            color: "var(--text-muted)",
          }}
        >
          리포트에는 §0 성과 비보장 고지 및 §7 자가 판정 편향 공시가 포함됩니다.
        </p>
      </section>

      {/* Password change placeholder */}
      <section className="card" style={{ padding: "24px" }}>
        <h2
          style={{
            fontSize: "var(--text-h2-size)",
            fontWeight: "var(--text-h2-weight)",
            margin: "0 0 8px 0",
            color: "var(--text)",
          }}
        >
          비밀번호 변경
        </h2>
        <p
          style={{
            margin: "0 0 16px 0",
            fontSize: "var(--text-body-size)",
            color: "var(--text-muted)",
          }}
        >
          비밀번호 변경 기능은 다음 버전에서 제공됩니다.
          변경이 필요하시면 영업팀에 문의하세요.
        </p>
        <button
          disabled
          style={{
            padding: "8px 16px",
            borderRadius: "var(--radius-btn)",
            border: "1px solid var(--border)",
            backgroundColor: "var(--bg-subtle)",
            color: "var(--text-muted)",
            fontSize: "var(--text-body-size)",
            cursor: "not-allowed",
            opacity: 0.6,
          }}
        >
          비밀번호 변경 (준비 중)
        </button>
      </section>

      {/* Service terms summary */}
      <section
        style={{
          padding: "16px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)",
          fontSize: "var(--text-caption-size)",
          color: "var(--text-muted)",
          lineHeight: "var(--text-caption-line)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        <p style={{ margin: 0, color: "var(--warning)", fontWeight: 500 }}>
          성과(노출) 보장 없음 (§0)
        </p>
        <p style={{ margin: 0 }}>
          본 서비스는 AI 엔진에서의 브랜드 노출 현황을 진단하고 최적화를 지원합니다.
          특정 노출 성과나 순위를 보장하지 않습니다.
        </p>
        <p style={{ margin: 0 }}>
          월단위 구독 · 무약정 · 언제든 해지 가능 · VAT 별도 청구. (§1)
        </p>
      </section>
    </div>
  );
}
