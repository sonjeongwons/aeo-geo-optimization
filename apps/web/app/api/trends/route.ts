/**
 * GET /api/trends
 *
 * Returns the SMR / visibility time-series derived from report_snapshot history
 * for the session customer. O(snapshots), NOT a live re-aggregation.
 *
 * Security: requireCustomerScope() is called first.
 *
 * Response shape (all dates as ISO strings):
 * {
 *   series: Array<{
 *     snapshotId: string;
 *     weekStart: string;       // ISO 8601
 *     generatedAt: string;     // ISO 8601
 *     smr: string;             // PgNumeric — pass as-is for chart precision
 *     visibility: string;
 *     topSov: string | null;
 *     abstainRate: string;
 *     wowSmrDelta: string | null;
 *   }>
 * }
 *
 * The list is ordered by week_start ASC (oldest first) for charting convenience.
 */

import { NextResponse } from "next/server";
import { requireCustomerScope, ScopeError } from "../../../lib/session";
import { listReportSnapshots } from "@engine/db/repo";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  // 1. Require a customer-scoped session.
  let customerId: string;
  try {
    customerId = await requireCustomerScope();
  } catch (err: unknown) {
    if (err instanceof ScopeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // 2. Fetch all snapshots for this customer (already tenant-scoped).
  //    listReportSnapshots returns week_start DESC; reverse for ascending chart order.
  const snapshots = await listReportSnapshots(customerId);

  // 3. Build the series (oldest → newest for chart rendering).
  const series = [...snapshots]
    .reverse()
    .map((s) => ({
      snapshotId: s.id,
      weekStart: s.week_start instanceof Date ? s.week_start.toISOString() : s.week_start,
      generatedAt: s.generated_at instanceof Date ? s.generated_at.toISOString() : s.generated_at,
      smr: s.smr,
      visibility: s.visibility,
      topSov: s.top_sov,
      abstainRate: s.abstain_rate,
      wowSmrDelta: s.wow_smr_delta,
    }));

  return NextResponse.json({ series });
}
