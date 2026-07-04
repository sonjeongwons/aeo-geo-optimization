/**
 * apps/web/app/(app)/loading.tsx
 *
 * W7.5 — Route-level loading UI for the authed dashboard group.
 * Shown while a Server Component page streams. Minimal, matches the dark shell.
 */

export default function Loading() {
  return (
    <div
      style={{
        padding: "var(--gutter)",
        maxWidth: "var(--content-max)",
        margin: "0 auto",
        color: "var(--text-muted)",
        fontSize: "var(--text-body-size)",
      }}
      aria-busy="true"
      aria-live="polite"
    >
      불러오는 중…
    </div>
  );
}
