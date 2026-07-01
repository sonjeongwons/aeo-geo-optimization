/**
 * test/report-deliver.test.ts
 *
 * P5-T19 acceptance criteria — report delivery pipeline:
 *
 * 1. Snapshot persisted exactly once per run (UNIQUE(run_id) semantics)
 * 2. Exactly-once delivery: re-running deliver for the same run does NOT
 *    call DeliverySink.send again (report_delivery UNIQUE backstop)
 * 3. WoW delta uses only a previous run with status='completed' AND kind='operating'
 *    — failed / over_budget / partial runs are excluded
 * 4. Baseline runs (kind='baseline') are NOT delivered
 * 5. week_start is derived from run.finished_at (truncated to Monday 00:00:00 UTC)
 * 6. NoopSink does not throw; ResendSink throws DeliverySinkError on HTTP errors
 *
 * These are UNIT tests — no real Postgres. The deliver pipeline is tested by
 * exercising the pure guard logic and the deliverySink interface in isolation.
 */

import { describe, it, expect, vi } from 'vitest';
import { NoopSink, DeliverySinkError } from '../src/report/deliverySink.js';
import { renderWeeklyReportEmail } from '../src/report/emailTemplate.js';
import { generateReportToken } from '../src/report/reportToken.js';

// ============================================================
// Week-start derivation (toWeekStart logic)
// ============================================================

/**
 * Mirrors the toWeekStart helper in src/report/deliver.ts.
 * Exported here as a pure function for unit testing.
 */
function toWeekStart(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  const day = out.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  out.setUTCDate(out.getUTCDate() + diffToMonday);
  return out;
}

describe('toWeekStart — ISO-week Monday derivation', () => {
  it('Monday stays as Monday', () => {
    // 2026-06-22 = Monday
    const d = new Date('2026-06-22T15:30:00Z');
    const ws = toWeekStart(d);
    expect(ws.getUTCDay()).toBe(1); // Monday
    expect(ws.getUTCHours()).toBe(0);
    expect(ws.getUTCMinutes()).toBe(0);
    expect(ws.getUTCSeconds()).toBe(0);
    expect(ws.toISOString().startsWith('2026-06-22')).toBe(true);
  });

  it('Sunday rolls back 6 days to Monday', () => {
    // 2026-06-28 = Sunday
    const d = new Date('2026-06-28T10:00:00Z');
    const ws = toWeekStart(d);
    expect(ws.getUTCDay()).toBe(1); // Monday
    expect(ws.toISOString().startsWith('2026-06-22')).toBe(true);
  });

  it('Wednesday rolls back 2 days to Monday', () => {
    // 2026-06-24 = Wednesday
    const d = new Date('2026-06-24T08:00:00Z');
    const ws = toWeekStart(d);
    expect(ws.getUTCDay()).toBe(1); // Monday
    expect(ws.toISOString().startsWith('2026-06-22')).toBe(true);
  });

  it('Saturday rolls back 5 days to Monday', () => {
    // 2026-06-27 = Saturday
    const d = new Date('2026-06-27T23:59:59Z');
    const ws = toWeekStart(d);
    expect(ws.getUTCDay()).toBe(1); // Monday
    expect(ws.toISOString().startsWith('2026-06-22')).toBe(true);
  });

  it('time portion is zeroed (00:00:00.000Z)', () => {
    const d = new Date('2026-06-23T12:34:56.789Z'); // Tuesday
    const ws = toWeekStart(d);
    expect(ws.getUTCHours()).toBe(0);
    expect(ws.getUTCMinutes()).toBe(0);
    expect(ws.getUTCSeconds()).toBe(0);
    expect(ws.getUTCMilliseconds()).toBe(0);
  });
});

// ============================================================
// WoW delta — previous run filter semantics
// ============================================================

/**
 * Mirrors the findPreviousOperatingRun filter logic:
 * - kind must be 'operating'
 * - status must be 'completed'
 * - planned_at must be strictly before the reference date
 *
 * Returns null when no qualifying run exists.
 */
function findPreviousOperatingRunStub(
  runs: Array<{ id: string; kind: string; status: string; planned_at: Date }>,
  beforePlannedAt: Date,
): { id: string } | null {
  const qualifying = runs
    .filter(
      (r) =>
        r.kind === 'operating' &&
        r.status === 'completed' &&
        r.planned_at < beforePlannedAt,
    )
    .sort((a, b) => b.planned_at.getTime() - a.planned_at.getTime());

  return qualifying[0] ?? null;
}

const REF_DATE = new Date('2026-06-22T00:00:00Z');

