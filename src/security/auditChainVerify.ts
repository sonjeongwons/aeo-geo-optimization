/**
 * src/security/auditChainVerify.ts — W6: pure verifier + external-anchor helper
 * for the hash-chained security_audit log.
 *
 * PURPOSE
 * -------
 * The in-DB hash chain (implemented by the existing writer in
 * src/security/securityAudit.ts) makes tampering detectable: editing or
 * deleting any row breaks every subsequent row_hash.  However, a sufficiently
 * privileged attacker who can rewrite BOTH the data rows AND the chain hashes
 * in a single transaction can produce a self-consistent but falsified chain
 * that would pass the in-process verifier.
 *
 * An external anchor — a {seq, hash} pair published to an APPEND-ONLY,
 * out-of-band sink (e.g. a public write-once ledger, a separately-controlled
 * object-store, or an external audit service) — closes that gap: the attacker
 * would also need to rewrite the external sink, which is hard or impossible
 * by design.
 *
 * This module is the PURE (no IO, no network, no DB) verifier and anchor
 * computation.  The scheduled verifier job that reads rows from the DB, calls
 * verifyChain(), and the external sink publishing (computeHeadAnchor + write)
 * are DEFERRED integration work.
 *
 * HASH SCHEME
 * -----------
 * IMPORTANT: The existing writer (src/security/securityAudit.ts,
 * computeAuditRowHash) does NOT include a sequence number in its hash input;
 * it uses:
 *
 *   row_hash = SHA256( prevHash + "\n" + canonicalizeAuditEvent(...) )
 *
 * The W6 AuditEntry interface introduced here is a seq-aware abstraction
 * layer that sits ABOVE the raw event fields.  The caller is responsible for
 * providing a pre-computed payloadHash (SHA-256 hex of the row's canonical
 * payload — i.e. SHA256(canonicalizeAuditEvent(...)) in UTF-8) and for
 * populating seq.  This module does NOT define payload serialisation.
 *
 * Canonical entry hash format (this module):
 *
 *   entryHash = SHA256( `${seq}\n${prevHash}\n${payloadHash}` )  [UTF-8]
 *
 * The genesis entry (seq 0) uses prevHash = "" (empty string).
 *
 * Writers MUST use the same format if they want this verifier to accept their
 * entries.  If the existing DB writer (securityAudit.ts) is adapted to feed
 * this verifier, it must expose seq and pre-compute payloadHash using
 * SHA256(canonicalizeAuditEvent(...)) and chain with prevHash="" for the very
 * first row.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * A single entry in the hash-chained audit log, as seen by this verifier.
 * The caller is responsible for populating these fields from the DB row.
 */
