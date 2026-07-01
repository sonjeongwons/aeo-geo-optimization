/**
 * GET /api/billing
 *
 * Returns billing information for the session customer:
 *  - subscription (plan tier, status, period, cancel_at_period_end)
 *  - llm usage for the current billing period (from cost_daily CAGG)
 *  - invoice list (ordered by period_start DESC)
 *
 * Security: requireCustomerScope() is called first — all data is scoped to
 * session.customerId; the customerId is never taken from a client-supplied param.
 *
 * Response shape (all dates as ISO strings):
 * {
 *   subscription: SubscriptionSummary | null;
 *   currentPeriodUsageUsd: number | null;
 *   invoices: InvoiceSummary[];
 * }
 */

import { NextResponse } from "next/server";
import { requireCustomerScope, ScopeError } from "../../../lib/session";
import { getSubscription, listInvoices, sumLlmUsageForPeriod } from "@engine/db/repo";

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

  // 2. Fetch subscription row (may be null for customers not yet on a plan).
  const subscription = await getSubscription(customerId);

  // 3. Compute current-period LLM usage from cost_daily CAGG.
  //    Uses the subscription period if available; falls back to the current
  //    calendar month so the gauge renders even before a subscription is set up.
  let periodStart: Date;
  let periodEnd: Date;

  if (subscription) {
    periodStart = subscription.current_period_start instanceof Date
      ? subscription.current_period_start
      : new Date(subscription.current_period_start);
    periodEnd = subscription.current_period_end instanceof Date
      ? subscription.current_period_end
      : new Date(subscription.current_period_end);
  } else {
    // Default: current calendar month.
    const now = new Date();
    periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }

  // sumLlmUsageForPeriod returns null when no data exists (fail-closed).
  const currentPeriodUsageUsd = await sumLlmUsageForPeriod(
    customerId,
    periodStart,
    periodEnd,
  );

  // 4. Fetch invoice list (ordered by period_start DESC).
  const rawInvoices = await listInvoices(customerId);

  // 5. Serialize — convert Date fields to ISO strings.
  const serializeSubscription = subscription
    ? {
        planTier: subscription.plan_tier,
        baseKrw: subscription.base_krw,
        status: subscription.status,
        startedAt: toIso(subscription.started_at),
        currentPeriodStart: toIso(subscription.current_period_start),
        currentPeriodEnd: toIso(subscription.current_period_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        updatedAt: toIso(subscription.updated_at),
      }
    : null;

  const invoices = rawInvoices.map((inv) => ({
    id: inv.id,
    periodStart: toIso(inv.period_start),
    periodEnd: toIso(inv.period_end),
    baseKrw: inv.base_krw,
    usageOverageKrw: inv.usage_overage_krw,
    vatKrw: inv.vat_krw,
    totalKrw: inv.total_krw,
    status: inv.status,
    issuedAt: inv.issued_at != null ? toIso(inv.issued_at) : null,
    createdAt: toIso(inv.created_at),
  }));

  return NextResponse.json({
    subscription: serializeSubscription,
    currentPeriodUsageUsd,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    invoices,
  });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}