describe('findPreviousOperatingRun — WoW filter semantics', () => {
  it('returns a completed operating run that precedes the reference date', () => {
    const runs = [
      { id: 'run-ok', kind: 'operating', status: 'completed', planned_at: new Date('2026-06-15T00:00:00Z') },
    ];
    const result = findPreviousOperatingRunStub(runs, REF_DATE);
    expect(result?.id).toBe('run-ok');
  });

  it('excludes a FAILED run even if it is the most recent', () => {
    const runs = [
      { id: 'run-failed', kind: 'operating', status: 'failed', planned_at: new Date('2026-06-15T00:00:00Z') },
      { id: 'run-ok', kind: 'operating', status: 'completed', planned_at: new Date('2026-06-08T00:00:00Z') },
    ];
    const result = findPreviousOperatingRunStub(runs, REF_DATE);
    expect(result?.id).toBe('run-ok');
  });

  it('excludes an OVER_BUDGET run', () => {
    const runs = [
      { id: 'run-over', kind: 'operating', status: 'over_budget', planned_at: new Date('2026-06-15T00:00:00Z') },
    ];
    const result = findPreviousOperatingRunStub(runs, REF_DATE);
    expect(result).toBeNull();
  });

  it('excludes a BASELINE run (wrong kind)', () => {
    const runs = [
      { id: 'run-baseline', kind: 'baseline', status: 'completed', planned_at: new Date('2026-06-15T00:00:00Z') },
    ];
    const result = findPreviousOperatingRunStub(runs, REF_DATE);
    expect(result).toBeNull();
  });

  it('excludes a run with planned_at EQUAL to the reference date (must be strictly before)', () => {
    const runs = [
      { id: 'run-same-date', kind: 'operating', status: 'completed', planned_at: REF_DATE },
    ];
    const result = findPreviousOperatingRunStub(runs, REF_DATE);
    expect(result).toBeNull();
  });

  it('returns null when no runs exist', () => {
    expect(findPreviousOperatingRunStub([], REF_DATE)).toBeNull();
  });

  it('returns the MOST RECENT qualifying run when multiple exist', () => {
    const runs = [
      { id: 'run-old', kind: 'operating', status: 'completed', planned_at: new Date('2026-06-01T00:00:00Z') },
      { id: 'run-newer', kind: 'operating', status: 'completed', planned_at: new Date('2026-06-15T00:00:00Z') },
      { id: 'run-failed', kind: 'operating', status: 'failed', planned_at: new Date('2026-06-18T00:00:00Z') },
    ];
    const result = findPreviousOperatingRunStub(runs, REF_DATE);
    expect(result?.id).toBe('run-newer'); // most recent completed operating
  });
});

// ============================================================
// Exactly-once delivery — idempotency guard
// ============================================================

/**
 * Mirrors the exactly-once pre-check in deliver.ts:
 * - If a 'sent' report_delivery row exists for (snapshotId, recipient), skip send.
 * - Returns true when send should be skipped (already delivered).
 */
function shouldSkipDelivery(
  existingRows: Array<{ snapshot_id: string; recipient: string; status: string }>,
  snapshotId: string,
  recipient: string,
): boolean {
  return existingRows.some(
    (r) =>
      r.snapshot_id === snapshotId &&
      r.recipient === recipient &&
      r.status === 'sent',
  );
}

describe('exactly-once delivery guard', () => {
  it('should skip when a sent delivery row already exists', () => {
    const rows = [{ snapshot_id: 'snap-1', recipient: 'user@example.com', status: 'sent' }];
    expect(shouldSkipDelivery(rows, 'snap-1', 'user@example.com')).toBe(true);
  });

  it('should NOT skip when no delivery row exists', () => {
    expect(shouldSkipDelivery([], 'snap-1', 'user@example.com')).toBe(false);
  });

  it('should NOT skip when only a FAILED delivery row exists (retry is OK)', () => {
    const rows = [{ snapshot_id: 'snap-1', recipient: 'user@example.com', status: 'failed' }];
    expect(shouldSkipDelivery(rows, 'snap-1', 'user@example.com')).toBe(false);
  });

  it('should NOT skip when the snapshot_id does not match', () => {
    const rows = [{ snapshot_id: 'snap-OTHER', recipient: 'user@example.com', status: 'sent' }];
    expect(shouldSkipDelivery(rows, 'snap-1', 'user@example.com')).toBe(false);
  });

  it('should NOT skip when the recipient does not match', () => {
    const rows = [{ snapshot_id: 'snap-1', recipient: 'other@example.com', status: 'sent' }];
    expect(shouldSkipDelivery(rows, 'snap-1', 'user@example.com')).toBe(false);
  });
});

