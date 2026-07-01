"use client";

/**
 * apps/web/components/RowAction.tsx
 *
 * Client island for one ApprovalTable row's action button. Isolated so the
 * surrounding ApprovalTable can be a Server Component (which may receive
 * column `render` functions). The Server Action `onAction` is passed in from a
 * "use server" module (allowed to cross into a Client Component).
 */

import { useState, useTransition } from "react";

export interface RowActionResult {
  ok: boolean;
  error?: string;
}

export function RowAction({
  id,
  onAction,
  actionLabel,
  actionPendingLabel = "처리 중...",
}: {
  id: string;
  onAction: (id: string) => Promise<RowActionResult>;
  actionLabel: string;
  actionPendingLabel?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await onAction(id);
      if (result.ok) setDone(true);
      else setError(result.error ?? "오류가 발생했습니다.");
    });
  }

  if (done) {
    return (
      <span style={{ fontSize: "12px", color: "var(--positive)", fontWeight: 600 }}>완료</span>
    );
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
      <button
        onClick={run}
        disabled={isPending}
        style={{
          padding: "4px 12px",
          fontSize: "12px",
          fontWeight: 600,
          backgroundColor: "var(--accent)",
          color: "#0B1020",
          border: "none",
          borderRadius: "var(--radius-btn)",
          cursor: isPending ? "not-allowed" : "pointer",
          opacity: isPending ? 0.6 : 1,
          transition: "opacity 0.15s ease",
          whiteSpace: "nowrap",
        }}
      >
        {isPending ? actionPendingLabel : actionLabel}
      </button>
      {error && (
        <span style={{ fontSize: "var(--text-caption-size)", color: "var(--negative)", maxWidth: "180px" }}>
          {error}
        </span>
      )}
    </span>
  );
}
