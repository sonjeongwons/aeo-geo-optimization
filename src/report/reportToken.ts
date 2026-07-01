/**
 * src/report/reportToken.ts
 *
 * Engine-side report permalink token generator (RI-02).
 *
 * Mirrors the token FORMAT from apps/web/lib/actions/reportToken.ts so that
 * tokens generated here are verifiable by the web app's verifyReportToken().
 * Both sides read the same REPORT_TOKEN_SECRET env var — the secret is never
 * duplicated or hard-coded here.
 *
 * This module ONLY exports generateReportToken (the generation half).
 * Token verification lives in apps/web because it requires a DB round-trip to
 * look up the snapshot's customer_id, and the web app owns that route.
 *
 * Token format: `${snapshotId}.${hmacSha256Hex(snapshotId:customerId, secret)}`
 * — identical to apps/web/lib/actions/reportToken.ts — no dots inside snapshotId
 * (UUID) or the mac (hex), so splitting on the first dot is unambiguous.
 */

import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

const DEV_FALLBACK_SECRET = 'dev-only-insecure-report-token-secret-32x';

function getSecret(): string {
  const secret = process.env['REPORT_TOKEN_SECRET'];
  if (secret) {
    // Hi-end audit MUST #5: reject a too-weak HMAC key (permalink-forgery / report IDOR).
    if (secret.length < 32) {
      throw new Error('REPORT_TOKEN_SECRET must be at least 32 characters.');
    }
    return secret;
  }
  // FAIL-CLOSED by default: the dev fallback is allowed ONLY when explicitly
  // opted in (ALLOW_DEV_REPORT_SECRET=true) or under the test runner. A
  // misclassified env (NODE_ENV unset/'staging') or a deploy that forgets the
  // var now THROWS instead of silently downgrading to a public HMAC key.
  const allowDev =
    process.env['ALLOW_DEV_REPORT_SECRET'] === 'true' ||
    process.env['NODE_ENV'] === 'test';
  if (allowDev) {
    console.warn(
      '[reportToken] REPORT_TOKEN_SECRET is not set — using INSECURE dev fallback ' +
        '(ALLOW_DEV_REPORT_SECRET / test only). NEVER use this for real report links.',
    );
    return DEV_FALLBACK_SECRET;
  }
  throw new Error(
    'REPORT_TOKEN_SECRET environment variable is required. ' +
      'Set a >=32-char secret, or ALLOW_DEV_REPORT_SECRET=true for local dev.',
  );
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Generate a signed permalink token for a report_snapshot.
 *
 * The resulting token is embeddable in a URL as `/r/${token}`.
 * It is verifiable by apps/web/lib/actions/reportToken.ts verifyReportToken()
 * because both use the same HMAC key and format.
 *
 * @param snapshotId - The report_snapshot.id UUID.
 * @param customerId - The owning customer's UUID (bound into the mac).
 * @returns URL-safe token string: `${snapshotId}.${mac}`.
 */
export function generateReportToken(snapshotId: string, customerId: string): string {
  const secret = getSecret();
  const mac = createHmac('sha256', secret)
    .update(`${snapshotId}:${customerId}`)
    .digest('hex');
  return `${snapshotId}.${mac}`;
}