export interface AuditEntry {
  /** 0-based, contiguous, ascending sequence number. */
  seq: number;
  /** Hash of the previous entry; "" for the genesis entry (seq 0). */
  prevHash: string;
  /** SHA-256 hex of this row's canonical payload (caller-supplied). */
  payloadHash: string;
  /** Stored hash of this entry — what the writer persisted. */
  hash: string;
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the expected hash for an audit entry.
 *
 * Format: SHA256( `${seq}\n${prevHash}\n${payloadHash}` ) encoded as UTF-8.
 * The genesis entry (seq 0) passes prevHash = "".
 */
export function computeEntryHash(
  seq: number,
  prevHash: string,
  payloadHash: string,
): string {
  const input = `${seq}\n${prevHash}\n${payloadHash}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

export interface ChainVerification {
  /** true only when the entire chain is intact and self-consistent. */
  valid: boolean;
  /**
   * seq of the first broken entry, or null when valid.
   * Never report null when valid is false — be honest.
   */
  brokenAt: number | null;
  /**
   * Human-readable description of the result.
   * "ok" when valid, specific reason when not.
   */
  reason: string;
  /** Total number of entries examined. */
  length: number;
  /** Hash of the last entry; null when the chain is empty. */
  headHash: string | null;
}

/**
 * Verify a complete hash chain.
 *
 * The entries MUST be provided in ascending seq order.  This function
 * reports the FIRST inconsistency found and stops — it never "best-effort
 * passes" a broken chain.
 *
 * Checks performed in order for each entry:
 *   (a) seq contiguity: entries[i].seq === entries[0].seq + i
 *   (b) prevHash link:  entries[0].prevHash may be anything (caller's genesis);
 *                       entries[i].prevHash === entries[i-1].hash for i > 0
 *   (c) hash integrity: entries[i].hash === computeEntryHash(seq, prevHash, payloadHash)
 *
 * Empty chain → valid:true, reason:"empty chain", headHash:null.
 */
export function verifyChain(entries: readonly AuditEntry[]): ChainVerification {
  if (entries.length === 0) {
    return {
      valid: true,
      brokenAt: null,
      reason: "empty chain",
      length: 0,
      headHash: null,
    };
  }

  const baseSeq = entries[0]!.seq;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    // (a) Contiguity check.
    const expectedSeq = baseSeq + i;
    if (entry.seq !== expectedSeq) {
      return {
        valid: false,
        brokenAt: entry.seq,
        reason: `seq discontinuity: expected ${expectedSeq}, got ${entry.seq}`,
        length: entries.length,
        headHash: entries[entries.length - 1]!.hash,
      };
    }

    // (b) prevHash link check (only for entries after the first).
    if (i > 0) {
      const prevEntry = entries[i - 1]!;
      if (entry.prevHash !== prevEntry.hash) {
        return {
          valid: false,
          brokenAt: entry.seq,
          reason: `prevHash link broken at seq ${entry.seq}: stored prevHash does not match previous entry's hash`,
          length: entries.length,
          headHash: entries[entries.length - 1]!.hash,
        };
      }
    }

    // (c) Hash integrity check.
    const recomputed = computeEntryHash(entry.seq, entry.prevHash, entry.payloadHash);
    if (recomputed !== entry.hash) {
      return {
        valid: false,
        brokenAt: entry.seq,
        reason: `hash mismatch at seq ${entry.seq}: stored hash does not match recomputed hash (entry altered or payloadHash wrong)`,
        length: entries.length,
        headHash: entries[entries.length - 1]!.hash,
      };
    }
  }

  return {
    valid: true,
    brokenAt: null,
    reason: "ok",
    length: entries.length,
    headHash: entries[entries.length - 1]!.hash,
  };
}

// ---------------------------------------------------------------------------
// External anchor
// ---------------------------------------------------------------------------

/**
 * A snapshot of the chain head, suitable for publishing to an append-only
 * external sink (e.g. a public ledger or separately-controlled object store).
 *
 * Publishing this periodically closes the gap left by the in-DB chain alone:
 * an attacker who rewrites both the data and the chain must also rewrite the
 * external sink, which is hard or impossible by design.
 */
export interface ExternalAnchor {
  /** seq of the chain head at publish time. */
  seq: number;
  /** hash of the chain head at publish time. */
  hash: string;
}

/**
 * Return an ExternalAnchor for the current chain head, or null when the chain
 * is empty.  Call this after verifyChain() passes to ensure the anchor
 * reflects an intact chain.
 */
export function computeHeadAnchor(
  entries: readonly AuditEntry[],
): ExternalAnchor | null {
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1]!;
  return { seq: last.seq, hash: last.hash };
}

// ---------------------------------------------------------------------------
// Truncation / rewrite detection
// ---------------------------------------------------------------------------

export interface TruncationCheck {
  /** true only when the anchored entry is present and its hash matches. */
  ok: boolean;
  /** Honest description of the outcome. "ok" when ok is true. */
  reason: string;
}

/**
 * Detect truncation or rewrite by comparing the live chain against a
 * previously published external anchor.
 *
 * Rules:
 *   - If no entry with anchor.seq exists in entries → "truncated: entry at
 *     seq <n> is missing".
 *   - If the entry exists but its hash differs from anchor.hash → "rewritten:
 *     hash at seq <n> does not match anchor".
 *   - Otherwise → ok:true, reason:"ok".
 *
 * Note: entries need not be sorted; this function searches by seq.
 */
export function detectTruncation(
  entries: readonly AuditEntry[],
  anchor: ExternalAnchor,
): TruncationCheck {
  const found = entries.find((e) => e.seq === anchor.seq);

  if (found === undefined) {
    return {
      ok: false,
      reason: `truncated: entry at seq ${anchor.seq} is missing from the live chain`,
    };
  }

  if (found.hash !== anchor.hash) {
    return {
      ok: false,
      reason: `rewritten: hash at seq ${anchor.seq} is "${found.hash}" but anchor recorded "${anchor.hash}"`,
    };
  }

  return { ok: true, reason: "ok" };
}
