/**
 * apps/web/lib/actions/reportToken.ts
 *
 * Signed weekly-report permalink tokens (P5-T16).
 *
 * Design:
 *  A token encodes the snapshotId and a HMAC-SHA256 mac over
 *  `${snapshotId}:${customerId}` keyed by REPORT_TOKEN_SECRET.
 *  The full token is `${snapshotId}.${mac}` URL-safe base64-encoded.
 *
 *  Token properties:
 *  - Non-enumerable: without the HMAC secret, iterating snapshotIds does not
 *    yield valid tokens.
 *  - Bound to one snapshot + customer: the mac covers both ids.
 *  - Verifiable server-side without a DB round-trip for the mac check; however
 *    we still look up the snapshot to confirm it exists and return the data.
 *  - 404 on tamper: any bit-flip in snapshotId or mac produces a mismatch.
 *
 * This module is server-only by usage (imported only from Server Components /
 * Route Handlers). It does NOT import "server-only" directly because it exports
 * a plain helper also used by deliver.ts (engine side). The absence of any
 * Next.js import keeps it importable from both contexts.
 *
 * Environment:
 *  REPORT_TOKEN_SECRET — min 32-char secret; must be set in production.
 *  Falls back to a hard-coded dev-only sentinel that generates a warning.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_FALLBACK_SECRET = "dev-only-insecure-report-token-secret-32x";

/**
 * Read the HMAC signing secret from the environment.
 * Logs a warning in dev if the fallback is in use.
 */
function getSecret(): string {
  const secret = process.env["REPORT_TOKEN_SECRET"];
  if (secret) {
    // Hi-end audit MUST #5: reject a too-weak HMAC key (permalink-forgery / report IDOR).
    if (secret.length < 32) {
      throw new Error("REPORT_TOKEN_SECRET must be at least 32 characters.");
    }
    return secret;
  }
  // FAIL-CLOSED: dev fallback only when explicitly opted in or under tests — a
  // forgotten secret can no longer silently downgrade to a public HMAC key.
  const allowDev =
    process.env["ALLOW_DEV_REPORT_SECRET"] === "true" ||
    process.env["NODE_ENV"] === "test";
  if (allowDev) {
    console.warn(
      "[reportToken] REPORT_TOKEN_SECRET is not set — using INSECURE dev fallback " +
        "(ALLOW_DEV_REPORT_SECRET / test only). NEVER use this for real report links.",
    );
    return DEV_FALLBACK_SECRET;
  }
  throw new Error(
    "REPORT_TOKEN_SECRET environment variable is required. " +
      "Set a >=32-char secret, or ALLOW_DEV_REPORT_SECRET=true for local dev.",
  );
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Generate a signed permalink token for a report_snapshot.
 *
 * The token encodes `snapshotId.mac` where mac = HMAC-SHA256(
 *   `${snapshotId}:${customerId}`, REPORT_TOKEN_SECRET
 * ), hex-encoded.
 *
 * The caller (deliver.ts / email template) embeds this in the permalink URL:
 *   `/r/${token}`
 *
 * @param snapshotId - The report_snapshot.id UUID.
 * @param customerId - The owning customer's UUID (included in mac for binding).
 * @returns The URL-safe permalink token string.
 */
export function generateReportToken(
  snapshotId: string,
  customerId: string,
): string {
  const secret = getSecret();
  const mac = createHmac("sha256", secret)
    .update(`${snapshotId}:${customerId}`)
    .digest("hex");
  // Combine as `snapshotId.mac` — both components are hex/UUID (no dots inside).
  return `${snapshotId}.${mac}`;
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

export interface VerifiedToken {
  /** The verified snapshotId extracted from the token. */
  snapshotId: string;
}

/**
 * Outcome reason codes emitted by verifyReportToken (MUST #6 audit hook).
 * - 'ok'                → token verified (a legitimate snapshot access)
 * - 'malformed'         → shape/length checks failed (bots/garbage — not audited)
 * - 'snapshot_missing'  → well-formed but no such snapshot
 * - 'mac_mismatch'      → well-formed + snapshot exists but HMAC failed (FORGERY)
 */
export type ReportTokenVerifyReason =
  | "ok"
  | "malformed"
  | "snapshot_missing"
  | "mac_mismatch";

export interface VerifyReportTokenOpts {
  /** Optional audit hook — called exactly once with the outcome + snapshotId (if parseable). */
  onEvent?: (reason: ReportTokenVerifyReason, snapshotId: string | null) => void;
}

/**
 * Verify a signed permalink token.
 *
 * Steps:
 *  1. Split `token` on the first `.` to extract `snapshotId` + `mac`.
 *  2. Fetch the report_snapshot row by `snapshotId` (to get `customerId`).
 *  3. Recompute the expected mac over `${snapshotId}:${customerId}`.
 *  4. Compare using timing-safe equal.
 *  5. Return { snapshotId } on success; null on any failure.
 *
 * FAIL-CLOSED: any missing field, DB miss, or mac mismatch returns null.
 * The page translates null → notFound() (404), never 403.
 *
 * @param token - The raw token string from the URL param.
 * @param getSnapshot - Injectable snapshot loader (defaults to the engine repo fn).
 * @returns { snapshotId } on valid token, or null.
 */
export async function verifyReportToken(
  token: string,
  getSnapshot: (id: string) => Promise<{ id: string; customer_id: string } | null>,
  opts?: VerifyReportTokenOpts,
): Promise<VerifiedToken | null> {
  const emit = (reason: ReportTokenVerifyReason, snapshotId: string | null) => {
    try {
      opts?.onEvent?.(reason, snapshotId);
    } catch {
      /* audit must never break the request path */
    }
  };

  if (!token || typeof token !== "string") {
    emit("malformed", null);
    return null;
  }

  // 1. Split on first `.` — snapshotId is a UUID (no dots), mac is hex (no dots).
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) {
    emit("malformed", null);
    return null;
  }

  const snapshotId = token.slice(0, dotIndex);
  const providedMac = token.slice(dotIndex + 1);

  // Basic UUID shape guard (36 chars: 8-4-4-4-12).
  if (snapshotId.length !== 36) {
    emit("malformed", null);
    return null;
  }
  // HMAC-SHA256 hex is 64 chars.
  if (providedMac.length !== 64) {
    emit("malformed", snapshotId);
    return null;
  }

  // 2. Fetch the snapshot to get the customerId.
  let snapshot: { id: string; customer_id: string } | null;
  try {
    snapshot = await getSnapshot(snapshotId);
  } catch {
    emit("snapshot_missing", snapshotId);
    return null;
  }
  if (!snapshot) {
    emit("snapshot_missing", snapshotId);
    return null;
  }

  // 3. Recompute the expected mac.
  const secret = getSecret();
  const expectedMac = createHmac("sha256", secret)
    .update(`${snapshotId}:${snapshot.customer_id}`)
    .digest("hex");

  // 4. Timing-safe comparison (prevents mac oracle attacks).
  try {
    const providedBuf = Buffer.from(providedMac, "hex");
    const expectedBuf = Buffer.from(expectedMac, "hex");
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      // Well-formed token + real snapshot but bad mac = a forgery / enumeration probe.
      emit("mac_mismatch", snapshotId);
      return null;
    }
  } catch {
    emit("mac_mismatch", snapshotId);
    return null;
  }

  // 5. Valid token.
  emit("ok", snapshotId);
  return { snapshotId };
}
