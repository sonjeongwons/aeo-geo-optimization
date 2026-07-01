/**
 * apps/web/lib/demo.ts
 *
 * Shared constant for the public free-diagnostic funnel. Lives OUTSIDE any
 * "use server" module because a Server Actions file may only export async
 * functions (Next.js invalid-use-server-value). Imported by both the diagnose
 * Server Action (lib/actions/diagnose.ts) and the public result page.
 */
export const DEMO_CUSTOMER_SLUG: string =
  process.env["DEMO_CUSTOMER_SLUG"] ?? "demo";
