/**
 * GET /api/evidence/[responseRawId]
 *
 * Returns the answer_text for a single response_raw row, after verifying
 * that the row belongs to the session customer.
 *
 * Security invariants:
 *  - requireCustomerScope() is called first (redirect/403 without valid session).
 *  - response_raw.customer_id is checked against session.customerId AFTER
 *    fetching by id. A mismatch (or missing row) returns 404 — NOT 403 — to
 *    avoid existence leakage (§7 evidence traceability, multi-tenant fail-closed).
 *  - The responseRawId comes from the URL param (not trusted as an ownership proof).
 *
 * Used by EvidenceDrawer (client component) to fetch raw answer text.
 */

import { NextResponse } from "next/server";
import { requireCustomerScope, ScopeError } from "../../../../lib/session";
import { findResponseRaw } from "@engine/db/repo";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ responseRawId: string }> },
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
  const { responseRawId } = await params;
  if (!responseRawId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // 3. Fetch the response_raw row (includes customer_id for ownership check).
  const row = await findResponseRaw(responseRawId);

  // 4. Ownership check — fail-closed: 404 on mismatch or missing row.
  //    We return 404 (not 403) so the existence of the response is not leaked
  //    to a customer who does not own it.
  if (!row || row.customer_id !== customerId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // 5. Return the evidence text (answer_text is nullable — null means abstain/error).
  return NextResponse.json({
    responseRawId: row.id,
    questionId: row.question_id,
    modelId: row.model_id,
    language: row.language,
    sampleIdx: row.sample_idx,
    status: row.status,
    answerText: row.answer_text,
    capturedAt: row.captured_at instanceof Date
      ? row.captured_at.toISOString()
      : row.captured_at,
  });
}
