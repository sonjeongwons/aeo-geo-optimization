/**
 * apps/web/app/(staff)/layout.tsx
 *
 * Staff console shell — requireStaff() enforces role='staff'.
 *
 * SECURITY: any non-staff session is 403'd before reaching any (staff)/* page
 * or action. Customers cannot reach template review/activate via this shell.
 *
 * Design: dark navy/cyan gpto-style, dense sidebar navigation for staff ops.
 */

import { redirect } from "next/navigation";
import { requireStaff } from "../../lib/session";
import { ScopeError } from "../../lib/session";

export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fail-closed: staff guard on every (staff)/* page.
  let staffEmail: string;
  try {
    const session = await requireStaff();
    staffEmail = session.email;
  } catch (err) {
    if (err instanceof ScopeError) {
      // Non-staff authenticated user → 403 page.
      return (
        <html lang="ko">
          <body
            style={{
              margin: 0,
              background: "var(--bg, #0B1020)",
              color: "var(--text, #E6EAF2)",
              fontFamily: "Pretendard, -apple-system, Segoe UI, sans-serif",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: "100vh",
            }}
          >
            <div style={{ textAlign: "center", maxWidth: "400px" }}>
              <p
                style={{
                  fontSize: "48px",
                  fontWeight: 700,
                  color: "#F87171",
                  margin: "0 0 16px",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                403
              </p>
              <p
                style={{
                  fontSize: "18px",
                  fontWeight: 600,
                  margin: "0 0 8px",
                }}
              >
                접근 권한 없음
              </p>
              <p
                style={{
                  fontSize: "14px",
                  color: "#93A0B8",
                  margin: "0 0 24px",
                }}
              >
                스태프 전용 영역입니다. 고객 계정으로 접근할 수 없습니다.
              </p>
              <a
                href="/"
                style={{
                  display: "inline-block",
                  padding: "10px 20px",
                  background: "#22D3EE",
                  color: "#0B1020",
                  borderRadius: "6px",
                  textDecoration: "none",
                  fontSize: "14px",
                  fontWeight: 600,
                }}
              >
                대시보드로 돌아가기
              </a>
            </div>
          </body>
        </html>
      );
    }
    // No session → redirect to login.
    redirect("/login");
  }

  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          background: "#0B1020",
          color: "#E6EAF2",
          fontFamily: "Pretendard, -apple-system, Segoe UI, sans-serif",
          minHeight: "100vh",
          display: "flex",
        }}
      >
        {/* Staff sidebar */}
        <nav
          style={{
            width: "240px",
            flexShrink: 0,
            background: "#0F1626",
            borderRight: "1px solid #1E2A44",
            padding: "24px 0",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Logo / title */}
          <div style={{ padding: "0 20px 24px", borderBottom: "1px solid #1E2A44" }}>
            <div
              style={{
                fontSize: "12px",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "#22D3EE",
                fontWeight: 600,
                marginBottom: "4px",
              }}
            >
              STAFF CONSOLE
            </div>
            <div style={{ fontSize: "11px", color: "#93A0B8" }}>
              {staffEmail}
            </div>
          </div>

          {/* Navigation links */}
          <div style={{ padding: "16px 0", flex: 1 }}>
            {[
              { href: "/staff/templates", label: "템플릿 관리", desc: "review / activate / edit" },
            ].map((item) => (
              <a
                key={item.href}
                href={item.href}
                style={{
                  display: "block",
                  padding: "10px 20px",
                  color: "#E6EAF2",
                  textDecoration: "none",
                  fontSize: "14px",
                  fontWeight: 500,
                  borderLeft: "2px solid transparent",
                  transition: "all 0.1s",
                }}
              >
                {item.label}
                <span
                  style={{
                    display: "block",
                    fontSize: "11px",
                    color: "#93A0B8",
                    fontWeight: 400,
                    marginTop: "2px",
                  }}
                >
                  {item.desc}
                </span>
              </a>
            ))}
          </div>

          {/* Bottom note */}
          <div
            style={{
              padding: "16px 20px",
              borderTop: "1px solid #1E2A44",
              fontSize: "11px",
              color: "#93A0B8",
            }}
          >
            스태프 전용 영역입니다.
            <br />
            고객 데이터에 직접 접근하지 않습니다.
          </div>
        </nav>

        {/* Main content area */}
        <main
          style={{
            flex: 1,
            padding: "32px",
            overflowY: "auto",
            maxWidth: "960px",
          }}
        >
          {children}
        </main>
      </body>
    </html>
  );
}
