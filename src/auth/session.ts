/**
 * src/auth/session.ts
 *
 * Engine-side opaque session token primitives.
 *
 * Design:
 *  - `createSessionToken()` generates 32 cryptographically random bytes encoded
 *    as base64url (URL-safe, no padding).  This is the raw token placed in the
 *    httpOnly cookie — it is NEVER stored in the database.
 *  - `hashToken(rawToken)` returns the stable SHA-256 hex digest of the raw
 *    token.  This hash is what is stored in `app_session.token_hash`.
 *  - On each request the web layer calls `hashToken(cookieValue)` and looks up
 *    the resulting hash in the database.  If it matches a non-expired row the
 *    session is valid.
 *
 * No IO is performed here — all database reads/writes are handled by the repo
 * layer (findSession / createSession).  Pure functions; pure of Next.js.
 */

import { randomBytes, createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of random bytes for the opaque token (256-bit entropy). */
const TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionToken {
  /** The raw opaque token — place in the httpOnly cookie; never store. */
  raw: string;
  /** SHA-256 hex digest of the raw token — store in app_session.token_hash. */
  hash: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new opaque session token.
 *
 * Returns both the raw token (for the cookie) and its SHA-256 hash (for the
 * database).  The raw token is never stored anywhere; only the hash is
 * persisted.
 *
 * @returns `{ raw, hash }` — store `hash` in the DB, send `raw` in the cookie.
 */
export function createSessionToken(): SessionToken {
  const bytes = randomBytes(TOKEN_BYTES);
  const raw = bytes.toString('base64url');
  const hash = hashToken(raw);
  return { raw, hash };
}

/**
 * Compute the stable SHA-256 hex digest of a raw session token.
 *
 * Used on every authenticated request: hash the cookie value and look it up in
 * `app_session.token_hash`.  Deterministic and fast — no salt needed here
 * because the raw token itself has 256 bits of entropy (a salt on top of a
 * sufficiently-random nonce adds no meaningful security).
 *
 * @param rawToken - The opaque base64url token from the cookie.
 * @returns SHA-256 hex digest (64 hex characters).
 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}
