/**
 * test/auditChainVerify.test.ts — W6: pure verifier + external-anchor helper.
 *
 * Tests for src/security/auditChainVerify.ts.
 * All tests are pure / deterministic — no DB, no network.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  computeEntryHash,
  verifyChain,
  computeHeadAnchor,
  detectTruncation,
  type AuditEntry,
  type ExternalAnchor,
} from "../src/security/auditChainVerify.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex of a string — mirrors the canonical payloadHash derivation. */
function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Build a valid N-entry chain starting at seq=0 with prevHash="".
 * payloads[i] is the payload string for entry i; its hash is computed here.
 */
function buildChain(payloads: string[]): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prevHash = "";

  for (let i = 0; i < payloads.length; i++) {
    const seq = i;
    const payloadHash = sha256(payloads[i]!);
    const hash = computeEntryHash(seq, prevHash, payloadHash);
    entries.push({ seq, prevHash, payloadHash, hash });
    prevHash = hash;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// computeEntryHash — determinism
// ---------------------------------------------------------------------------

describe("computeEntryHash", () => {
  it("returns a 64-char lowercase hex string", () => {
    const h = computeEntryHash(0, "", sha256("payload"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same inputs always produce same output", () => {
    const ph = sha256("some payload");
    const h1 = computeEntryHash(5, "abc123", ph);
    const h2 = computeEntryHash(5, "abc123", ph);
    expect(h1).toBe(h2);
  });

  it("changes when seq changes", () => {
    const ph = sha256("payload");
    expect(computeEntryHash(0, "prev", ph)).not.toBe(computeEntryHash(1, "prev", ph));
  });

  it("changes when prevHash changes", () => {
    const ph = sha256("payload");
    expect(computeEntryHash(0, "aaa", ph)).not.toBe(computeEntryHash(0, "bbb", ph));
  });

  it("changes when payloadHash changes", () => {
    const ph1 = sha256("payload-a");
    const ph2 = sha256("payload-b");
    expect(computeEntryHash(0, "", ph1)).not.toBe(computeEntryHash(0, "", ph2));
  });
});

// ---------------------------------------------------------------------------
// verifyChain — empty chain
// ---------------------------------------------------------------------------

describe("verifyChain — empty chain", () => {
  it("valid:true, brokenAt:null, reason:'empty chain', length:0, headHash:null", () => {
    const result = verifyChain([]);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeNull();
    expect(result.reason).toBe("empty chain");
    expect(result.length).toBe(0);
    expect(result.headHash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyChain — valid chains
// ---------------------------------------------------------------------------

describe("verifyChain — valid chains", () => {
  it("a valid 3-entry chain passes", () => {
    const entries = buildChain(["event-a", "event-b", "event-c"]);
    const result = verifyChain(entries);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeNull();
    expect(result.reason).toBe("ok");
    expect(result.length).toBe(3);
    expect(result.headHash).toBe(entries[2]!.hash);
  });

  it("a valid 1-entry chain passes", () => {
    const entries = buildChain(["solo"]);
    const result = verifyChain(entries);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.length).toBe(1);
    expect(result.headHash).toBe(entries[0]!.hash);
  });

  it("headHash equals the last entry's hash", () => {
    const entries = buildChain(["x", "y", "z"]);
    const result = verifyChain(entries);
    expect(result.headHash).toBe(entries[entries.length - 1]!.hash);
  });
});

// ---------------------------------------------------------------------------
// verifyChain — tampered payloadHash (hash mismatch)
// ---------------------------------------------------------------------------

describe("verifyChain — tampered payloadHash", () => {
  it("detects hash mismatch when payloadHash is altered on entry 0", () => {
    const entries = buildChain(["a", "b", "c"]);
    // Mutate payloadHash without recomputing hash → the stored hash no longer
    // matches computeEntryHash(seq, prevHash, tamperedPayloadHash).
    const tampered: AuditEntry[] = [
      { ...entries[0]!, payloadHash: sha256("DIFFERENT") },
      ...entries.slice(1),
    ];
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(0);
    expect(result.reason).toMatch(/hash mismatch.*seq 0/);
  });

  it("detects hash mismatch on entry 1 (middle)", () => {
    const entries = buildChain(["a", "b", "c"]);
    const tampered: AuditEntry[] = [
      entries[0]!,
      { ...entries[1]!, payloadHash: sha256("TAMPERED") },
      entries[2]!,
    ];
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("detects hash mismatch on the last entry", () => {
    const entries = buildChain(["a", "b", "c"]);
    const tampered: AuditEntry[] = [
      entries[0]!,
      entries[1]!,
      { ...entries[2]!, payloadHash: sha256("TAMPERED") },
    ];
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// verifyChain — broken prevHash link
// ---------------------------------------------------------------------------

describe("verifyChain — broken prevHash link", () => {
  it("detects a broken prevHash link on entry 1", () => {
    const entries = buildChain(["a", "b", "c"]);
    // Rewrite entry[1].prevHash to something wrong (keep stored hash as-is so
    // BOTH the link check and the hash integrity check could trigger, but the
    // link check fires first).
    const tampered: AuditEntry[] = [
      entries[0]!,
      { ...entries[1]!, prevHash: "000000000000000000000000000000000000000000000000000000000000dead" },
      entries[2]!,
    ];
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toMatch(/prevHash link broken.*seq 1/);
  });

  it("detects a broken prevHash link on entry 2", () => {
    const entries = buildChain(["a", "b", "c"]);
    const tampered: AuditEntry[] = [
      entries[0]!,
      entries[1]!,
      { ...entries[2]!, prevHash: "badhash" },
    ];
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// verifyChain — non-contiguous seq
// ---------------------------------------------------------------------------

describe("verifyChain — non-contiguous seq", () => {
  it("detects a gap: [0, 2] (missing seq 1)", () => {
    const full = buildChain(["a", "b", "c"]);
    // Drop entry[1] — now entry[2] has seq=2 but is at index 1 of the slice.
    const gapped: AuditEntry[] = [full[0]!, full[2]!];
    const result = verifyChain(gapped);
    expect(result.valid).toBe(false);
    // The second element (index 1) has seq=2, but expected seq=0+1=1.
    expect(result.brokenAt).toBe(2);
    expect(result.reason).toMatch(/seq discontinuity/);
  });

  it("detects duplicate seq numbers", () => {
    const full = buildChain(["a", "b", "c"]);
    // Insert a duplicate of entry[0] at position 1.
    const dup: AuditEntry[] = [full[0]!, full[0]!, full[1]!, full[2]!];
    const result = verifyChain(dup);
    expect(result.valid).toBe(false);
  });

  it("detects non-zero starting seq inconsistency when a gap follows", () => {
    // Chain starting at seq=3; entries must be 3,4,5.
    const payloads = ["p", "q", "r"];
    const entries: AuditEntry[] = [];
    let prevHash = "genesis-for-test";
    for (let i = 0; i < payloads.length; i++) {
      const seq = 3 + i;
      const payloadHash = sha256(payloads[i]!);
      const hash = computeEntryHash(seq, prevHash, payloadHash);
      entries.push({ seq, prevHash, payloadHash, hash });
      prevHash = hash;
    }
    // Valid as-is.
    expect(verifyChain(entries).valid).toBe(true);

    // Drop the middle entry → gap 3,5.
    const gapped: AuditEntry[] = [entries[0]!, entries[2]!];
    const result = verifyChain(gapped);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/seq discontinuity/);
  });
});

// ---------------------------------------------------------------------------
// computeHeadAnchor
// ---------------------------------------------------------------------------

describe("computeHeadAnchor", () => {
  it("returns null for an empty chain", () => {
    expect(computeHeadAnchor([])).toBeNull();
  });

  it("returns {seq, hash} of the last entry for a non-empty chain", () => {
    const entries = buildChain(["x", "y", "z"]);
    const anchor = computeHeadAnchor(entries);
    expect(anchor).not.toBeNull();
    expect(anchor!.seq).toBe(2);
    expect(anchor!.hash).toBe(entries[2]!.hash);
  });

  it("returns the single entry for a 1-entry chain", () => {
    const entries = buildChain(["solo"]);
    const anchor = computeHeadAnchor(entries);
    expect(anchor!.seq).toBe(0);
    expect(anchor!.hash).toBe(entries[0]!.hash);
  });
});

// ---------------------------------------------------------------------------
// detectTruncation
// ---------------------------------------------------------------------------

describe("detectTruncation", () => {
  it("ok when the anchored entry is present and hash matches", () => {
    const entries = buildChain(["a", "b", "c"]);
    const anchor: ExternalAnchor = { seq: 1, hash: entries[1]!.hash };
    const result = detectTruncation(entries, anchor);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
  });

  it("ok when anchor is at seq 0 (genesis)", () => {
    const entries = buildChain(["a", "b", "c"]);
    const anchor: ExternalAnchor = { seq: 0, hash: entries[0]!.hash };
    expect(detectTruncation(entries, anchor).ok).toBe(true);
  });

  it("ok when anchor is at the last entry", () => {
    const entries = buildChain(["a", "b", "c"]);
    const anchor: ExternalAnchor = { seq: 2, hash: entries[2]!.hash };
    expect(detectTruncation(entries, anchor).ok).toBe(true);
  });

  it("truncated: entry at anchored seq is missing", () => {
    const entries = buildChain(["a", "b", "c"]);
    // Remove entry at seq=1 from the live chain.
    const truncated = entries.filter((e) => e.seq !== 1);
    const anchor: ExternalAnchor = { seq: 1, hash: entries[1]!.hash };
    const result = detectTruncation(truncated, anchor);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/truncated.*seq 1.*missing/);
  });

  it("rewritten: entry at anchored seq exists but hash differs", () => {
    const entries = buildChain(["a", "b", "c"]);
    const anchor: ExternalAnchor = { seq: 1, hash: entries[1]!.hash };
    // Replace entry[1] with a tampered version that has a different hash.
    const rewritten: AuditEntry[] = [
      entries[0]!,
      { ...entries[1]!, hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      entries[2]!,
    ];
    const result = detectTruncation(rewritten, anchor);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/rewritten.*seq 1/);
  });

  it("truncated when the entire chain is empty but anchor refers to a seq", () => {
    const anchor: ExternalAnchor = { seq: 0, hash: "somehash" };
    const result = detectTruncation([], anchor);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/truncated/);
  });

  it("truncated when anchor.seq is beyond the live chain end", () => {
    const entries = buildChain(["a", "b"]);
    const anchor: ExternalAnchor = { seq: 99, hash: "somehash" };
    const result = detectTruncation(entries, anchor);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/truncated.*seq 99.*missing/);
  });
});
