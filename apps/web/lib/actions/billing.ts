"use server";

/**
 * apps/web/lib/actions/billing.ts
 *
 * Server Actions for billing mutations.
 *
 * All actions are fail-closed: they call requireCustomerScope() first,
 * which redirects to /login if there's no session.
 *
 * Available actions:
 *  - cancelSubscription — sets cancel_at_period_end=true (§1 no-lock-in)
 */

import { revalidatePath } from "next/cache";
import { requireCustomerScope } from "../session";
import { cancelAtPeriodEnd } from "../engine.server";

// ---------------------------------------------------------------------------
// cancelSubscription
// ---------------------------------------------------------------------------

/**
 * Cancel the customer's subscription at period end.
 *
 * §1 month-to-month/no-lock-in: access continues until period_end; no
 * immediate data loss. The customer can reactivate before period_end.
 *
 * Idempotent: calling this multiple times is safe (the flag stays true).
 */
export async function cancelSubscription(): Promise<{
  ok: boolean;
  error?: string;
}> {
  let customerId: string;
  try {
    customerId = await requireCustomerScope();
  } catch {
    return { ok: false, error: "인증이 필요합니다." };
  }

  try {
    await cancelAtPeriodEnd(customerId);
    revalidatePath("/billing");
    return { ok: true };
  } catch (err) {
    console.error("[billing.action] cancelSubscription error:", err);
    return { ok: false, error: "해지 요청 처리 중 오류가 발생했습니다." };
  }
}
