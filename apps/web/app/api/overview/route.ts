/**
 * GET /api/overview
 *
 * Returns the latest report_snapshot KPIs + decomposition for the session customer.
 *
 * Security: requireCustomerScope() is called first — no session → 302/login,
 * staff user → 403. customerId is NEVER taken from a client-supplied param.
 *
 * Returns the latest snapshot as a WireRunReport (Dates converted to ISO strings).
 * Returns 404 when no snapshots exist yet (pre-first-run state).
 */

import { NextResponse } from "next/server";
import { requireCustomerScope, ScopeError } from "../../../lib/session";
import { listReportSnapshots, getReportSnapshot } from "@engine/db/repo";
import { toWireReport } from "../../../lib/wire";
import type { RunReport } from "@engine/domain/metrics.types";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  // 1. Resolve session — redirect to /login if absent, 403 if no customer scope.
  let customerId: string;
  try {
    customerId = await requireCustomerScope();
  } catch (err: unknown) {
    if (err instanceof ScopeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // 2. List report snapshots to find the most recent one.
  const snapshots = await listReportSnapshots(customerId);

  if (snapshots.length === 0) {
    return NextResponse.json(
      { error: "No report snapshots found. Run a baseline scan first." },
      { status: 404 },
    );
  }

  // The list is ordered by week_start DESC — take the first entry.
  const latestMeta = snapshots[0];
  if (!latestMeta) {
    return NextResponse.json({ error: "No snapshot available." }, { status: 404 });
  }

  // 3. Fetch the full snapshot (includes report_json and customer_id).
  const snapshot = await getReportSnapshot(latestMeta.id);
  if (!snapshot) {
    return NextResponse.json({ error: "Snapshot not found." }, { status: 404 });
  }

  // 4. Ownership check — fail-closed: 404 on mismatch (no existence leak).
  if (snapshot.customer_id !== customerId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // 5. Convert the stored report_json to a WireRunReport (Dates → ISO strings).
  //    Use the immutable as-delivered copy (report_json) to avoid live recomputation
  //    drift on the overview.
  const reportJson = snapshot.report_json as RunReport;
  const wire = toWireReport(reportJson);

  return NextResponse.json({
    snapshotId: snapshot.id,
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
    report: wire,
  });
}
