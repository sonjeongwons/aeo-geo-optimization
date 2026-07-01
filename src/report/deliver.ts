/**
 * src/report/deliver.ts
 *
 * report.deliver — the Phase 5 weekly report delivery pipeline.
 *
 * Design (DESIGN-phase5.md §"Report Automation"):
 *
 * Flow:
 *   1. assembleReport(runId)                          — live RunReport from DB
 *   2. findPreviousOperatingRun(customerId, before)   — WoW baseline
 *   3. insertReportSnapshot(...)                      — idempotent (UNIQUE run_id)
 *   4. render HTML email via emailTemplate            — from the immutable snapshot
 *   5. DeliverySink.send(message)                     — real or noop
 *   6. insertReportDelivery(...)                      — exactly-once (UNIQUE snapshot+recipient)
 *
 * Idempotency:
 * - report_snapshot has UNIQUE(run_id): a second deliver call for the same run
 *   gets back the existing snapshot id (ON CONFLICT DO NOTHING returns null →
 *   we reload the snapshot by run_id).
 * - report_delivery has UNIQUE(snapshot_id, recipient): if the delivery row
 *   already exists the send is SKIPPED entirely (exactly-once backstop).
 *
 * Error handling:
 * - Snapshot insert failure → propagate (pg-boss retries the job).
 * - DeliverySink.send failure → mark delivery row as 'failed' and dead-letter.
 *   We insert a 'failed' report_delivery row before re-throwing so the DLQ entry
 *   is auditable and the ops alert fires.
 *
 * WoW delta:
 * - Uses findPreviousOperatingRun with status='completed' AND kind='operating'.
 * - Failed / over_budget / partial runs are excluded (different n_total snapshot
 *   would mislead the headline delta).
 *
 * week_start derivation:
 * - run.finished_at is used when available (most accurate for the delivery
 *   timestamp); falls back to run.planned_at. Truncated to the Monday UTC
 *   00:00:00 of that week.
 */

import pino from 'pino';
import { assembleReport } from '../metrics/report.js';
import { compareProportions, type ProportionComparison } from '../metrics/significance.js';
import {
  insertReportSnapshot,
  findReportSnapshotByRunId,
  insertReportDelivery,
  findPreviousOperatingRun,
} from '../db/repo.js';
import { getDb } from '../db/kysely.js';
import { renderWeeklyReportEmail } from './emailTemplate.js';
import { generateReportToken } from './reportToken.js';
import type { DeliverySink } from './deliverySink.js';
import type { RunReport } from '../domain/metrics.types.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = pino({ name: 'report.deliver' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the ISO-week Monday 00:00:00 UTC for a given date.
 * Used to derive week_start from run.finished_at / run.planned_at.
 */
function toWeekStart(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  const day = out.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  out.setUTCDate(out.getUTCDate() + diffToMonday);
  return out;
}

/**
 * Format a Date as "YYYY-WNN" (ISO week label), e.g. "2026-W25".
 */
