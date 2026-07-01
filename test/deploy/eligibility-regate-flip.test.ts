/**
 * test/deploy/eligibility-regate-flip.test.ts
 *
 * T19 — Throttle, eligibility, approval, disclosure gate tests.
 *
 * Assert: eligibility is re-derived at execute time so a gate_status flip after
 * queueing closes the publish path (fail-closed).
 *
 * Scenarios:
 *   1. Normal eligible row → eligible.
 *   2. gate_status flipped to 'blocked' after queueing → NOT eligible.
 *   3. gate_status 'needs_human' → NOT eligible.
 *   4. Approval is still required even when gate_status='passed'.
 *   5. Queue status must be 'leased' (not 'queued', 'published', 'failed').
 *   6. All three conditions must hold simultaneously.
 *
 * DESIGN-phase3.md §"Idempotency & Safety" / §"Eligibility".
 * SPEC §11, §12.
 */

import { describe, it, expect } from "vitest";

import {
  isPublishEligible,
  type EligibilityInput,
} from "../../src/deploy/eligibility.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeEligible(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    gateStatus: "passed",
    approvedBy: "alice@example.com",
    queueStatus: "leased",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Fully eligible row
// ---------------------------------------------------------------------------

describe("isPublishEligible — fully eligible row", () => {
  it("returns eligible:true when all three conditions are satisfied", () => {
    const result = isPublishEligible(makeEligible());
    expect(result.eligible).toBe(true);
  });

  it("is a pure function — same input always returns same output", () => {
    const input = makeEligible();
    for (let i = 0; i < 5; i++) {
      expect(isPublishEligible(input).eligible).toBe(true);
    }
  });

  it("does not throw for valid input", () => {
    expect(() => isPublishEligible(makeEligible())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. gate_status flip scenarios (regate after queueing)
// ---------------------------------------------------------------------------

describe("isPublishEligible — gate_status regate flip", () => {
  it("returns eligible:false when gate_status='blocked' (regate flip)", () => {
    const result = isPublishEligible(makeEligible({ gateStatus: "blocked" }));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("gate_not_passed");
    }
  });

  it("returns eligible:false when gate_status='needs_human'", () => {
    const result = isPublishEligible(makeEligible({ gateStatus: "needs_human" }));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("gate_not_passed");
    }
  });

  it("returns eligible:false when gate_status='queued' (not yet evaluated)", () => {
    const result = isPublishEligible(makeEligible({ gateStatus: "queued" }));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("gate_not_passed");
    }
  });

  it("returns eligible:false when gate_status='failed'", () => {
    const result = isPublishEligible(makeEligible({ gateStatus: "failed" }));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("gate_not_passed");
    }
  });

  it("returns eligible:false for any non-'passed' gate_status", () => {
    const nonPassedStatuses = ["blocked", "needs_human", "queued", "failed", "pending", ""];
    for (const gs of nonPassedStatuses) {
      const result = isPublishEligible(makeEligible({ gateStatus: gs }));
      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reason).toBe("gate_not_passed");
      }
    }
  });

  it("passing gate_status='passed' is the ONLY value that passes the gate check", () => {
    const result = isPublishEligible(makeEligible({ gateStatus: "passed" }));
    // gateStatus is 'passed', other conditions also OK
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. queue status must be 'leased'
// ---------------------------------------------------------------------------

describe("isPublishEligible — queueStatus must be 'leased'", () => {
  it("returns eligible:false when queueStatus='queued' (not yet leased)", () => {
    const result = isPublishEligible(makeEligible({ queueStatus: "queued" }));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_leased");
    }
  });

  it("returns eligible:false when queueStatus='published'", () => {
    const result = isPublishEligible(makeEligible({ queueStatus: "published" }));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_leased");
    }
  });

  it("returns eligible:false when queueStatus='failed'", () => {
    const result = isPublishEligible(makeEligible({ queueStatus: "failed" }));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_leased");
    }
  });

  it("returns eligible:false when queueStatus='unpublished'", () => {
    const result = isPublishEligible(makeEligible({ queueStatus: "unpublished" }));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_leased");
    }
  });

  it("returns eligible:true when queueStatus='leased' and other conditions pass", () => {
    const result = isPublishEligible(makeEligible({ queueStatus: "leased" }));
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. All three conditions must hold simultaneously
// ---------------------------------------------------------------------------

describe("isPublishEligible — all three conditions required simultaneously", () => {
  it("gate_not_passed fails even if approved and leased", () => {
    const result = isPublishEligible({
      gateStatus: "blocked",
      approvedBy: "alice@example.com",
      queueStatus: "leased",
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("gate_not_passed");
    }
  });

  it("not_approved fails even if gate passed and leased", () => {
    const result = isPublishEligible({
      gateStatus: "passed",
      approvedBy: null,
      queueStatus: "leased",
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_approved");
    }
  });

  it("not_leased fails even if gate passed and approved", () => {
    const result = isPublishEligible({
      gateStatus: "passed",
      approvedBy: "bob@example.com",
      queueStatus: "queued",
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_leased");
    }
  });

  it("all three failing returns the FIRST failing reason (gate checked first)", () => {
    const result = isPublishEligible({
      gateStatus: "blocked",
      approvedBy: null,
      queueStatus: "queued",
    });
    expect(result.eligible).toBe(false);
    // gate_not_passed is checked before not_approved and not_leased
    if (!result.eligible) {
      expect(result.reason).toBe("gate_not_passed");
    }
  });

  it("gate passed but approval null returns not_approved (checked second)", () => {
    const result = isPublishEligible({
      gateStatus: "passed",
      approvedBy: null,
      queueStatus: "queued",
    });
    expect(result.eligible).toBe(false);
    // gate passes, approval is the second check
    if (!result.eligible) {
      expect(result.reason).toBe("not_approved");
    }
  });
});
