/**
 * GET /api/reports
 *
 * Returns the list of report_snapshot rows for the session customer,
 * ordered by week_start DESC (newest first).
 *
 * Security: requireCustomerScope() is called first.
 *
 * Each item contains the snapshot metadata (id, week_start, smr, visibility,
 * top_sov, abstain_rate, wow_smr_delta, generated_at) but NOT the full
 * report_json — callers fetch /api/reports/[snapshotId] for the full payload.
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

  // 2. List snapshots — already scoped to customerId by the repo fn.
  const snapshots = await listReportSnapshots(customerId);

  // 3. Serialize — week_start and generated_at are Dates; convert to ISO strings.
  const items = snapshots.map((s) => ({
    id: s.id,
    weekStart: s.week_start instanceof Date ? s.week_start.toISOString() : s.week_start,
    smr: s.smr,
    visibility: s.visibility,
    topSov: s.top_sov,
    abstainRate: s.abstain_rate,
    wowSmrDelta: s.wow_smr_delta,
    generatedAt: s.generated_at instanceof Date ? s.generated_at.toISOString() : s.generated_at,
  }));

  return NextResponse.json({ reports: items });
}
