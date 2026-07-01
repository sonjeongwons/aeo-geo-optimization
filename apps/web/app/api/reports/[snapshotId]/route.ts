/**
 * GET /api/reports/[snapshotId]
 *
 * Returns the immutable as-delivered RunReport for a single report_snapshot.
 *
 * Security invariants:
 *  - requireCustomerScope() is called first (redirect/403 without valid session).
 *  - The snapshot's customer_id is checked against session.customerId AFTER
 *    fetching by id. A mismatch (or missing row) returns 404 — NOT 403 — to
 *    avoid existence leakage.
 *  - The snapshotId comes from the URL param (not trusted as an ownership proof).
 *
 * Returns the report_snapshot.report_json as a WireRunReport (Dates → ISO strings).
 * The response is labeled "as-delivered" (the immutable snapshot, never drifts on
 * a later re-judge).
 */

import { NextResponse } from "next/server";
import { requireCustomerScope, ScopeError } from "../../../../lib/session";
import { getReportSnapshot } from "@engine/db/repo";
import { toWireReport } from "../../../../lib/wire";
import type { RunReport } from "@engine/domain/metrics.types";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ snapshotId: string }> },
): Promise<NextResponse> {
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

  // 2. Extract the route param.
  const { snapshotId } = await params;
  if (!snapshotId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // 3. Fetch the snapshot (includes customer_id for the ownership check).
  const snapshot = await getReportSnapshot(snapshotId);

  // 4. Ownership check — fail-closed: 404 on mismatch or missing row.
  //    We return 404 (not 403) so the existence of the snapshot is not leaked
  //    to a customer who does not own it.
  if (!snapshot || snapshot.customer_id !== customerId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // 5. Convert the stored report_json to a WireRunReport (Dates → ISO strings).
  //    report_json is typed as `unknown` in the schema; cast it to RunReport
  //    before passing to toWireReport.
  const reportJson = snapshot.report_json as RunReport;
  const wire = toWireReport(reportJson);

  return NextResponse.json({
    snapshotId: snapshot.id,
    runId: snapshot.run_id,
    weekStart: snapshot.week_start instanceof Date
      ? snapshot.week_start.toISOString()
      : snapshot.week_start,
    smr: snapshot.smr,
    visibility: snapshot.visibility,
    topSov: snapshot.top_sov,
    abstainRate: snapshot.abstain_rate,
    wowSmrDelta: snapshot.wow_smr_delta,
    generatedAt: snapshot.generated_at instanceof Date
      ? snapshot.generated_at.toISOString()
      : snapshot.generated_at,
    // The as-delivered immutable RunReport.
    asDelivered: true,
    report: wire,
  });
}