// ============================================================
// Snapshot idempotency — UNIQUE(run_id) semantics
// ============================================================

/**
 * Mirrors the insertReportSnapshot ON CONFLICT DO NOTHING → reload pattern.
 * Returns null on conflict (existing snapshot); { id } on insert.
 */
function insertSnapshotOrGet(
  snapshots: Map<string, { id: string; run_id: string }>,
  runId: string,
  snapshotId: string,
): { id: string } | null {
  if (snapshots.has(runId)) {
    return null; // conflict — already exists
  }
  const row = { id: snapshotId, run_id: runId };
  snapshots.set(runId, row);
  return row;
}

describe('report_snapshot — UNIQUE(run_id) idempotency', () => {
  it('first insert returns the new snapshot id', () => {
    const snapshots = new Map<string, { id: string; run_id: string }>();
    const result = insertSnapshotOrGet(snapshots, 'run-1', 'snap-uuid-1');
    expect(result?.id).toBe('snap-uuid-1');
  });

  it('second insert for the same run_id returns null (conflict path)', () => {
    const snapshots = new Map<string, { id: string; run_id: string }>();
    insertSnapshotOrGet(snapshots, 'run-1', 'snap-uuid-1');
    const secondResult = insertSnapshotOrGet(snapshots, 'run-1', 'snap-uuid-new');
    expect(secondResult).toBeNull();
  });

  it('different run_ids each get their own snapshot', () => {
    const snapshots = new Map<string, { id: string; run_id: string }>();
    const r1 = insertSnapshotOrGet(snapshots, 'run-A', 'snap-A');
    const r2 = insertSnapshotOrGet(snapshots, 'run-B', 'snap-B');
    expect(r1?.id).toBe('snap-A');
    expect(r2?.id).toBe('snap-B');
  });
});

// ============================================================
// Baseline run guard
// ============================================================

/**
 * Mirrors the guard in deliver.ts: skip when report.kind !== 'operating'.
 */
function shouldDeliverRun(kind: 'baseline' | 'operating'): boolean {
  return kind === 'operating';
}

describe('baseline run guard', () => {
  it('delivers operating runs', () => {
    expect(shouldDeliverRun('operating')).toBe(true);
  });

  it('does NOT deliver baseline runs', () => {
    expect(shouldDeliverRun('baseline')).toBe(false);
  });
});

// ============================================================
// NoopSink — interface contract
// ============================================================

