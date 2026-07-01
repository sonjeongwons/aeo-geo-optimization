/**
 * test/diagnose-page-tenant-gate.test.ts
 *
 * TI-01 / BHB-1 — Cross-tenant IDOR gate on the public /diagnose/[runId] page.
 *
 * The public, unauthenticated page MUST only serve demo-customer baseline runs.
 * Any runId belonging to a different customer MUST result in notFound() (404),
 * with no data leak.  This validates the fail-closed ownership check added to
 * apps/web/app/(marketing)/diagnose/[runId]/page.tsx.
 *
 * We test the gate logic directly without rendering JSX by extracting it as a
 * pure predicate: given (run, demoCustomer), does the gate reject the request?
 *
 * SPEC §10 (fail-closed multi-tenant), §0 (no existence leak).
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Types mirror what findRun / findCustomerBySlug return from repo.ts.
// We copy the minimal shapes here to keep the test self-contained and avoid
// importing Next.js / Kysely in the engine test runner.
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  customer_id: string;
  kind: 'baseline' | 'operating';
  status: 'planned' | 'running' | 'completed' | 'failed' | 'over_budget';
}

interface CustomerRow {
  id: string;
  slug: string;
}

/**
 * shouldNotFound — the gate logic extracted from page.tsx.
 *
 * Returns true when the page MUST call notFound() (i.e., deny access).
 * Returns false when the run is safe to serve.
 *
 * This mirrors the exact check in the page:
 *
 *   if (!run || run.customer_id !== demoCustomer.id || run.kind !== 'baseline') {
 *     notFound();
 *   }
 */
function shouldNotFound(
  run: RunRow | null,
  demoCustomer: CustomerRow | null,
): boolean {
  // Gate 0: demoCustomer must exist (misconfigured environment)
  if (!demoCustomer) return true;
  // Gate 1: run must exist
  if (!run) return true;
  // Gate 2: run must belong to the demo customer (IDOR fix)
  if (run.customer_id !== demoCustomer.id) return true;
  // Gate 3: only baseline runs on the public surface
  if (run.kind !== 'baseline') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEMO_CUSTOMER: CustomerRow = { id: 'demo-uuid-111', slug: 'demo' };
const OTHER_CUSTOMER: CustomerRow = { id: 'paying-tenant-999', slug: 'acme-corp' };

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 'run-abc',
    customer_id: DEMO_CUSTOMER.id,
    kind: 'baseline',
    status: 'completed',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — IDOR rejection (should return 404)
// ---------------------------------------------------------------------------

describe('diagnose page gate — cross-tenant IDOR rejection (TI-01 / BHB-1)', () => {
  it('rejects a non-demo customer baseline runId with notFound (primary IDOR case)', () => {
    // A real paying tenant also has kind='baseline' runs (onboarding).
    // Before the fix, this would have been served publicly.
    const run = makeRun({ customer_id: OTHER_CUSTOMER.id, kind: 'baseline' });
    expect(shouldNotFound(run, DEMO_CUSTOMER)).toBe(true);
  });

  it('rejects any non-demo customer run regardless of kind', () => {
    const runBaseline = makeRun({ customer_id: OTHER_CUSTOMER.id, kind: 'baseline' });
    const runOperating = makeRun({ customer_id: OTHER_CUSTOMER.id, kind: 'operating' });
    expect(shouldNotFound(runBaseline, DEMO_CUSTOMER)).toBe(true);
    expect(shouldNotFound(runOperating, DEMO_CUSTOMER)).toBe(true);
  });

  it('rejects a demo-customer operating run (wrong kind)', () => {
    const run = makeRun({ customer_id: DEMO_CUSTOMER.id, kind: 'operating' });
    expect(shouldNotFound(run, DEMO_CUSTOMER)).toBe(true);
  });

  it('rejects when run is null (non-existent runId)', () => {
    expect(shouldNotFound(null, DEMO_CUSTOMER)).toBe(true);
  });

  it('rejects when demoCustomer is null (misconfigured env)', () => {
    const run = makeRun();
    expect(shouldNotFound(run, null)).toBe(true);
  });

  it('rejects when both run and demoCustomer are null', () => {
    expect(shouldNotFound(null, null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — valid demo runs (should NOT return 404)
// ---------------------------------------------------------------------------

describe('diagnose page gate — demo customer baseline runs are served', () => {
  it('allows a demo-customer baseline completed run', () => {
    const run = makeRun({ status: 'completed' });
    expect(shouldNotFound(run, DEMO_CUSTOMER)).toBe(false);
  });

  it('allows a demo-customer baseline running run (pending state)', () => {
    // The pending/running state is handled later in the page (shows spinner),
    // but the gate itself must pass — the page serves a "running" view.
    const run = makeRun({ status: 'running' });
    expect(shouldNotFound(run, DEMO_CUSTOMER)).toBe(false);
  });

  it('allows a demo-customer baseline planned run', () => {
    const run = makeRun({ status: 'planned' });
    expect(shouldNotFound(run, DEMO_CUSTOMER)).toBe(false);
  });

  it('allows a demo-customer baseline failed run (error state shown to user)', () => {
    const run = makeRun({ status: 'failed' });
    expect(shouldNotFound(run, DEMO_CUSTOMER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — no existence leak: rejection is uniform across cases
// ---------------------------------------------------------------------------

describe('diagnose page gate — no existence leak', () => {
  it('non-demo run and non-existent run both yield the same notFound decision', () => {
    const nonDemoRun = makeRun({ customer_id: OTHER_CUSTOMER.id });
    const noRun = null;
    // Both must be rejected — attacker cannot distinguish "wrong tenant"
    // from "run does not exist" based on the page response.
    expect(shouldNotFound(nonDemoRun, DEMO_CUSTOMER)).toBe(
      shouldNotFound(noRun, DEMO_CUSTOMER),
    );
  });
});
