"use client";

/**
 * apps/web/app/(app)/error.tsx
 *
 * W7.5 — Route-level error boundary for the authed dashboard group.
 * Catches render/data errors from a page and offers a retry, instead of a
 * blank screen. Kept minimal and dependency-free.
 */

import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the console for local debugging; server logs capture the rest.
    console.error(error);
  }, [error]);

  return (
    <div
      style={{
        padding: "var(--gutter)",
        maxWidth: "var(--content-max)",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      <h1
        style={{
          fontSize: "var(--text-h1-size)",
          fontWeight: "var(--text-h1-weight)",
          color: "var(--text)",
          margin: 0,
        }}
      >
        문제가 발생했습니다
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "var(--text-body-size)", margin: 0 }}>
        페이지를 불러오는 중 오류가 발생했습니다. 다시 시도해 주세요.
      </p>
      <div>
        <button type="button" className="btn-primary" onClick={() => reset()}>
          다시 시도
        </button>
      </div>
    </div>
  );
}