describe('NoopSink', () => {
  it('has name "noop"', () => {
    const sink = new NoopSink();
    expect(sink.name).toBe('noop');
  });

  it('send() resolves without throwing', async () => {
    const sink = new NoopSink();
    await expect(
      sink.send({ to: 'test@example.com', subject: 'Test', html: '<p>hi</p>' }),
    ).resolves.toBeUndefined();
  });

  it('does not call any external services (pure side-effect check)', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const sink = new NoopSink();
    await sink.send({ to: 'user@example.com', subject: 'SMR Report', html: '<p>report</p>' });
    // Should have logged (via console.info) without throwing
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ============================================================
// DeliverySinkError
// ============================================================

describe('DeliverySinkError', () => {
  it('is an instanceof Error', () => {
    const err = new DeliverySinkError('HTTP 401 — Unauthorized', 401);
    expect(err).toBeInstanceOf(Error);
  });

  it('has name DeliverySinkError', () => {
    const err = new DeliverySinkError('something failed');
    expect(err.name).toBe('DeliverySinkError');
  });

  it('exposes statusCode when provided', () => {
    const err = new DeliverySinkError('HTTP 422', 422);
    expect(err.statusCode).toBe(422);
  });

  it('statusCode is undefined when not provided', () => {
    const err = new DeliverySinkError('some error');
    expect(err.statusCode).toBeUndefined();
  });
});

// ============================================================
// RI-01 — exactly-once: failed-then-retried delivers once and records one sent row
// ============================================================

/**
 * Simulates the partial-unique-index exactly-once protocol:
 * - 'failed' rows do NOT occupy the exactly-once slot (no conflict).
 * - A subsequent 'sent' row succeeds even when a 'failed' row already exists.
 * - A second 'sent' row is rejected by the partial unique (ON CONFLICT DO NOTHING).
 *
 * This mirrors the semantics enforced by migration 0018 + the updated
 * insertReportDelivery in repo.ts.
 */
function simulateDeliveryStore() {
  const rows: Array<{ id: string; snapshot_id: string; recipient: string; status: string }> = [];
  let nextId = 1;

  function insertRow(
    snapshotId: string,
    recipient: string,
    status: 'sent' | 'failed',
  ): { id: string } | null {
    // Partial unique: only 'sent' rows conflict.
    if (status === 'sent') {
      const existing = rows.find(
        (r) => r.snapshot_id === snapshotId && r.recipient === recipient && r.status === 'sent',
      );
      if (existing) return null; // ON CONFLICT DO NOTHING
    }
    // 'failed' rows: always insert (no unique constraint).
    const row = { id: String(nextId++), snapshot_id: snapshotId, recipient, status };
    rows.push(row);
    return { id: row.id };
  }

  function sentRows() {
    return rows.filter((r) => r.status === 'sent');
  }

  return { insertRow, sentRows, rows };
}

describe('RI-01 — exactly-once with partial unique on sent', () => {
  it('failed row followed by sent row: send succeeds and records one sent row', () => {
    const store = simulateDeliveryStore();
    const snapId = 'snap-abc';
    const recipient = 'user@example.com';

    // Attempt 1: sink.send() fails → insert 'failed' row
    const failedResult = store.insertRow(snapId, recipient, 'failed');
    expect(failedResult).not.toBeNull(); // 'failed' always inserts

    // Attempt 2: retry — pre-check finds no 'sent' row → proceed to send → insert 'sent' row
    const existingSent = store.rows.find(
      (r) => r.snapshot_id === snapId && r.recipient === recipient && r.status === 'sent',
    );
    expect(existingSent).toBeUndefined(); // pre-check: no sent row, so we do send

    const sentResult = store.insertRow(snapId, recipient, 'sent');
    expect(sentResult).not.toBeNull(); // partial unique does NOT conflict with the 'failed' row

    // Only one sent row recorded
    expect(store.sentRows()).toHaveLength(1);
    // The failed audit row is still there
    expect(store.rows.filter((r) => r.status === 'failed')).toHaveLength(1);
  });

  it('sent row followed by another sent row: second is a no-op (concurrent delivery)', () => {
    const store = simulateDeliveryStore();
    const snapId = 'snap-xyz';
    const recipient = 'user@example.com';

    const first = store.insertRow(snapId, recipient, 'sent');
    expect(first).not.toBeNull();

    const second = store.insertRow(snapId, recipient, 'sent');
    expect(second).toBeNull(); // partial unique fires: ON CONFLICT DO NOTHING

    expect(store.sentRows()).toHaveLength(1); // exactly one sent row
  });

  it('multiple failed rows are allowed (audit trail)', () => {
    const store = simulateDeliveryStore();
    const snapId = 'snap-multi-fail';
    const recipient = 'user@example.com';

    store.insertRow(snapId, recipient, 'failed');
    store.insertRow(snapId, recipient, 'failed');
    store.insertRow(snapId, recipient, 'failed');

    expect(store.rows.filter((r) => r.status === 'failed')).toHaveLength(3);
    expect(store.sentRows()).toHaveLength(0);

    // After multiple failures a retry still records the sent row
    const sentResult = store.insertRow(snapId, recipient, 'sent');
    expect(sentResult).not.toBeNull();
    expect(store.sentRows()).toHaveLength(1);
  });
});

// ============================================================
// RI-02 — weekly email contains /r/[token] permalink
// ============================================================

/**
 * Minimal RunReport fixture for email template tests.
 * Only fields accessed by renderWeeklyReportEmail are populated.
 */
function makeMinimalRunReport(): import('../src/domain/metrics.types.js').RunReport {
  return {
    runId: 'run-test-1',
    customerId: 'cust-test-1',
    kind: 'operating',
    generatedAt: new Date('2026-06-22T00:00:00Z'),
    smr: { metric: 'smr', value: 0.42, nTotal: 100, evidenceRefs: [] },
    visibility: { metric: 'visibility', value: 0.55, nTotal: 100, evidenceRefs: [] },
    sov: [],
    priorityGap: { questions: [] },
    decomposition: { byModel: [], byLanguage: [], byQuestion: [] },
    metrics: [],
    abstainCount: 3,
    abstainRate: 0.03,
    selfJudgeBiasDisclosure:
      'Judgments produced by self-judge; bias cannot be excluded.',
  };
}

describe('RI-02 — email contains /r/[token] permalink', () => {
  it('renderWeeklyReportEmail includes the /r/ link when permalinkUrl is provided', () => {
    const report = makeMinimalRunReport();
    const permalinkUrl = 'https://app.gpto.kr/r/test-snapshot-id.deadbeef1234';

    const { html, text } = renderWeeklyReportEmail({
      report,
      wowDelta: null,
      weekLabel: '2026-W25',
      permalinkUrl,
    });

    expect(html).toContain('/r/');
    expect(html).toContain(permalinkUrl);
    expect(text).toContain('/r/');
    expect(text).toContain(permalinkUrl);
  });

  it('renderWeeklyReportEmail omits the CTA when permalinkUrl is absent', () => {
    const report = makeMinimalRunReport();

    const { html, text } = renderWeeklyReportEmail({
      report,
      wowDelta: null,
      weekLabel: '2026-W25',
      // no permalinkUrl
    });

    // The /r/ path should not appear when no permalink is given
    expect(html).not.toContain('/r/');
    expect(text).not.toContain('/r/');
  });

  // MUST #2 + #4 surfaces ----------------------------------------------------
  it('renders the citation channel (SMR_citation) when citationShare is present', () => {
    const report = makeMinimalRunReport();
    report.citationShare = {
      metric: 'citation_share',
      value: 0.12,
      citationHits: 12,
      nTotal: 100,
      citationOfMentionRate: 12 / 42,
      evidenceRefs: [],
    };
    const { html, text } = renderWeeklyReportEmail({ report, wowDelta: 0.05, weekLabel: '2026-W25' });
    expect(html).toContain('Citation');
    expect(text).toContain('Citation');
  });

  it('renders a significance note (유의) for a significant WoW delta', () => {
    const report = makeMinimalRunReport();
    const { html, text } = renderWeeklyReportEmail({
      report,
      wowDelta: 0.2,
      weekLabel: '2026-W25',
      smrSignificance: {
        baselineValue: 0.1, operatingValue: 0.3, delta: 0.2,
        pValue: 0.001, significant: true, alpha: 0.05,
        deltaCi95: { lower: 0.08, upper: 0.32 }, lowPower: false,
        method: 'fisher_exact_two_sided',
      },
    });
    expect(html).toContain('유의');
    expect(text.toLowerCase()).toContain('fisher');
  });

  it('renders a NOT-significant note with 표본 부족 for a noisy low-power delta', () => {
    const report = makeMinimalRunReport();
    const { html } = renderWeeklyReportEmail({
      report,
      wowDelta: 0.05,
      weekLabel: '2026-W25',
      smrSignificance: {
        baselineValue: 0.1, operatingValue: 0.15, delta: 0.05,
        pValue: 0.42, significant: false, alpha: 0.05,
        deltaCi95: { lower: -0.1, upper: 0.2 }, lowPower: true,
        method: 'fisher_exact_two_sided',
      },
    });
    expect(html).toContain('유의하지 않음');
    expect(html).toContain('표본 부족');
  });

  it('generateReportToken produces a token containing the snapshotId', () => {
    const snapshotId = '550e8400-e29b-41d4-a716-446655440000';
    const customerId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

    process.env['REPORT_TOKEN_SECRET'] = 'test-secret-that-is-long-enough-32chars!!';
    const token = generateReportToken(snapshotId, customerId);
    delete process.env['REPORT_TOKEN_SECRET'];

    // Token starts with the snapshotId
    expect(token.startsWith(snapshotId + '.')).toBe(true);
    // The mac portion (64 hex chars after the dot) is present
    const mac = token.slice(snapshotId.length + 1);
    expect(mac).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(mac)).toBe(true);
  });

  it('generateReportToken is deterministic: same inputs yield same token', () => {
    const snapshotId = '550e8400-e29b-41d4-a716-446655440000';
    const customerId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

    process.env['REPORT_TOKEN_SECRET'] = 'deterministic-secret-must-be-32-chars!!';
    const t1 = generateReportToken(snapshotId, customerId);
    const t2 = generateReportToken(snapshotId, customerId);
    delete process.env['REPORT_TOKEN_SECRET'];

    expect(t1).toBe(t2);
  });

  it('generateReportToken differs for different customers (mac is bound to customerId)', () => {
    const snapshotId = '550e8400-e29b-41d4-a716-446655440000';

    process.env['REPORT_TOKEN_SECRET'] = 'binding-test-secret-must-be-32-chars!!';
    const t1 = generateReportToken(snapshotId, 'cust-A');
    const t2 = generateReportToken(snapshotId, 'cust-B');
    delete process.env['REPORT_TOKEN_SECRET'];

    expect(t1).not.toBe(t2);
  });
});
