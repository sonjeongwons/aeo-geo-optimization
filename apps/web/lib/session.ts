/**
 * apps/web/lib/session.ts
 *
 * Web session layer — fail-closed, server-only.
 *
 * Flow per request:
 *   1. Read the httpOnly session cookie.
 *   2. Hash the raw token via hashToken() (engine auth primitive).
 *   3. Look up the hash in app_session via findSession() (checks expiry).
 *   4. Load the app_user row to get customer_id + role.
 *   5. Return { userId, customerId, role }.
 *
 * Security invariants:
 *  - customerId is NEVER read from a client-supplied param — only from the DB row.
 *  - No session → redirect to /login (or return null for non-redirect callers).
 *  - Non-staff user with NULL customer_id → 403 (should never happen due to DB CHECK,
 *    but we fail-closed defensively).
 *  - Staff users (role='staff', customer_id NULL) → allowed through requireStaff(),
 *    blocked by requireCustomerScope() (returns 403).
 *
 * This module may import engine.server.ts because it is a server-only module itself.
 * It must NOT be imported from any 'use client' file.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hashToken } from "@engine/auth/session";
import { findSession } from "@engine/db/repo";

// ---------------------------------------------------------------------------
// Cookie constants
// ---------------------------------------------------------------------------

export const SESSION_COOKIE_NAME = "aeo_session";

/** Session lifetime: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerSession {
  userId: string;
  /** null only for staff users (role='staff'). Non-staff users always have a customerId. */
  customerId: string | null;
  role: "owner" | "member" | "staff";
  /** The raw token from the cookie (needed for logout/deleteSession). */
  tokenHash: string;
  /** The user's email address. */
  email: string;
}

// ---------------------------------------------------------------------------
// getServerSession
// ---------------------------------------------------------------------------

/**
 * Resolve the session from the httpOnly cookie.
 *
 * Returns null when:
 *  - The cookie is absent or empty.
 *  - The token hash does not match any non-expired app_session row.
 *  - The app_user row cannot be found (row deleted after session created).
 *
 * Does NOT redirect — callers that need a redirect use requireCustomerScope()
 * or requireStaff() instead.
 */
export async function getServerSession(): Promise<ServerSession | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const session = await findSession(tokenHash);
  if (!session) return null;

  // Load the user row to get customer_id and role.
  // findAppUserByEmail takes email — but we have user_id from the session.
  // We use a direct lookup by user_id via the engine repo.
  const user = await findAppUserById(session.user_id);
  if (!user) return null;

  return {
    userId: user.id,
    customerId: user.customer_id,
    role: user.role,
    tokenHash,
    email: user.email,
  };
}

// ---------------------------------------------------------------------------
// requireCustomerScope
// ---------------------------------------------------------------------------

/**
 * Resolve the session and return the customerId.
 *
 * - No session → redirects to /login.
 * - Session found but customerId is NULL (e.g. staff user) → throws a 403
 *   response (staff must use requireStaff() instead).
 * - Session found with a valid customerId → returns the customerId.
 *
 * The returned customerId is safe to pass into any scoped repo function.
 * It is NEVER sourced from a client-supplied param.
 */
export async function requireCustomerScope(): Promise<string> {
  const session = await getServerSession();

  if (!session) {
    redirect("/login");
  }

  if (session.customerId === null) {
    // Staff user trying to access a per-customer route. Fail-closed: 403.
    throw new ScopeError(
      "Staff accounts do not have a customer scope. Use a customer account to access this page.",
      403,
    );
  }

  return session.customerId;
}

/**
 * Like requireCustomerScope but also returns the full session (e.g. for getting
 * the user email to stamp as approver identity for §12 audit).
 */
export async function requireCustomerScopeWithSession(): Promise<{
  customerId: string;
  session: ServerSession;
}> {
  const session = await getServerSession();

  if (!session) {
    redirect("/login");
  }

  if (session.customerId === null) {
    throw new ScopeError(
      "Staff accounts do not have a customer scope. Use a customer account to access this page.",
      403,
    );
  }

  return { customerId: session.customerId, session };
}

// ---------------------------------------------------------------------------
// requireStaff
// ---------------------------------------------------------------------------

/**
 * Resolve the session and verify the user has role='staff'.
 *
 * - No session → redirects to /login.
 * - Session found but role != 'staff' → throws a 403 response.
 * - Session found with role='staff' → returns the full session.
 *
 * The (staff) console calls this on every page/action.
 */
export async function requireStaff(): Promise<ServerSession> {
  const session = await getServerSession();

  if (!session) {
    redirect("/login");
  }

  if (session.role !== "staff") {
    throw new ScopeError(
      "This area is restricted to staff accounts.",
      403,
    );
  }

  return session;
}

// ---------------------------------------------------------------------------
// ScopeError
// ---------------------------------------------------------------------------

/**
 * Error thrown by requireCustomerScope / requireStaff when the session is valid
 * but the caller lacks the required scope.
 *
 * Route Handlers should catch this and return the appropriate HTTP status.
 * Server Actions should catch this and return an error state.
 * Server Components typically let this propagate to Next.js error boundaries.
 */
export class ScopeError extends Error {
  readonly status: 403;

  constructor(message: string, status: 403) {
    super(message);
    this.name = "ScopeError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Look up an app_user row by id.
 *
 * We need a by-id lookup here (session row carries user_id, not email).
 * This is the only place in the web layer that performs a raw repo read that
 * isn't already exported from engine.server.ts — it is internal to session.ts.
 */
async function findAppUserById(userId: string): Promise<{
  id: string;
  email: string;
  customer_id: string | null;
  role: "owner" | "member" | "staff";
} | null> {
  // We import repo directly here (this file is server-only by construction —
  // it imports next/headers which is a server-only API).
  // Using a dynamic import avoids a circular dependency with engine.server.ts.
  const { getDb } = await import("@engine/db/kysely");
  const db = getDb();

  const row = await db
    .selectFrom("app_user")
    .select(["id", "email", "customer_id", "role"])
    .where("id", "=", userId)
    .executeTakeFirst();

  return row ?? null;
}
