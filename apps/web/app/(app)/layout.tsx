/**
 * apps/web/app/(app)/layout.tsx
 *
 * TenantGuard auth shell + left sidebar for the authed dashboard.
 *
 * - Server Component: calls requireCustomerScope() (fail-closed).
 * - No session → redirect to /login via requireCustomerScope().
 * - Staff user without a customer_id → 403 (they should use the (staff) area).
 * - Renders a fixed 240px left sidebar with nav links and a dense main area.
 *
 * Sidebar nav: Overview, Trends, Models, Languages, Competitors, Priority Gaps,
 *              Reports, Approvals (Claims / Deploy), Billing, Settings.
 *
 * gpto-style: dark navy sidebar, cyan active indicators, no gradients.
 */

import { redirect } from "next/navigation";
import { requireCustomerScopeWithSession } from "../../lib/session";
import type { ServerSession } from "../../lib/session";
import { NavLink } from "../../components/NavLink";

// ---------------------------------------------------------------------------
// Sidebar nav items
// ---------------------------------------------------------------------------

const NAV_SECTIONS = [
  {
    label: "측정",
    items: [
      // W7.5 — "/" is the marketing page; the dashboard overview lives at /overview.
      { href: "/overview", label: "개요 (Overview)" },
      { href: "/trends", label: "트렌드" },
    ],
  },
  {
    label: "분석",
    items: [
      { href: "/models", label: "모델별" },
      { href: "/languages", label: "언어별" },
      { href: "/competitors", label: "경쟁사" },
      { href: "/gaps", label: "우선 갭" },
    ],
  },
  {
    label: "리포트",
    items: [{ href: "/reports", label: "주간 리포트" }],
  },
  {
    label: "워크플로",
    items: [
      { href: "/approvals/claims", label: "클레임 서명" },
      { href: "/approvals/deploy", label: "배포 승인" },
    ],
  },
  {
    label: "계정",
    items: [
      { href: "/billing", label: "청구" },
      { href: "/settings", label: "설정" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fail-closed: redirect to /login if no session, 403 if staff user.
  let session: ServerSession;
  try {
    const result = await requireCustomerScopeWithSession();
    session = result.session;
  } catch {
    redirect("/login");
  }

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        backgroundColor: "var(--bg)",
      }}
    >
      {/* Fixed left sidebar */}
      <aside
        className="app-sidebar"
        style={{
          width: "var(--sidebar-width)",
          flexShrink: 0,
          backgroundColor: "var(--bg-elev)",
          borderRight: "1px solid var(--border)",
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          zIndex: 10,
        }}
      >
        {/* Logo / Brand */}
        <div
          style={{
            padding: "20px 20px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <a
            href="/overview"
            style={{
              textDecoration: "none",
              display: "block",
            }}
          >
            <span
              style={{
                fontSize: "15px",
                fontWeight: 700,
                color: "var(--accent)",
                letterSpacing: "-0.01em",
              }}
            >
              AEO/GEO
            </span>
            <span
              style={{
                display: "block",
                fontSize: "11px",
                color: "var(--text-muted)",
                marginTop: "2px",
                fontWeight: 400,
              }}
            >
              AI 엔진 최적화 대시보드
            </span>
          </a>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "12px 0" }}>
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} style={{ marginBottom: "4px" }}>
              <div
                style={{
                  padding: "8px 20px 4px",
                  fontSize: "10px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--text-muted)",
                }}
              >
                {section.label}
              </div>
              {section.items.map((item) => (
                <NavLink key={item.href} href={item.href} label={item.label} />
              ))}
            </div>
          ))}
        </nav>

        {/* User info + logout */}
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: "12px 20px",
          }}
        >
          <div
            style={{
              fontSize: "12px",
              color: "var(--text-muted)",
              marginBottom: "8px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={session.email}
          >
            {session.email}
          </div>
          <form action="/api/auth/logout" method="POST">
            <button
              type="submit"
              style={{
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-btn)",
                color: "var(--text-muted)",
                fontSize: "12px",
                padding: "4px 10px",
                cursor: "pointer",
                width: "100%",
                textAlign: "left",
              }}
            >
              로그아웃
            </button>
          </form>
          {/* §0 / §1 honesty footer */}
          <p
            style={{
              margin: "10px 0 0 0",
              fontSize: "10px",
              color: "var(--text-muted)",
              lineHeight: "14px",
            }}
          >
            노출 보장 없음 · 월단위 무약정
          </p>
        </div>
      </aside>

      {/* Main content area — offset by sidebar width */}
      <main
        className="app-main"
        style={{
          flex: 1,
          marginLeft: "var(--sidebar-width)",
          minHeight: "100vh",
          backgroundColor: "var(--bg)",
          overflowX: "hidden",
        }}
      >
        {children}
      </main>
    </div>
  );
}
