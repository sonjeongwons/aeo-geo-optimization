/**
 * apps/web/lib/engine.server.ts
 *
 * Server-only facade for the AEO/GEO engine.
 *
 * `import "server-only"` makes any accidental client-component import a
 * BUILD-TIME error rather than a runtime surprise that ships server code.
 *
 * This module re-exports:
 *  - assembleReport()         — core report assembly (src/metrics/report.ts)
 *  - toWireReport()           — Date→ISO-string transform (lib/wire.ts)
 *  - Scoped repo read fns     — all tenant-scoped to a customerId
 *  - Auth repo fns            — findAppUserByEmail, createSession, findSession,
 *                               deleteSession (used by the auth action)
 *  - Customer-keyed mutation wrappers — fail-closed signClaimSourceForCustomer,
 *                               approveDeployRowForCustomer
 *  - findRun / findResponseRaw — for ownership checks in Route Handlers
 *
 * RULES:
 *  - Only @engine/domain/* types may cross to client components.
 *  - Everything else (pg/kysely/pino/report/billing) stays in server modules.
 *  - Client components NEVER import this file (enforced by server-only).
 *  - All date fields on RunReport are converted to strings via toWireReport()
 *    before being passed to any client component.
 */

import "server-only";

// ---------------------------------------------------------------------------
// Core report assembly
// ---------------------------------------------------------------------------

export { assembleReport } from "@engine/metrics/report";

// ---------------------------------------------------------------------------
// Wire DTO transform (Date → ISO string for RSC boundary)
// ---------------------------------------------------------------------------

export { toWireReport } from "./wire";
export type { WireRunReport } from "./wire";

// ---------------------------------------------------------------------------
// Scoped repo reads (all customer-scoped)
// ---------------------------------------------------------------------------

export {
  // Report snapshots (immutable, as-delivered)
  listReportSnapshots,
  getReportSnapshot,
  insertReportSnapshot,
  insertReportDelivery,

  // Previous run lookup (WoW delta computation)
  findPreviousOperatingRun,

  // Billing
  getSubscription,
  upsertSubscription,
  cancelAtPeriodEnd,
  listInvoices,
  listInvoiceLines,
  insertInvoice,
  insertInvoiceLine,
  sumLlmUsageForPeriod,

  // Run & response (for ownership checks)
  findRun,
  findResponseRaw,

  // Brand/competitor scoped reads
  findBrandsByCustomer,
  findCompetitorsByCustomer,

  // Scope reads (used by billing page for real question/language counts)
  findActiveQuestions,
  findCustomerLanguages,
  findEnabledModels,

  // Content approval reads
  listContentAssetsForSet,
  findClaimSources,
} from "@engine/db/repo";

// ---------------------------------------------------------------------------
// Auth repo fns (used by login action + session layer)
// ---------------------------------------------------------------------------

export {
  findAppUserByEmail,
  createAppUser,
  createSession,
  findSession,
  deleteSession,
} from "@engine/db/repo";

// ---------------------------------------------------------------------------
// Fail-closed customer-keyed mutation wrappers (P5-T06)
// ---------------------------------------------------------------------------

export {
  signClaimSourceForCustomer,
  approveDeployRowForCustomer,
} from "@engine/db/repo";

// ---------------------------------------------------------------------------
// Staff-only repo fns (industry template management)
// ---------------------------------------------------------------------------

export {
  listIndustryTemplates,
  listAllIndustryTemplates,
  getIndustryTemplate,
} from "@engine/db/repo";

// ---------------------------------------------------------------------------
// Auth primitives (engine-side, pure, no IO)
// ---------------------------------------------------------------------------

export { hashPassword, verifyPassword } from "@engine/auth/password";
export { createSessionToken, hashToken } from "@engine/auth/session";
