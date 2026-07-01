"use server";

/**
 * apps/web/lib/actions/approvals.ts
 *
 * Server Actions for customer approval flows:
 *  - signClaim   — sign-off on a claim_source row (§7 claim verification gate)
 *  - approveDeploy — approve a content_deploy_queue row (§11/§12 audit)
 *
 * SECURITY:
 *  - Both actions call requireCustomerScopeWithSession() first — the customerId
 *    comes ONLY from the verified session, NEVER from the client.
 *  - The fail-closed wrappers (signClaimSourceForCustomer /
 *    approveDeployRowForCustomer) throw NotOwned when the row's owner is NULL
 *    or != session.customerId — callers surface this as "not found" (404 in HTTP,
 *    error message in UI) to avoid existence leakage.
 *  - The reviewer/approver identity stamped on the row is always session.email
 *    (§12 audit trail) — never a client-supplied string.
 *
 * Node 22 / App Router / Next.js 15 — server-only module.
 */

import { revalidatePath } from "next/cache";
import { requireCustomerScopeWithSession } from "../session";
import {
  signClaimSourceForCustomer,
  approveDeployRowForCustomer,
  findClaimSources,
  findBrandsByCustomer,
} from "../engine.server";

// Re-export the NotOwned error class so UI can narrow on it if needed.
import { NotOwned } from "@engine/db/repo";
export { NotOwned };

// ---------------------------------------------------------------------------
// signClaim — §7 claim sign-off + $0 re-gate of affected needs_human assets
// ---------------------------------------------------------------------------

/**
 * Sign a claim_source row on behalf of the session customer.
 *
 * After signing, re-gates ALL needs_human assets for the customer ($0, no LLM)
 * so that newly-signed claims can transition blocked assets to passed status.
 *
 * Returns { ok: true } on success, { ok: false, error, notFound } on failure.
 * notFound=true means the row is missing or belongs to another tenant (HTTP 404).
 */
