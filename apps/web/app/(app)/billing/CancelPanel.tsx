"use client";

/**
 * apps/web/app/(app)/billing/CancelPanel.tsx
 *
 * Client component: §1 "월단위·무약정 — 언제든 해지" cancellation panel.
 *
 * Shows the cancel-at-period-end action with a confirmation step.
 * Calls the cancelSubscription Server Action via a form action.
 *
 * §1 invariant: access ends at period_end (no immediate data loss).
 * §0 caveat is visible near the plan terms in the parent page.
 */

import { useState, useTransition } from "react";
import { cancelSubscription } from "../../../lib/actions/billing";

interface CancelPanelProps {
  /** ISO string for the current period end (subscription.current_period_end). */
  periodEnd: string;
}

export function CancelPanel({ periodEnd }: CancelPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const periodEndLabel = new Date(periodEnd).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  function handleCancel() {
    startTransition(async () => {
      const result = await cancelSubscription();
      if (result.ok) {
        setDone(true);
        setConfirming(false);
      } else {
        setError(result.error ?? "오류가 발생했습니다.");
      }
    });
  }

  if (done) {
    return (
      <section
        style={{
          padding: "20px 24px",
          border: "1px solid var(--warning)",
          borderRadius: "var(--radius-card)",
          backgroundColor: "rgba(251, 191, 36, 0.06)",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-body-size)",
            color: "var(--warning)",
          }}
        >
          해지가 예약되었습니다. {periodEndLabel}까지 서비스가 유지됩니다.
          기간 내 재활성화 문의: 영업팀에 연락하세요.
        </p>
      </section>
    );
  }

  return (
    <section
      style={{
        padding: "24px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        backgroundColor: "var(--bg-elev)",
      }}
    >
      <h2
        style={{
          fontSize: "var(--text-h2-size)",
          fontWeight: "var(--text-h2-weight)",
          margin: "0 0 8px 0",
          color: "var(--text)",
        }}
      >
        월단위 · 무약정
      </h2>
      <p
        style={{
          margin: "0 0 16px 0",
          fontSize: "var(--text-body-size)",
          color: "var(--text-muted)",
          lineHeight: "var(--text-body-line)",
        }}
      >
        언제든 해지 가능합니다. 해지 시 현재 청구 기간({periodEndLabel})
        종료 시까지 서비스가 유지되며, 즉시 중단되지 않습니다.
        데이터는 유지됩니다.
      </p>

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="btn-ghost"
          style={{ fontSize: "var(--text-body-size)" }}
        >
          구독 해지 예약
        </button>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            padding: "16px",
            border: "1px solid var(--warning)",
            borderRadius: "6px",
            backgroundColor: "rgba(251, 191, 36, 0.06)",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-body-size)",
              color: "var(--warning)",
            }}
          >
            확인: {periodEndLabel}에 구독이 종료됩니다. 계속하시겠습니까?
          </p>
          {error && (
            <p
              style={{
                margin: 0,
                fontSize: "var(--text-caption-size)",
                color: "var(--negative)",
              }}
            >
              {error}
            </p>
          )}
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              onClick={handleCancel}
              disabled={isPending}
              style={{
                padding: "8px 16px",
                backgroundColor: "var(--warning)",
                color: "#0B1020",
                border: "none",
                borderRadius: "var(--radius-btn)",
                fontWeight: 600,
                fontSize: "var(--text-body-size)",
                cursor: isPending ? "not-allowed" : "pointer",
                opacity: isPending ? 0.7 : 1,
              }}
            >
              {isPending ? "처리 중..." : "해지 확인"}
            </button>
            <button
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={isPending}
              className="btn-ghost"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
