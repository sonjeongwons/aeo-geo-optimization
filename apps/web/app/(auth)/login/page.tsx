"use client";

/**
 * apps/web/app/(auth)/login/page.tsx
 *
 * Email + password login page.
 *
 * Design: dark gpto token styling — --bg-elev card centered on --bg surface,
 * cyan primary button, no gradients/emoji.
 *
 * Flow:
 *  1. User submits email + password.
 *  2. Server Action `login` verifies credentials.
 *     - Valid: session created, cookie set, redirect to /.
 *     - Invalid: error message shown, no cookie set.
 *
 * This is a Client Component so we can use useActionState for the error state.
 * The actual credential check and cookie issuance happen in the Server Action.
 */

import { useActionState } from "react";
import { login } from "../../../lib/actions/auth";

const initialState = { error: null };

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState(login, initialState);

  return (
    <div style={styles.root}>
      <div style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <h1 style={styles.title}>AEO/GEO 대시보드</h1>
          <p style={styles.subtitle}>계정에 로그인하세요.</p>
        </div>

        {/* Error message */}
        {state.error && (
          <div style={styles.errorBox} role="alert">
            {state.error}
          </div>
        )}

        {/* Login form */}
        <form action={formAction} style={styles.form} noValidate>
          <div style={styles.fieldGroup}>
            <label htmlFor="email" style={styles.label}>
              이메일
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
              style={styles.input}
              disabled={isPending}
            />
          </div>

          <div style={styles.fieldGroup}>
            <label htmlFor="password" style={styles.label}>
              비밀번호
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="••••••••"
              style={styles.input}
              disabled={isPending}
            />
          </div>

          <button
            type="submit"
            disabled={isPending}
            style={{
              ...styles.button,
              ...(isPending ? styles.buttonDisabled : {}),
            }}
          >
            {isPending ? "로그인 중…" : "로그인"}
          </button>
        </form>

        {/* No-guarantee disclosure — §0 invariant */}
        <p style={styles.disclosure}>
          현 위치 진단입니다 — 노출을 보장하지 않습니다.
          <br />
          월단위 · 무약정 · 언제든 해지 가능.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles — dark gpto tokens
// (CSS variables not available in inline style objects; hard-coded to match
//  styles/tokens.css values so this file is self-contained and type-safe.)
// ---------------------------------------------------------------------------

const styles = {
  root: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0B1020", // --bg
    padding: "24px",
  },
  card: {
    width: "100%",
    maxWidth: "400px",
    backgroundColor: "#121A2E", // --bg-elev
    border: "1px solid #1E2A44", // --border
    borderRadius: "8px", // --radius-card
    padding: "32px",
  },
  header: {
    marginBottom: "24px",
  },
  title: {
    margin: "0 0 8px",
    fontSize: "24px", // --text-h1-size
    lineHeight: "32px",
    fontWeight: 600,
    color: "#E6EAF2", // --text
  },
  subtitle: {
    margin: 0,
    fontSize: "14px",
    lineHeight: "22px",
    color: "#93A0B8", // --text-muted
  },
  errorBox: {
    marginBottom: "16px",
    padding: "10px 14px",
    backgroundColor: "rgba(248, 113, 113, 0.10)", // --negative tinted
    border: "1px solid #F87171", // --negative
    borderRadius: "6px",
    color: "#F87171", // --negative
    fontSize: "14px",
    lineHeight: "22px",
  },
  form: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "16px",
  },
  fieldGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
  },
  label: {
    fontSize: "12px", // --text-caption-size
    lineHeight: "18px",
    fontWeight: 500,
    color: "#93A0B8", // --text-muted
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  },
  input: {
    width: "100%",
    padding: "9px 12px",
    backgroundColor: "#0B1020", // --bg (sunken)
    border: "1px solid #1E2A44", // --border
    borderRadius: "6px",
    color: "#E6EAF2", // --text
    fontSize: "14px",
    lineHeight: "22px",
    outline: "none",
    boxSizing: "border-box" as const,
    // Focus style applied via global CSS; inline can't do :focus, so we rely on
    // the browser default ring (acceptable for this minimal form).
  },
  button: {
    marginTop: "8px",
    padding: "10px 16px",
    backgroundColor: "#22D3EE", // --accent
    color: "#0B1020", // dark text on cyan for contrast
    border: "none",
    borderRadius: "6px", // --radius-btn
    fontSize: "14px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "background-color 0.15s ease",
    width: "100%",
  },
  buttonDisabled: {
    backgroundColor: "#93A0B8", // --text-muted (dimmed while loading)
    cursor: "not-allowed",
  },
  disclosure: {
    marginTop: "24px",
    fontSize: "11px",
    lineHeight: "18px",
    color: "#93A0B8", // --text-muted
    textAlign: "center" as const,
  },
} as const;