export async function signClaim(
  claimId: string,
): Promise<{ ok: boolean; error?: string; notFound?: boolean }> {
  let customerId: string;
  let sessionEmail: string;

  try {
    const { customerId: cid, session } = await requireCustomerScopeWithSession();
    customerId = cid;
    sessionEmail = session.email;
  } catch {
    return { ok: false, error: "인증이 필요합니다." };
  }

  try {
    // Step 1: Sign the claim (fail-closed ownership check inside).
    await signClaimSourceForCustomer(claimId, customerId, sessionEmail);
  } catch (err) {
    if (err instanceof NotOwned) {
      // Fail-closed: surface as not-found (no existence leak).
      return {
        ok: false,
        notFound: true,
        error: "해당 클레임을 찾을 수 없거나 접근 권한이 없습니다.",
      };
    }
    console.error("[approvals.action] signClaim signing error:", err);
    return { ok: false, error: "클레임 서명 중 오류가 발생했습니다." };
  }

  // Step 2: Re-gate ALL needs_human assets for the customer at $0 (no LLM).
  // This mirrors the reviewClaims.ts CLI flow: after signing, re-gate so the
  // newly-verified claim can transition assets from needs_human → passed.
  try {
    await regateCustomerNeedsHumanAssets(customerId);
  } catch (err) {
    // Re-gate errors are non-fatal (sign already succeeded).
    console.error("[approvals.action] signClaim re-gate error (non-fatal):", err);
  }

  revalidatePath("/approvals/claims");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// approveDeploy — §11/§12 deploy queue approval
// ---------------------------------------------------------------------------

/**
 * Approve a content_deploy_queue row on behalf of the session customer.
 *
 * The approver identity (session email) is recorded on the queue row for §12 audit.
 *
 * Returns { ok: true, updated } on success, { ok: false, error, notFound } on failure.
 * notFound=true means the asset is missing or belongs to another tenant (HTTP 404).
 */
export async function approveDeploy(
  assetId: string,
): Promise<{ ok: boolean; updated?: number; error?: string; notFound?: boolean }> {
  let customerId: string;
  let sessionEmail: string;

  try {
    const { customerId: cid, session } = await requireCustomerScopeWithSession();
    customerId = cid;
    sessionEmail = session.email;
  } catch {
    return { ok: false, error: "인증이 필요합니다." };
  }

  try {
    const result = await approveDeployRowForCustomer(assetId, customerId, sessionEmail);
    revalidatePath("/approvals/deploy");
    return { ok: true, updated: result.updated };
  } catch (err) {
    if (err instanceof NotOwned) {
      return {
        ok: false,
        notFound: true,
        error: "해당 에셋을 찾을 수 없거나 접근 권한이 없습니다.",
      };
    }
    console.error("[approvals.action] approveDeploy error:", err);
    return { ok: false, error: "승인 처리 중 오류가 발생했습니다." };
  }
}

// ---------------------------------------------------------------------------
// Internal: $0 re-gate for all needs_human assets of a customer
// ---------------------------------------------------------------------------

/**
 * Re-gate all content_asset rows with gate_status='needs_human' for a customer.
 *
 * This is called after a claim sign-off so that assets blocked on an unsigned
 * claim can be re-evaluated with the newly-signed claim in the registry.
 *
 * NO LLM calls are made — runContentGates() is deterministic for the cheap
 * structural gates; the claimVerificationGate re-evaluates the updated registry.
 *
 * $0 cost: no generative AI calls.
 */
async function regateCustomerNeedsHumanAssets(customerId: string): Promise<void> {
  const [{ getDb }, { regateAsset }, { defaultContentGateRegistry }, brands, claimSourcesRaw] =
    await Promise.all([
      import("@engine/db/kysely"),
      import("@engine/content/assembleContentSet"),
      import("@engine/content/contentGate"),
      findBrandsByCustomer(customerId),
      findClaimSources(customerId),
    ]);

  const db = getDb();

  // Find all needs_human assets for this customer.
  const needsHumanRows = await db
    .selectFrom("content_asset")
    .selectAll()
    .where("customer_id", "=", customerId)
    .where("gate_status", "=", "needs_human")
    .execute();

  if (needsHumanRows.length === 0) return;

  const brandAliases = brands.flatMap((b) => [b.name, ...b.aliases]);
  const gates = defaultContentGateRegistry.gates();

  for (const row of needsHumanRows) {
    try {
      // Map DB row to the ContentAsset shape expected by regateAsset.
      // Build the ContentAsset shape from the DB row (mirrors mapDbRowToAsset in reviewClaims.ts).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const asset = {
        id: row.id,
        customer_id: row.customer_id,
        industry: row.industry,
        template_id: row.template_id,
        template_version: row.template_version,
        content_set_id: row.content_set_id,
        content_type: row.content_type,
        format: row.format,
        channel_class: row.channel_class,
        language: row.language,
        phrasing_group_id: row.phrasing_group_id,
        body: row.body,
        claims: (Array.isArray(row.claims) ? row.claims : []),
        word_count: row.word_count,
        gate_status: row.gate_status,
        gate_report: (Array.isArray(row.gate_report) ? row.gate_report : null),
        disclosure_tag: row.disclosure_tag,
        needs_native_review: row.needs_native_review,
        regen_attempts: row.regen_attempts,
        // provenance from DB is `unknown`; cast to satisfy the typed ContentAsset shape.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provenance: row.provenance as any,
        created_at: row.created_at,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      await regateAsset(
        asset,
        row.content_set_id,
        brandAliases,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        claimSourcesRaw as any,
        gates,
      );
    } catch (err) {
      // Fail gracefully per asset — don't let one bad asset stop others.
      console.error(
        `[approvals.action] regateCustomerNeedsHumanAssets: re-gate error for asset ${row.id}:`,
        err,
      );
    }
  }
}
