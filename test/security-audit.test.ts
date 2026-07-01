/** test/security-audit.test.ts — hi-end audit MUST #6 tamper-evident chain. */
import { describe, it, expect } from "vitest";
import {
  AUDIT_GENESIS_HASH,
  buildAuditRecord,
  verifyAuditChain,
  redactToken,
  computeAuditRowHash,
  canonicalizeAuditEvent,
  type SecurityAuditInput,
  type AuditChainRow,
} from "../src/security/securityAudit.js";

function chainFrom(inputs: SecurityAuditInput[]): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev = AUDIT_GENESIS_HASH;
  for (const inp of inputs) {
    const rec = buildAuditRecord(prev, inp);
    rows.push({
      eventType: rec.eventType,
      outcome: rec.outcome,
      subjectId: rec.subjectId,
      sourceIp: rec.sourceIp,
      detail: rec.detail,
      prevHash: rec.prevHash,
      rowHash: rec.rowHash,
    });
    prev = rec.rowHash;
  }
  return rows;
}

const SAMPLE: SecurityAuditInput[] = [
  { eventType: "report_token_verify", outcome: "success", subjectId: "c1", detail: { a: 1 } },
  { eventType: "report_token_forgery", outcome: "denied", detail: { snapshotId: "s2" } },
  { eventType: "auth_login", outcome: "failure", sourceIp: "1.2.3.4" },
];

describe("hash chain integrity (MUST #6)", () => {
  it("a freshly-built chain verifies ok", () => {
    const rows = chainFrom(SAMPLE);
    const v = verifyAuditChain(rows);
    expect(v.ok).toBe(true);
    expect(v.brokenAtIndex).toBe(-1);
  });

  it("first row chains onto the genesis hash", () => {
    const rows = chainFrom(SAMPLE);
    expect(rows[0]!.prevHash).toBe(AUDIT_GENESIS_HASH);
  });

  it("each row's prevHash equals the previous row's rowHash", () => {
    const rows = chainFrom(SAMPLE);
    expect(rows[1]!.prevHash).toBe(rows[0]!.rowHash);
    expect(rows[2]!.prevHash).toBe(rows[1]!.rowHash);
  });

  it("EDITING a past row is detected (row_hash mismatch)", () => {
    const rows = chainFrom(SAMPLE);
    // Tamper: flip the outcome of row 0 without recomputing hashes.
    rows[0] = { ...rows[0]!, outcome: "denied" };
    const v = verifyAuditChain(rows);
    expect(v.ok).toBe(false);
    expect(v.brokenAtIndex).toBe(0);
  });

  it("DELETING a row breaks the chain link", () => {
    const rows = chainFrom(SAMPLE);
    const truncated = [rows[0]!, rows[2]!]; // drop the middle row
    const v = verifyAuditChain(truncated);
    expect(v.ok).toBe(false);
    expect(v.brokenAtIndex).toBe(1);
  });

  it("REORDERING rows breaks the chain", () => {
    const rows = chainFrom(SAMPLE);
    const reordered = [rows[1]!, rows[0]!, rows[2]!];
    const v = verifyAuditChain(reordered);
    expect(v.ok).toBe(false);
  });

  it("an empty chain is trivially ok", () => {
    expect(verifyAuditChain([]).ok).toBe(true);
  });
});

describe("canonicalization + hashing", () => {
  it("is deterministic regardless of detail key order", () => {
    const a = canonicalizeAuditEvent("auth_login", "success", "c1", null, { x: 1, y: 2 });
    const b = canonicalizeAuditEvent("auth_login", "success", "c1", null, { y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("computeAuditRowHash returns a 64-char hex digest", () => {
    const h = computeAuditRowHash(AUDIT_GENESIS_HASH, "x");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("redactToken", () => {
  it("never returns the raw token and is non-reversible-looking", () => {
    const raw = "abcd1234.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const red = redactToken(raw);
    expect(red).not.toContain("deadbeef");
    expect(red.startsWith("abcd")).toBe(true);
    expect(red).toContain("#");
  });

  it("returns empty string for empty input", () => {
    expect(redactToken("")).toBe("");
    expect(redactToken(null)).toBe("");
  });

  it("same token → same fingerprint (correlatable)", () => {
    expect(redactToken("tok-123")).toBe(redactToken("tok-123"));
  });
});
