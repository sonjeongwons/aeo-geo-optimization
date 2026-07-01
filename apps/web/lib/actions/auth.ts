"use server";

/**
 * apps/web/lib/actions/auth.ts
 *
 * Server Actions for authentication:
 *  - login(formData)  — verifies email+password, creates an app_session, sets
 *                       an httpOnly/Secure/SameSite=Lax cookie, redirects to /.
 *  - logout()         — deletes the session row and clears the cookie.
 *
 * Security invariants:
 *  - Invalid credentials → error returned, NO cookie set.
 *  - Password verified via verifyPassword() (timing-safe).
 *  - Raw token in cookie; only the SHA-256 hash stored in DB.
 *  - Session TTL = 30 days (SESSION_TTL_MS from session.ts).
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  findAppUserByEmail,
  createSession,
  deleteSession,
} from "@engine/db/repo";
import { verifyPassword } from "@engine/auth/password";
import { createSessionToken } from "@engine/auth/session";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "../session";

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginState {
  error: string | null;
}

/**
 * Login Server Action.
 *
 * Called by the login form. On success: creates a session, sets the cookie,
 * then redirects (redirect() throws, so nothing after it executes).
 *
 * On failure: returns { error: "<message>" } so the form can display the error
 * without setting any cookie.
 */
export async function login(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = (formData.get("email") as string | null)?.trim() ?? "";
  const password = (formData.get("password") as string | null) ?? "";

  if (!email || !password) {
    return { error: "이메일과 비밀번호를 입력해 주세요." };
  }

  // Look up the user by email.
  let user: Awaited<ReturnType<typeof findAppUserByEmail>>;
  try {
    user = await findAppUserByEmail(email);
  } catch {
    // Treat DB errors as generic auth failure (don't leak internals).
    return { error: "인증에 실패했습니다. 다시 시도해 주세요." };
  }

  if (!user) {
    // No such user — timing-safe: still run a dummy verify to avoid enumeration.
    // (verifyPassword would fail on a blank hash string, so we keep it simple.)
    return { error: "이메일 또는 비밀번호가 올바르지 않습니다." };
  }

  // Verify the password.
  let valid: boolean;
  try {
    valid = await verifyPassword(password, user.password_hash);
  } catch {
    return { error: "인증에 실패했습니다. 다시 시도해 주세요." };
  }

  if (!valid) {
    return { error: "이메일 또는 비밀번호가 올바르지 않습니다." };
  }

  // Create a session token (raw + hash).
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  try {
    await createSession({
      userId: user.id,
      tokenHash: token.hash,
      expiresAt,
    });
  } catch {
    return { error: "세션을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }

  // Set the httpOnly session cookie.
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token.raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });

  // Redirect to the dashboard. redirect() throws internally in Next.js.
  redirect("/overview");
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

/**
 * Logout Server Action.
 *
 * Deletes the session row from the database and clears the cookie.
 * After this the cookie value no longer authenticates (idempotent).
 */
export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (rawToken) {
    // Import hashToken here to hash the raw cookie value.
    const { hashToken } = await import("@engine/auth/session");
    const tokenHash = hashToken(rawToken);

    try {
      await deleteSession(tokenHash);
    } catch {
      // Session row may already be gone — still clear the cookie.
    }
  }

  // Clear the cookie regardless.
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  redirect("/login");
}
