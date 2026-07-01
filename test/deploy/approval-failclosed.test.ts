/**
 * test/deploy/approval-failclosed.test.ts
 *
 * T19 — Throttle, eligibility, approval, disclosure gate tests.
 *
 * Assert: NULL approved_by blocks publish (fail-closed human-approval gate).
 *
 * The human-approval step is a mandatory fail-closed gate introduced in Phase 3:
 *   - content_deploy_queue.approved_by is NULL until approveDeploy CLI sets it.
 *   - isPublishEligible returns eligible:false when approved_by is null.
 *   - An empty string is also treated as not-approved (whitespace-only trimmed).
 *   - Only a non-empty, non-whitespace approver identity is accepted.
 *
 * DESIGN-phase3.md §"Human-Approval", §"Idempotency & Safety".
 * SPEC §11 (고객 승인), §12 (audit trail).
 */

import { describe, it, expect } from "vitest";

import {
  isPublishEligible,
  type EligibilityInput,
} from "../../src/deploy/eligibility.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(approvedBy: string | null, overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    gateStatus: "passed",
    approvedBy,
    queueStatus: "leased",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. NULL approved_by → not eligible (fail-closed)
// ---------------------------------------------------------------------------

describe("approval-failclosed — NULL approved_by blocks publish", () => {
  it("returns eligible:false when approved_by is null", () => {
    const result = isPublishEligible(makeInput(null));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_approved");
    }
  });

  it("returns eligible:false when approved_by is empty string", () => {
    const result = isPublishEligible(makeInput(""));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_approved");
    }
  });

  it("returns eligible:false when approved_by is whitespace only", () => {
    const result = isPublishEligible(makeInput("   "));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_approved");
    }
  });

  it("returns eligible:false when approved_by is tab/newline whitespace", () => {
    const result = isPublishEligible(makeInput("\t\n"));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_approved");
    }
  });

  it("is fail-closed: even a single space is insufficient", () => {
    const result = isPublishEligible(makeInput(" "));
    expect(result.eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Valid approver identity (non-empty, non-whitespace) → passes this gate
// ---------------------------------------------------------------------------

describe("approval-failclosed — valid approver identity", () => {
  it("allows when approved_by is an email address (typical approveDeploy identity)", () => {
    const result = isPublishEligible(makeInput("alice@example.com"));
    expect(result.eligible).toBe(true);
  });

  it("allows when approved_by is a user ID string", () => {
    const result = isPublishEligible(makeInput("usr_12345abc"));
    expect(result.eligible).toBe(true);
  });

  it("allows when approved_by is a name string", () => {
    const result = isPublishEligible(makeInput("Alice Kim"));
    expect(result.eligible).toBe(true);
  });

  it("allows when approved_by is a single non-whitespace character", () => {
    // Edge case: even 'x' is technically non-empty; the CLI enforces richer identity
    const result = isPublishEligible(makeInput("x"));
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Approval is INDEPENDENT of gate_status — both must pass
// ---------------------------------------------------------------------------

describe("approval-failclosed — approval gate is independent of gate check", () => {
  it("gate_status='blocked' + null approved_by → not_eligible (gate_not_passed first)", () => {
    const result = isPublishEligible({
      gateStatus: "blocked",
      approvedBy: null,
      queueStatus: "leased",
    });
    expect(result.eligible).toBe(false);
    // gate_not_passed is the first condition checked
    if (!result.eligible) {
      expect(result.reason).toBe("gate_not_passed");
    }
  });

  it("gate_status='passed' + null approved_by → not_approved (second condition)", () => {
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

  it("gate_status='passed' + valid approver + not leased → not_leased (third condition)", () => {
    const result = isPublishEligible({
      gateStatus: "passed",
      approvedBy: "alice@example.com",
      queueStatus: "queued",
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_leased");
    }
  });

  it("all three satisfied → eligible", () => {
    const result = isPublishEligible({
      gateStatus: "passed",
      approvedBy: "alice@example.com",
      queueStatus: "leased",
    });
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-closed contract: unapproved rows NEVER publish
// ---------------------------------------------------------------------------

describe("approval-failclosed — fail-closed contract (queuePassedAssets inserts with NULL)", () => {
  it("a freshly queued row (approval=null) is always not-eligible", () => {
    // Simulates the row inserted by queuePassedAssets — approved_by IS NULL
    const freshQueueRow: EligibilityInput = {
      gateStatus: "passed",
      approvedBy: null,      // queuePassedAssets sets NULL
      queueStatus: "leased", // even if the worker claims it
    };
    const result = isPublishEligible(freshQueueRow);
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not_approved");
    }
  });

  it("a row signed by approveDeploy CLI becomes eligible (when other conditions also pass)", () => {
    // Simulates the row AFTER approveDeploy sets approved_by
    const approvedQueueRow: EligibilityInput = {
      gateStatus: "passed",
      approvedBy: "operator@company.com", // set by approveDeploy CLI
      queueStatus: "leased",
    };
    const result = isPublishEligible(approvedQueueRow);
    expect(result.eligible).toBe(true);
  });

  it("isPublishEligible is a pure function — no IO, deterministic", () => {
    // Multiple calls with the same unapproved input always return the same result
    const input = makeInput(null);
    const results = [
      isPublishEligible(input),
      isPublishEligible(input),
      isPublishEligible(input),
    ];
    for (const r of results) {
      expect(r.eligible).toBe(false);
      if (!r.eligible) {
        expect(r.reason).toBe("not_approved");
      }
    }
  });
});
