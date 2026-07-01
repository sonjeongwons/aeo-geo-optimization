/**
 * src/security/securityAudit.ts — hi-end audit MUST #6.
 *
 * Append-only, TAMPER-EVIDENT security audit log primitives (SOC2 CC7-style
 * control). Every security-relevant decision (report-token verification, auth
 * outcomes, insecure-config fallbacks) is recorded as an immutable row.
 *
 * Integrity model — a hash chain:
 *   row_hash = SHA256( prev_hash || canonical(event) )
 * Each row commits to the entire history before it, so deleting or editing ANY
 * past row breaks every subsequent row_hash. verifySecurityAuditChain() (repo)
 * re-walks the chain to detect tampering. The chain is the reason this log is
 * trustworthy evidence, not just a table someone with DB access could rewrite.
 *
 * This module is PURE (crypto only, no IO) so the integrity logic is unit-tested
 * without a database. The repo layer handles persistence + last-hash lookup.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Event model
// ---------------------------------------------------------------------------

export type SecurityAuditEventType =
  | "report_token_verify" // a /r/<token> permalink was checked
  | "report_token_forgery" // a permalink failed the HMAC (tamper / enumeration)
  | "auth_login" // a login attempt
  | "auth_logout"
  | "auth_failure" // bad password / unknown user
  | "session_invalid" // a presented session cookie did not resolve
  | "config_insecure_fallback"; // a security secret fell back to a dev default

export type SecurityAuditOutcome = "success" | "failure" | "denied";

/** Caller-supplied event (pre-persistence). */
export interface SecurityAuditInput {
  eventType: SecurityAuditEventType;
  outcome: SecurityAuditOutcome;
  /** The customer/subject id this event concerns, if known (NEVER a raw secret). */
  subjectId?: string | null;
  /** Source IP / client identifier, if available. */
  sourceIp?: string | null;
  /** Structured, non-sensitive detail. Secrets/tokens MUST be redacted first. */
  detail?: Record<string, unknown>;
}

/** Genesis hash for the first row in an empty chain. */
export const AUDIT_GENESIS_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

/** A fully-built, persistable audit record (minus DB-assigned ts/id). */
export interface SecurityAuditRecord {
  eventType: SecurityAuditEventType;
  outcome: SecurityAuditOutcome;
  subjectId: string | null;
  sourceIp: string | null;
  detail: Record<string, unknown>;
  prevHash: string;
  rowHash: string;
}

// ---------------------------------------------------------------------------
// Redaction — never let a secret/token reach the log verbatim
// ---------------------------------------------------------------------------

/**
 * Redact a token/secret for safe logging: keep a short non-sensitive prefix and
 * a salted-free SHA-256 fingerprint so identical tokens are correlatable without
 * the value being recoverable. Returns "" for empty input.
 */
export function redactToken(token: string | null | undefined): string {
  if (!token) return "";
  const fp = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
  const prefix = token.slice(0, 4);
  return `${prefix}…#${fp}`;
}

// ---------------------------------------------------------------------------
// Canonicalization + hashing
// ---------------------------------------------------------------------------

/** Deterministic JSON with sorted keys (stable across insertion order). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Canonical string an audit row commits to. Excludes ts/id (DB-assigned) so the
 * hash is reproducible at verification time from stored columns.
 */
export function canonicalizeAuditEvent(
  eventType: SecurityAuditEventType,
  outcome: SecurityAuditOutcome,
  subjectId: string | null,
  sourceIp: string | null,
  detail: Record<string, unknown>,
): string {
  return stableStringify({ eventType, outcome, subjectId, sourceIp, detail });
}

/** row_hash = SHA256( prevHash || "\n" || canonical ). */
export function computeAuditRowHash(prevHash: string, canonical: string): string {
  return createHash("sha256").update(`${prevHash}\n${canonical}`, "utf8").digest("hex");
}

/**
 * Build a persistable, hash-chained audit record from a caller event + the
 * previous row's hash. Pure — deterministic given (prevHash, input).
 */
export function buildAuditRecord(
  prevHash: string,
  input: SecurityAuditInput,
): SecurityAuditRecord {
  const subjectId = input.subjectId ?? null;
  const sourceIp = input.sourceIp ?? null;
  const detail = input.detail ?? {};
  const canonical = canonicalizeAuditEvent(
    input.eventType,
    input.outcome,
    subjectId,
    sourceIp,
    detail,
  );
  return {
    eventType: input.eventType,
    outcome: input.outcome,
    subjectId,
    sourceIp,
    detail,
    prevHash,
    rowHash: computeAuditRowHash(prevHash, canonical),
  };
}

// ---------------------------------------------------------------------------
// Chain verification (pure — repo feeds rows in ts ascending order)
// ---------------------------------------------------------------------------

export interface AuditChainRow {
  eventType: SecurityAuditEventType;
  outcome: SecurityAuditOutcome;
  subjectId: string | null;
  sourceIp: string | null;
  detail: Record<string, unknown>;
  prevHash: string;
  rowHash: string;
}

export interface ChainVerification {
  ok: boolean;
  /** Index of the first row that fails the chain, or -1 when intact. */
  brokenAtIndex: number;
  reason?: string;
}

/**
 * Re-walk an ordered (ts ascending) list of audit rows and confirm every
 * row_hash is consistent with the recomputed hash AND that prev_hash links to
 * the prior row. Detects edits, deletions, and reordering.
 */
export function verifyAuditChain(
  rows: AuditChainRow[],
  genesis: string = AUDIT_GENESIS_HASH,
): ChainVerification {
  let expectedPrev = genesis;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.prevHash !== expectedPrev) {
      return { ok: false, brokenAtIndex: i, reason: "prev_hash link mismatch" };
    }
    const canonical = canonicalizeAuditEvent(
      r.eventType,
      r.outcome,
      r.subjectId,
      r.sourceIp,
      r.detail,
    );
    const recomputed = computeAuditRowHash(r.prevHash, canonical);
    if (recomputed !== r.rowHash) {
      return { ok: false, brokenAtIndex: i, reason: "row_hash mismatch (row altered)" };
    }
    expectedPrev = r.rowHash;
  }
  return { ok: true, brokenAtIndex: -1 };
}
