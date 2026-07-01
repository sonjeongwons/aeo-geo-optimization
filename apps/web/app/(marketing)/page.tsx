"use client";

/**
 * TIER 1 — Free-diagnostic widget (public, no auth)
 *
 * Dark gpto-style hero with a single "URL 진단 시작" input.
 * The submit button invokes runDiagnose (Server Action) which:
 *  - Enforces a per-IP/day hard cost cap (§11 budget gate)
 *  - Runs a baseline for the pre-configured demo/lead customer (NOT a cold URL)
 *  - Redirects to /diagnose/[runId] on success
 *
 * §0: 현 위치 진단입니다 — 노출을 보장하지 않습니다.
 * §1: 월단위·무약정 — 언제든 해지.
 */

import { useActionState } from "react";
import { runDiagnose, type DiagnoseState } from "../../lib/actions/diagnose";

const initialState: DiagnoseState = {};

export default function MarketingPage() {
  // React 19: useActionState returns [state, action, isPending]
  const [state, formAction, isPending] = useActionState(runDiagnose, initialState);

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--font-sans)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--gutter)",
      }}
    >
      {/* Hero section */}
      <section
        style={{
          maxWidth: "640px",
          width: "100%",
          textAlign: "center",
        }}
      >
        <h1
          style={{
            fontSize: "var(--text-display-size)",
            lineHeight: "var(--text-display-line)",
            fontWeight: "var(--text-display-weight)",
            color: "var(--text)",
            margin: "0 0 16px 0",
          }}
        >
          AI 엔진에서{" "}
          <span style={{ color: "var(--accent)" }}>귀사 브랜드</span>가
          <br />
          얼마나 노출되고 있나요?
        </h1>

        <p
          style={{
            fontSize: "var(--text-body-size)",
            lineHeight: "var(--text-body-line)",
            color: "var(--text-muted)",
            margin: "0 0 40px 0",
          }}
        >
          SMR(Share of Model Response)로 측정하는 AI 검색 노출도.
          <br />
          ChatGPT, Gemini, Claude 등 10개 이상 모델에서의 브랜드 언급을 추적합니다.
        </p>

        {/* Diagnostic input form */}
        <form
          action={formAction}
          style={{
            display: "flex",
            gap: "12px",
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          <input
            type="text"
            name="url"
            placeholder="브랜드명 또는 URL 입력"
            disabled={isPending}
            style={{
              flex: "1",
              minWidth: "240px",
              padding: "12px 16px",
              backgroundColor: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-btn)",
              color: "var(--text)",
              fontSize: "var(--text-body-size)",
              outline: "none",
              opacity: isPending ? 0.6 : 1,
            }}
          />
          <button
            type="submit"
            disabled={isPending}
            className="btn-primary"
            style={{ whiteSpace: "nowrap", opacity: isPending ? 0.7 : 1 }}
          >
            {isPending ? "진단 중…" : "URL 진단 시작"}
          </button>
        </form>

        {/* Error state */}
        {state.error && (
          <p
            style={{
              marginTop: "16px",
              fontSize: "var(--text-caption-size)",
              lineHeight: "var(--text-caption-line)",
              color: "var(--negative)",
              backgroundColor: "rgba(248,113,113,0.08)",
              border: "1px solid var(--negative)",
              borderRadius: "var(--radius-card)",
              padding: "10px 16px",
              textAlign: "left",
            }}
            role="alert"
          >
            {state.error}
          </p>
        )}

        {/* §0 honesty — always visible */}
        <p
          style={{
            marginTop: "32px",
            fontSize: "var(--text-caption-size)",
            lineHeight: "var(--text-caption-line)",
            color: "var(--warning)",
          }}
        >
          현 위치 진단입니다 — 노출을 보장하지 않습니다.
        </p>

        {/* §1 no-lock-in — always visible */}
        <p
          style={{
            marginTop: "8px",
            fontSize: "var(--text-caption-size)",
            lineHeight: "var(--text-caption-line)",
            color: "var(--text-muted)",
          }}
        >
          월단위 · 무약정 — 언제든 해지 가능 · VAT 별도
        </p>
      </section>

      {/* Feature strip */}
      <section
        style={{
          display: "flex",
          gap: "24px",
          marginTop: "80px",
          flexWrap: "wrap",
          justifyContent: "center",
          maxWidth: "var(--content-max)",
          width: "100%",
        }}
      >
        {[
          { label: "SMR 측정", desc: "10개 이상 AI 모델 동시 추적" },
          { label: "주간 리포트", desc: "매주 WoW 델타 포함 자동 발송" },
          { label: "격차 분석", desc: "경쟁사 대비 우선순위 질문 도출" },
        ].map((f) => (
          <div
            key={f.label}
            className="card"
            style={{
              padding: "24px",
              minWidth: "180px",
              flex: "1",
            }}
          >
            <p
              style={{
                margin: "0 0 8px 0",
                fontWeight: 600,
                color: "var(--accent)",
                fontSize: "var(--text-body-size)",
              }}
            >
              {f.label}
            </p>
            <p
              style={{
                margin: 0,
                color: "var(--text-muted)",
                fontSize: "var(--text-caption-size)",
                lineHeight: "var(--text-caption-line)",
              }}
            >
              {f.desc}
            </p>
          </div>
        ))}
      </section>
    </main>
  );
}