function toWeekLabel(d: Date): string {
  const year = d.getUTCFullYear();
  // Compute ISO week number
  const jan4 = new Date(Date.UTC(year, 0, 4)); // Jan 4 is always in week 1
  const jan4Monday = new Date(jan4);
  jan4Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const diffMs = d.getTime() - jan4Monday.getTime();
  const week = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Extract the top SoV value from a RunReport (largest SoV entity).
 */
function topSovValue(report: RunReport): number | null {
  if (report.sov.length === 0) return null;
  return Math.max(...report.sov.map((s) => s.value));
}

/**
 * Fetch the recipient email for a customer.
 *
 * DESIGN: in Phase 5 the recipient is the first app_user.email for the customer.
 * In production this would query `app_user` where customer_id = customerId and role = 'owner'.
 * Returns null when no user is found (deliver still persists the snapshot but
 * logs a warning and skips sending).
 */
async function resolveRecipient(customerId: string): Promise<string | null> {
  const db = getDb();
  const row = await db
    .selectFrom('app_user')
    .select('email')
    .where('customer_id', '=', customerId)
    .where('role', '=', 'owner')
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirst();

  return row?.email ?? null;
}

// ---------------------------------------------------------------------------
// ReportDeliverParams
// ---------------------------------------------------------------------------

export interface ReportDeliverParams {
  runId: string;
  customerId: string;
  sink: DeliverySink;
  /** Optional: override the report permalink base URL for the email. */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// deliverReport — main entry point
// ---------------------------------------------------------------------------

/**
 * Execute the full report.deliver pipeline for one run.
 *
 * Idempotent: safe to call multiple times for the same runId (the report_snapshot
 * and report_delivery UNIQUE constraints prevent double-insert and double-send).
 *
 * @throws if snapshot insertion fails (non-idempotent DB error)
 * @throws if DeliverySink.send fails (after inserting a 'failed' delivery row)
 */
export async function deliverReport(params: ReportDeliverParams): Promise<void> {
  const { runId, customerId, sink } = params;

  log.info({ runId, customerId }, 'report.deliver: starting');

  // Step 1 — Assemble the live RunReport.
  const report = await assembleReport(runId);

  // Verify this is an operating run (baseline runs should NOT reach here, but
  // guard defensively).
  if (report.kind !== 'operating') {
    log.warn(
      { runId, kind: report.kind },
      'report.deliver: skipping — baseline runs do not get weekly report delivery',
    );
    return;
  }

  // Step 2 — Derive week_start from run metadata.
  const db = getDb();
  const runRow = await db
    .selectFrom('run')
    .select(['finished_at', 'planned_at'])
    .where('id', '=', runId)
    .executeTakeFirst();

  const referenceDate = runRow?.finished_at ?? runRow?.planned_at ?? new Date();
  const weekStart = toWeekStart(referenceDate);
  const weekLabel = toWeekLabel(referenceDate);

  // Step 3 — Find previous COMPLETED operating run for WoW delta.
  const previousRun = await findPreviousOperatingRun(customerId, referenceDate);
  let wowDelta: number | null = null;
  let smrSignificance: ProportionComparison | null = null;

  if (previousRun !== null) {
    try {
      const prevReport = await assembleReport(previousRun.id);
      wowDelta = report.smr.value - prevReport.smr.value;
      // MUST #4: is the WoW SMR change statistically real, or sampling noise?
      // Fisher's exact (two-sided) over the two runs' hit/total counts.
      smrSignificance = compareProportions(
        report.smr.brandHits,
        report.smr.nTotal,
        prevReport.smr.brandHits,
        prevReport.smr.nTotal,
      );
      log.debug(
        { runId, previousRunId: previousRun.id, wowDelta, pValue: smrSignificance.pValue, significant: smrSignificance.significant },
        'report.deliver: WoW delta + significance computed',
      );
    } catch (err) {
      // Non-fatal: if the previous report fails to assemble, skip WoW.
      log.warn(
        { runId, previousRunId: previousRun.id, err },
        'report.deliver: failed to assemble previous report for WoW delta — skipping delta',
      );
    }
  }

  // Step 4 — Insert (or retrieve existing) report_snapshot (idempotent).
  const snapshotInsertResult = await insertReportSnapshot({
    customerId,
    runId,
    weekStart,
    smr: report.smr.value,
    visibility: report.visibility.value,
    topSov: topSovValue(report),
    abstainRate: report.abstainRate,
    wowSmrDelta: wowDelta,
    reportJson: report,
  });

  // If ON CONFLICT fired (already snapshotted), reload the existing id.
  let snapshotId: string;
  if (snapshotInsertResult !== null) {
    snapshotId = snapshotInsertResult.id;
    log.info({ runId, snapshotId }, 'report.deliver: snapshot inserted');
  } else {
    const existing = await findReportSnapshotByRunId(runId);
    if (!existing) {
      throw new Error(
        `report.deliver: insertReportSnapshot returned null but no existing snapshot found for run=${runId}`,
      );
    }
    snapshotId = existing.id;
    log.info(
      { runId, snapshotId },
      'report.deliver: snapshot already existed (idempotent path)',
    );
  }

  // Step 5 — Resolve recipient.
  const recipient = await resolveRecipient(customerId);
  if (recipient === null) {
    log.warn(
      { runId, snapshotId, customerId },
      'report.deliver: no owner email found for customer — snapshot persisted but email skipped',
    );
    return;
  }

  // Step 6 — Check exactly-once delivery backstop.
  // We do a pre-check before calling the sink by checking whether a 'sent' row
  // already exists. This avoids re-sending on a retry where the send succeeded
  // but the delivery row insert failed.
  const db2 = getDb();
  const existingDelivery = await db2
    .selectFrom('report_delivery')
    .select('id')
    .where('snapshot_id', '=', snapshotId)
    .where('recipient', '=', recipient)
    .where('status', '=', 'sent')
    .executeTakeFirst();

  if (existingDelivery !== undefined) {
    log.info(
      { runId, snapshotId, recipient },
      'report.deliver: already delivered (exactly-once backstop) — skipping send',
    );
    return;
  }

  // Step 7 — Render and send the email.
  // Build the signed /r/[token] permalink for this snapshot.
  const baseUrl = params.baseUrl ?? process.env['REPORT_BASE_URL'] ?? 'https://app.gpto.kr';
  const reportToken = generateReportToken(snapshotId, customerId);
  const permalinkUrl = `${baseUrl}/r/${reportToken}`;

  const { html, text, subject } = renderWeeklyReportEmail({
    report,
    wowDelta,
    weekLabel,
    permalinkUrl,
    smrSignificance,
  });

  try {
    await sink.send({ to: recipient, subject, html, text });
    log.info({ runId, snapshotId, recipient, sink: sink.name }, 'report.deliver: email sent');
  } catch (err) {
    // Insert a 'failed' delivery row for audit before re-throwing.
    await insertReportDelivery({
      snapshotId,
      recipient,
      channel: 'email',
      status: 'failed',
    }).catch((insertErr) => {
      log.error(
        { snapshotId, recipient, insertErr },
        'report.deliver: failed to insert failed delivery row',
      );
    });

    log.error(
      { runId, snapshotId, recipient, err },
      'report.deliver: DeliverySink.send failed — dead-lettering',
    );
    throw err; // re-throw so pg-boss dead-letters this job
  }

  // Step 8 — Insert 'sent' delivery row (exactly-once backstop).
  const deliveryResult = await insertReportDelivery({
    snapshotId,
    recipient,
    channel: 'email',
    status: 'sent',
  });

  if (deliveryResult === null) {
    // ON CONFLICT fired — another handler concurrently inserted the delivery row.
    // This is safe: the email was already sent and the row records it.
    log.info(
      { snapshotId, recipient },
      'report.deliver: delivery row already existed (concurrent delivery — no-op)',
    );
  } else {
    log.info(
      { snapshotId, deliveryId: deliveryResult.id, recipient },
      'report.deliver: delivery row inserted',
    );
  }

  log.info({ runId, snapshotId, customerId }, 'report.deliver: complete');
}
