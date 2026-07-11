/**
 * src/db/repo.ts
 *
 * Typed data-access layer — the ONLY place SQL lives outside migrations/views.
 * Every method is typed against schema.ts (Kysely<Database>).
 *
 * Design decisions (from DESIGN.md):
 * - createRun persists n_total BEFORE any response insert (§5.2 denominator snapshot).
 * - insertJudgment APPENDS; current_judgment view picks the latest (latest-judgment-wins).
 * - markWorkUnitDone is idempotent — upsert via ON CONFLICT DO UPDATE.
 * - rotationReadAdvance reads then advances the cursor in one call (callers supply the
 *   new index, not this module — keeps this layer pure data access).
 * - customer/brand/competitor/question/budget upserts support idempotent seed loading.
 *
 * All timestamps passed as JS Date or ISO strings; pg coerces them to timestamptz.
 */

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { getDb } from './kysely.js';
import type {
  AppSessionRow,
  AppUserRow,
  ClaimSourceRow,
  ContentAssetRow,
  ContentAssetUpdate,
  ContentDeployQueueRow,
  ContentSetRow,
  CurrentJudgmentRow,
  InvoiceLineRow,
  InvoiceRow,
  NewAppSession,
  NewAppUser,
  NewBrand,
  NewClaimSource,
  NewCompetitor,
  NewContentAsset,
  NewContentDeployQueue,
  NewContentSet,
  NewCustomer,
  NewCustomerLanguage,
  NewIndustryTemplate,
  NewInvoice,
  NewInvoiceLine,
  NewLlmCall,
  NewMentionJudgment,
  NewModel,
  NewReportDelivery,
  NewReportSnapshot,
  NewResponseCache,
  NewResponseRaw,
  NewRun,
  NewSecurityAudit,
  NewSubscription,
  NewSurfaceScanQueue,
  NewUrlRegistry,
  NewWorkUnit,
  ReportDeliveryRow,
  ReportSnapshotRow,
  RunSmrOverallRow,
  SecurityAuditRow,
  SubscriptionRow,
  SurfaceScanQueueRow,
  UrlRegistryRow,
} from './schema.js';
import type { BrandBrief } from '../generate/types.js';
import {
  AUDIT_GENESIS_HASH,
  buildAuditRecord,
  verifyAuditChain,
  type AuditChainRow,
  type SecurityAuditEventType,
  type SecurityAuditInput,
} from '../security/securityAudit.js';

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** db() shorthand — we never cache the instance across calls (getDb is cheap). */
function db() {
  return getDb();
}

// ===========================================================================
// Customer
// ===========================================================================

/**
 * Upsert a customer by slug.
 * Returns the persisted customer row (id, slug, created_at).
 */
export async function upsertCustomer(
  slug: string,
): Promise<{ id: string; slug: string; created_at: Date }> {
  const rows = await db()
    .insertInto('customer')
    .values({ slug } satisfies NewCustomer)
    .onConflict((oc) =>
      oc.column('slug').doUpdateSet((eb) => ({ slug: eb.ref('excluded.slug') })),
    )
    .returning(['id', 'slug', 'created_at'])
    .execute();

  const row = rows[0];
  if (!row) throw new Error(`upsertCustomer: no row returned for slug=${slug}`);
  return row;
}

/**
 * Fetch a customer by slug. Returns null if not found.
 */
export async function findCustomerBySlug(
  slug: string,
): Promise<{ id: string; slug: string; created_at: Date } | null> {
  const row = await db()
    .selectFrom('customer')
    .selectAll()
    .where('slug', '=', slug)
    .executeTakeFirst();

  return row ?? null;
}

// ===========================================================================
// Brand
// ===========================================================================

/**
 * Upsert brand for a customer (keyed on customer_id + name).
 */
export async function upsertBrand(brand: {
  customerId: string;
  name: string;
  aliases: string[];
}): Promise<{ id: string }> {
  const values: NewBrand = {
    customer_id: brand.customerId,
    name: brand.name,
    aliases: brand.aliases,
  };

  const rows = await db()
    .insertInto('brand')
    .values(values)
    .onConflict((oc) =>
      oc
        .columns(['customer_id', 'name'])
        .doUpdateSet({ aliases: brand.aliases }),
    )
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error(`upsertBrand: no row returned for name=${brand.name}`);
  return row;
}

/**
 * Fetch all brands for a customer.
 */
export async function findBrandsByCustomer(customerId: string): Promise<
  Array<{ id: string; name: string; aliases: string[] }>
> {
  return db()
    .selectFrom('brand')
    .select(['id', 'name', 'aliases'])
    .where('customer_id', '=', customerId)
    .execute();
}

// ===========================================================================
// Competitor
// ===========================================================================

/**
 * Upsert competitor for a customer.
 */
export async function upsertCompetitor(comp: {
  customerId: string;
  name: string;
  aliases: string[];
}): Promise<{ id: string }> {
  const values: NewCompetitor = {
    customer_id: comp.customerId,
    name: comp.name,
    aliases: comp.aliases,
  };

  const rows = await db()
    .insertInto('competitor')
    .values(values)
    .onConflict((oc) =>
      oc
        .columns(['customer_id', 'name'])
        .doUpdateSet({ aliases: comp.aliases }),
    )
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error(`upsertCompetitor: no row for name=${comp.name}`);
  return row;
}

/**
 * Fetch all competitors for a customer.
 */
export async function findCompetitorsByCustomer(customerId: string): Promise<
  Array<{ id: string; name: string; aliases: string[] }>
> {
  return db()
    .selectFrom('competitor')
    .select(['id', 'name', 'aliases'])
    .where('customer_id', '=', customerId)
    .execute();
}

// ===========================================================================
// Question
// ===========================================================================

/**
 * Upsert question for a customer (keyed on customer_id + text + language).
 */
export async function upsertQuestion(q: {
  customerId: string;
  text: string;
  language: string;
  funnelStage: string | null;
  densityTier: 'core' | 'secondary' | 'longtail';
  active?: boolean;
}): Promise<{ id: string }> {
  const rows = await db()
    .insertInto('question')
    .values({
      customer_id: q.customerId,
      text: q.text,
      language: q.language,
      funnel_stage: q.funnelStage,
      density_tier: q.densityTier,
      active: q.active ?? true,
    })
    .onConflict((oc) =>
      oc
        .columns(['customer_id', 'text', 'language'])
        .doUpdateSet({
          funnel_stage: q.funnelStage,
          density_tier: q.densityTier,
          active: q.active ?? true,
        }),
    )
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error(`upsertQuestion: no row for text="${q.text}" lang=${q.language}`);
  return row;
}

/**
 * Fetch all active questions for a customer, optionally filtered by density tier.
 */
export async function findActiveQuestions(
  customerId: string,
  tiers?: Array<'core' | 'secondary' | 'longtail'>,
): Promise<
  Array<{
    id: string;
    text: string;
    language: string;
    funnel_stage: string | null;
    density_tier: 'core' | 'secondary' | 'longtail';
  }>
> {
  let q = db()
    .selectFrom('question')
    .select(['id', 'text', 'language', 'funnel_stage', 'density_tier'])
    .where('customer_id', '=', customerId)
    .where('active', '=', true);

  if (tiers && tiers.length > 0) {
    q = q.where('density_tier', 'in', tiers);
  }

  return q.execute();
}

// ===========================================================================
// Model
// ===========================================================================

/**
 * Upsert a model row (keyed on id = model string like "gemini-2.5-flash").
 *
 * Phase 4 additive: modality parameter added (DEFAULT 'chat' for backward compat).
 * Existing callers that omit modality continue to work unchanged.
 */
export async function upsertModel(m: {
  id: string;
  provider: string;
  isCheapMonitor: boolean;
  isJudge: boolean;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  enabled?: boolean;
  /** Phase 4: surface modality. DEFAULT 'chat' for backward compatibility. */
  modality?: 'chat' | 'serp' | 'scrape';
}): Promise<void> {
  const modality = m.modality ?? 'chat';

  const values: NewModel = {
    id: m.id,
    provider: m.provider,
    modality,
    is_cheap_monitor: m.isCheapMonitor,
    is_judge: m.isJudge,
    input_usd_per_mtok: String(m.inputUsdPerMtok),
    output_usd_per_mtok: String(m.outputUsdPerMtok),
    enabled: m.enabled ?? true,
  };

  await db()
    .insertInto('model')
    .values(values)
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        provider: m.provider,
        modality,
        is_cheap_monitor: m.isCheapMonitor,
        is_judge: m.isJudge,
        input_usd_per_mtok: String(m.inputUsdPerMtok),
        output_usd_per_mtok: String(m.outputUsdPerMtok),
        enabled: m.enabled ?? true,
      }),
    )
    .execute();
}

/**
 * Fetch enabled model rows.
 *
 * Phase 4 additive: modality column included in the return shape.
 * Pre-Phase-4 rows return modality='chat' (migration 0012 DEFAULT).
 * Callers that do not need modality can ignore the field; no breaking change.
 */
export async function findEnabledModels(): Promise<
  Array<{
    id: string;
    provider: string;
    /** Phase 4: surface modality. 'chat' for all pre-Phase-4 rows. */
    modality: string;
    is_cheap_monitor: boolean;
    is_judge: boolean;
    input_usd_per_mtok: string;
    output_usd_per_mtok: string;
  }>
> {
  return db()
    .selectFrom('model')
    .select([
      'id',
      'provider',
      'modality',
      'is_cheap_monitor',
      'is_judge',
      'input_usd_per_mtok',
      'output_usd_per_mtok',
    ])
    .where('enabled', '=', true)
    .execute();
}

// ===========================================================================
// Budget
// ===========================================================================

/**
 * Upsert budget for a customer.
 */
export async function upsertBudget(b: {
  customerId: string;
  maxModels: number;
  maxSamples: number;
  maxLanguages: number;
  weeklyUsdCap: number;
  monthlyUsdCap: number;
}): Promise<void> {
  await db()
    .insertInto('budget')
    .values({
      customer_id: b.customerId,
      max_models: b.maxModels,
      max_samples: b.maxSamples,
      max_languages: b.maxLanguages,
      weekly_usd_cap: String(b.weeklyUsdCap),
      monthly_usd_cap: String(b.monthlyUsdCap),
    })
    .onConflict((oc) =>
      oc.column('customer_id').doUpdateSet({
        max_models: b.maxModels,
        max_samples: b.maxSamples,
        max_languages: b.maxLanguages,
        weekly_usd_cap: String(b.weeklyUsdCap),
        monthly_usd_cap: String(b.monthlyUsdCap),
      }),
    )
    .execute();
}

/**
 * Fetch budget for a customer. Returns null if not set.
 */
export async function findBudget(customerId: string): Promise<{
  max_models: number;
  max_samples: number;
  max_languages: number;
  weekly_usd_cap: string;
  monthly_usd_cap: string;
} | null> {
  const row = await db()
    .selectFrom('budget')
    .select([
      'max_models',
      'max_samples',
      'max_languages',
      'weekly_usd_cap',
      'monthly_usd_cap',
    ])
    .where('customer_id', '=', customerId)
    .executeTakeFirst();

  return row ?? null;
}

// ===========================================================================
// Customer Language
// ===========================================================================

/**
 * Upsert a customer_language row.
 */
export async function upsertCustomerLanguage(cl: {
  customerId: string;
  language: string;
  weight: number;
}): Promise<void> {
  const values: NewCustomerLanguage = {
    customer_id: cl.customerId,
    language: cl.language,
    weight: String(cl.weight),
  };

  await db()
    .insertInto('customer_language')
    .values(values)
    .onConflict((oc) =>
      oc
        .columns(['customer_id', 'language'])
        .doUpdateSet({ weight: String(cl.weight) }),
    )
    .execute();
}

/**
 * Fetch all language entries for a customer.
 */
export async function findCustomerLanguages(
  customerId: string,
): Promise<Array<{ language: string; weight: string }>> {
  return db()
    .selectFrom('customer_language')
    .select(['language', 'weight'])
    .where('customer_id', '=', customerId)
    .execute();
}

// ===========================================================================
// Industry Template
// ===========================================================================

/**
 * Fetch a single industry_template row by id.
 * Returns null if not found.
 */
export async function getIndustryTemplate(id: string): Promise<{
  id: string;
  industry: string;
  version: number;
  status: 'draft' | 'reviewed' | 'active';
  questions: unknown;
  competitors: unknown;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  source_url: string | null;
  customer_slug: string | null;
  generated_total: number | null;
  brief_snapshot: unknown | null;
} | null> {
  const row = await db()
    .selectFrom('industry_template')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * List all industry_template rows for a given industry key, ordered by version
 * descending (newest first).
 */
export async function listIndustryTemplates(industry: string): Promise<
  Array<{
    id: string;
    industry: string;
    version: number;
    status: 'draft' | 'reviewed' | 'active';
    questions: unknown;
    competitors: unknown;
    reviewed_by: string | null;
    reviewed_at: Date | null;
    created_at: Date;
    source_url: string | null;
    customer_slug: string | null;
    generated_total: number | null;
  }>
> {
  return db()
    .selectFrom('industry_template')
    .selectAll()
    .where('industry', '=', industry)
    .orderBy('version', 'desc')
    .execute();
}

/**
 * List ALL industry_template rows across all industries, ordered by industry
 * then version descending.  Used by the STAFF-ONLY console (P5-T14).
 * Customers never call this; the staff console has no customer_id filter.
 */
export async function listAllIndustryTemplates(): Promise<
  Array<{
    id: string;
    industry: string;
    version: number;
    status: 'draft' | 'reviewed' | 'active';
    questions: unknown;
    competitors: unknown;
    reviewed_by: string | null;
    reviewed_at: Date | null;
    created_at: Date;
    source_url: string | null;
    customer_slug: string | null;
    generated_total: number | null;
  }>
> {
  return db()
    .selectFrom('industry_template')
    .selectAll()
    .orderBy('industry', 'asc')
    .orderBy('version', 'desc')
    .execute();
}

/**
 * Return the latest ACTIVE industry_template for an industry key.
 * There can be at most one active row per industry (enforced by the partial
 * unique index created in 0007_phase1_templatestore.sql).
 * Returns null if no active template exists.
 */
export async function getLatestActiveTemplate(industry: string): Promise<{
  id: string;
  industry: string;
  version: number;
  status: 'draft' | 'reviewed' | 'active';
  questions: unknown;
  competitors: unknown;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  source_url: string | null;
  customer_slug: string | null;
  generated_total: number | null;
  brief_snapshot: unknown | null;
} | null> {
  const row = await db()
    .selectFrom('industry_template')
    .selectAll()
    .where('industry', '=', industry)
    .where('status', '=', 'active')
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Return the next version number for an industry (max existing version + 1).
 * Returns 1 when no rows exist for that industry yet.
 */
export async function nextTemplateVersion(industry: string): Promise<number> {
  const row = await db()
    .selectFrom('industry_template')
    .select(db().fn.max('version').as('max_version'))
    .where('industry', '=', industry)
    .executeTakeFirst();

  // fn.max returns null when there are no rows; coerce to 0 so +1 = 1.
  const maxVersion = row?.['max_version'] ?? null;
  if (maxVersion === null) return 1;
  const parsed = typeof maxVersion === 'number' ? maxVersion : parseInt(maxVersion as string, 10);
  return isNaN(parsed) ? 1 : parsed + 1;
}

/**
 * Update the status of an industry_template row.
 *
 * - When transitioning to 'reviewed': stamps reviewed_by and reviewed_at=now().
 * - When transitioning to 'active':   stamps reviewed_by and reviewed_at=now()
 *   (in case the row was already reviewed but the caller still supplies a
 *   reviewer identity for the audit trail).
 * - When transitioning to 'draft':    clears reviewed_by and reviewed_at.
 *
 * IMPORTANT: activating a template (status='active') requires demoting the
 * prior active row for the same industry FIRST (within the same transaction)
 * so the partial unique index on (industry) WHERE status='active' is never
 * transiently violated. Use demoteActiveTemplate() + updateTemplateStatus()
 * together inside a transaction for that purpose.
 */
export async function updateTemplateStatus(
  id: string,
  status: 'draft' | 'reviewed' | 'active',
  reviewedBy?: string,
  executor?: Kysely<import('./schema.js').Database>,
): Promise<void> {
  const exec = executor ?? db();
  const now = new Date();

  if (status === 'reviewed' || status === 'active') {
    await exec
      .updateTable('industry_template')
      .set({
        status,
        reviewed_by: reviewedBy ?? null,
        reviewed_at: now,
      })
      .where('id', '=', id)
      .execute();
  } else {
    // draft: clear review metadata
    await exec
      .updateTable('industry_template')
      .set({
        status,
        reviewed_by: null,
        reviewed_at: null,
      })
      .where('id', '=', id)
      .execute();
  }
}

/**
 * Demote the currently ACTIVE template for an industry to 'reviewed'.
 *
 * This is a helper used INSIDE an activation transaction so the partial unique
 * index on (industry) WHERE status='active' is satisfied before the new row
 * is promoted to active. It is a no-op when no active row exists.
 *
 * MUST be called within the same DB transaction as the subsequent
 * updateTemplateStatus(newId, 'active') call to guarantee atomicity.
 */
export async function demoteActiveTemplate(
  industry: string,
  executor?: Kysely<import('./schema.js').Database>,
): Promise<void> {
  const exec = executor ?? db();
  await exec
    .updateTable('industry_template')
    .set({ status: 'reviewed' })
    .where('industry', '=', industry)
    .where('status', '=', 'active')
    .execute();
}

/**
 * Insert a new industry_template row (always a new draft).
 */
export async function insertIndustryTemplate(t: {
  industry: string;
  version?: number;
  questions: unknown;
  competitors: unknown;
  status?: 'draft' | 'reviewed' | 'active';
}): Promise<{ id: string }> {
  // version defaults to 1 at the DB level; pass explicitly only if provided.
  // Serialize jsonb columns explicitly — node-postgres would otherwise encode a
  // JS array/object as a Postgres ARRAY literal, causing "invalid input syntax
  // for type json". JSON.stringify + ::jsonb cast fixes both arrays and objects.
  const values: NewIndustryTemplate = {
    industry: t.industry,
    ...(t.version !== undefined ? { version: t.version } : {}),
    questions: sql`${JSON.stringify(t.questions)}::jsonb`,
    competitors: sql`${JSON.stringify(t.competitors)}::jsonb`,
    status: t.status ?? 'draft',
    reviewed_by: null,
    reviewed_at: null,
  };

  const rows = await db()
    .insertInto('industry_template')
    .values(values)
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error(`insertIndustryTemplate: no row returned`);
  return row;
}

// ===========================================================================
// Run
// ===========================================================================

/**
 * Create a new run in 'planned' status.
 * n_total is NOT set here — call snapshotNTotal() after the plan is built.
 */
export async function createRun(r: {
  customerId: string;
  kind: 'baseline' | 'operating';
  nSamples: number;
  temperature: number;
}): Promise<{ id: string }> {
  const values: NewRun = {
    customer_id: r.customerId,
    kind: r.kind,
    status: 'planned',
    n_samples: r.nSamples,
    temperature: String(r.temperature),
    n_total: null,
    started_at: null,
    finished_at: null,
  };

  const rows = await db()
    .insertInto('run')
    .values(values)
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error(`createRun: no row returned`);
  return row;
}

/**
 * Snapshot n_total on the run BEFORE execution begins (§5.2).
 * This freezes the SMR denominator.
 */
export async function snapshotNTotal(runId: string, nTotal: number): Promise<void> {
  await db()
    .updateTable('run')
    .set({ n_total: nTotal })
    .where('id', '=', runId)
    .execute();
}

/**
 * Mark a run as started (transitions planned → running).
 */
export async function startRun(runId: string): Promise<void> {
  await db()
    .updateTable('run')
    .set({ status: 'running', started_at: new Date() })
    .where('id', '=', runId)
    .execute();
}

/**
 * Finish a run with a terminal status.
 */
export async function finishRun(
  runId: string,
  status: 'completed' | 'failed' | 'over_budget',
): Promise<void> {
  await db()
    .updateTable('run')
    .set({ status, finished_at: new Date() })
    .where('id', '=', runId)
    .execute();
}

/**
 * Fetch a run by id.
 */
export async function findRun(runId: string): Promise<{
  id: string;
  customer_id: string;
  kind: 'baseline' | 'operating';
  status: 'planned' | 'running' | 'completed' | 'failed' | 'over_budget';
  n_samples: number;
  temperature: string;
  n_total: number | null;
  planned_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
} | null> {
  const row = await db()
    .selectFrom('run')
    .selectAll()
    .where('id', '=', runId)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Find the most recent run for a customer (any status).
 */
export async function findLatestRun(customerId: string): Promise<{
  id: string;
  kind: 'baseline' | 'operating';
  status: 'planned' | 'running' | 'completed' | 'failed' | 'over_budget';
  planned_at: Date;
  n_total: number | null;
} | null> {
  const row = await db()
    .selectFrom('run')
    .select(['id', 'kind', 'status', 'planned_at', 'n_total'])
    .where('customer_id', '=', customerId)
    .orderBy('planned_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Latest COMPLETED baseline run for a customer (for the public free-diagnostic
 * reuse path — shows the customer's current position without re-running a full
 * baseline cycle). Returns null when no completed baseline exists yet.
 */
export async function findLatestCompletedBaselineRun(
  customerId: string,
): Promise<{ id: string; n_total: number | null; planned_at: Date } | null> {
  const row = await db()
    .selectFrom('run')
    .select(['id', 'n_total', 'planned_at'])
    .where('customer_id', '=', customerId)
    .where('kind', '=', 'baseline')
    .where('status', '=', 'completed')
    .orderBy('planned_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Find a RESUMABLE run — one that a prior cycle left mid-flight (status='running')
 * with pending work-units still to execute, and that is old enough to be certainly
 * dead (no live process). Used so a large baseline whose plan can't finish inside a
 * single CI window (e.g. a multilingual customer with 1000+ work-units under a
 * rate-limited free-tier key) RESUMES and accumulates coverage across cycles instead
 * of spawning a fresh zombie 'running' run every week.
 *
 * Guards:
 *   - status='running' AND n_total>0 (a real, started plan)
 *   - started_at older than `staleBeforeMs` (default 2h > the 120-min CI job timeout,
 *     so we never grab a run that a concurrent job might still be executing)
 *   - has at least one 'pending' work-unit (else it's effectively done → finalize it,
 *     don't resume)
 * Returns the newest such run, or null.
 */
export async function findResumableRun(
  customerId: string,
  kind: 'baseline' | 'operating',
  staleBeforeMs = 2 * 60 * 60 * 1000,
): Promise<{ id: string; nTotal: number } | null> {
  const cutoff = new Date(Date.now() - staleBeforeMs);
  const row = await db()
    .selectFrom('run as r')
    .select(['r.id', 'r.n_total'])
    .where('r.customer_id', '=', customerId)
    .where('r.kind', '=', kind)
    .where('r.status', '=', 'running')
    .where('r.n_total', '>', 0)
    .where('r.started_at', '<', cutoff)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('work_unit as wu')
          .select(sql`1`.as('x'))
          .whereRef('wu.run_id', '=', 'r.id')
          .where('wu.status', '=', 'pending'),
      ),
    )
    .orderBy('r.started_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  if (!row || row.n_total == null) return null;
  return { id: row.id, nTotal: Number(row.n_total) };
}

/**
 * Composite keys of the still-'pending' work-units for a run, as
 * `questionId|modelId|language|sampleIdx` strings. Used by the baseline resume
 * path to execute ONLY the frozen plan's remaining units — filtering the
 * regenerated (deterministic) plan to this set guarantees the SMR numerator can
 * never escape the frozen denominator (§5.2), even if the active-question set
 * changed between cycles, and prevents re-processing already-'done' units.
 */
export async function findPendingWorkUnitKeys(runId: string): Promise<Set<string>> {
  const rows = await db()
    .selectFrom('work_unit')
    .select(['question_id', 'model_id', 'language', 'sample_idx'])
    .where('run_id', '=', runId)
    .where('status', '=', 'pending')
    .execute();
  return new Set(
    rows.map((r) => `${r.question_id}|${r.model_id}|${r.language}|${r.sample_idx}`),
  );
}

// ===========================================================================
// Work Unit
// ===========================================================================

/**
 * Insert a work unit. If the PK already exists, do nothing (idempotent).
 */
export async function insertWorkUnit(wu: {
  runId: string;
  questionId: string;
  modelId: string;
  language: string;
  sampleIdx: number;
}): Promise<void> {
  const values: NewWorkUnit = {
    run_id: wu.runId,
    question_id: wu.questionId,
    model_id: wu.modelId,
    language: wu.language,
    sample_idx: wu.sampleIdx,
    status: 'pending',
    response_raw_id: null,
  };

  await db()
    .insertInto('work_unit')
    .values(values)
    .onConflict((oc) => oc.columns(['run_id', 'question_id', 'model_id', 'language', 'sample_idx']).doNothing())
    .execute();
}

/**
 * Mark a work unit as done and link it to a response_raw_id.
 * Idempotent: if already done, updates the response_raw_id.
 */
export async function markWorkUnitDone(
  runId: string,
  questionId: string,
  modelId: string,
  language: string,
  sampleIdx: number,
  responseRawId: string,
): Promise<void> {
  await db()
    .updateTable('work_unit')
    .set({ status: 'done', response_raw_id: responseRawId })
    .where('run_id', '=', runId)
    .where('question_id', '=', questionId)
    .where('model_id', '=', modelId)
    .where('language', '=', language)
    .where('sample_idx', '=', sampleIdx)
    .execute();
}

/**
 * Mark a work unit as skipped (e.g. cache hit at plan time or NOT_CONFIGURED).
 */
export async function markWorkUnitSkipped(
  runId: string,
  questionId: string,
  modelId: string,
  language: string,
  sampleIdx: number,
): Promise<void> {
  await db()
    .updateTable('work_unit')
    .set({ status: 'skipped' })
    .where('run_id', '=', runId)
    .where('question_id', '=', questionId)
    .where('model_id', '=', modelId)
    .where('language', '=', language)
    .where('sample_idx', '=', sampleIdx)
    .execute();
}

/**
 * Mark a work unit as error.
 */
export async function markWorkUnitError(
  runId: string,
  questionId: string,
  modelId: string,
  language: string,
  sampleIdx: number,
): Promise<void> {
  await db()
    .updateTable('work_unit')
    .set({ status: 'error' })
    .where('run_id', '=', runId)
    .where('question_id', '=', questionId)
    .where('model_id', '=', modelId)
    .where('language', '=', language)
    .where('sample_idx', '=', sampleIdx)
    .execute();
}

/**
 * Fetch all work units for a run (for resume detection).
 */
export async function findWorkUnits(
  runId: string,
): Promise<
  Array<{
    question_id: string;
    model_id: string;
    language: string;
    sample_idx: number;
    status: 'pending' | 'done' | 'skipped' | 'error';
    response_raw_id: string | null;
  }>
> {
  return db()
    .selectFrom('work_unit')
    .select(['question_id', 'model_id', 'language', 'sample_idx', 'status', 'response_raw_id'])
    .where('run_id', '=', runId)
    .execute();
}

/**
 * Count ALL scheduled work-units for a run grouped by (model_id, language,
 * question_id).  Used by aggregate.ts as the per-slice denominator so that
 * errored/skipped units are counted exactly as run.n_total counts them.
 *
 * DESIGN invariant: sum of all returned counts == run.n_total (because
 * work_unit rows are inserted in the plan phase, before any execution, and
 * n_total is snapshotted from workUnits.length at the same time — §5.2).
 */
export async function countWorkUnitsBySlice(runId: string): Promise<
  Array<{
    model_id: string;
    language: string;
    question_id: string;
    count: number;
  }>
> {
  const rows = await db()
    .selectFrom('work_unit')
    .select([
      'model_id',
      'language',
      'question_id',
      db().fn.countAll<string>().as('count'),
    ])
    .where('run_id', '=', runId)
    .groupBy(['model_id', 'language', 'question_id'])
    .execute();

  return rows.map((r) => ({
    model_id: r.model_id,
    language: r.language,
    question_id: r.question_id,
    count: parseInt(r.count as unknown as string, 10),
  }));
}

/**
 * Count work units by status for a run — used by runCycle to detect completion.
 */
export async function countWorkUnitsByStatus(runId: string): Promise<{
  pending: number;
  done: number;
  skipped: number;
  error: number;
}> {
  const rows = await db()
    .selectFrom('work_unit')
    .select([
      db().fn.countAll<string>().as('total'),
      sql<string>`count(*) filter (where status = 'pending')`.as('pending'),
      sql<string>`count(*) filter (where status = 'done')`.as('done'),
      sql<string>`count(*) filter (where status = 'skipped')`.as('skipped'),
      sql<string>`count(*) filter (where status = 'error')`.as('error'),
    ])
    .where('run_id', '=', runId)
    .executeTakeFirst();

  return {
    pending: parseInt(rows?.['pending'] ?? '0', 10),
    done: parseInt(rows?.['done'] ?? '0', 10),
    skipped: parseInt(rows?.['skipped'] ?? '0', 10),
    error: parseInt(rows?.['error'] ?? '0', 10),
  };
}

// ===========================================================================
// Response Cache
// ===========================================================================

/**
 * Look up a cached response by request_hash.
 * Returns null on cache miss.
 *
 * DESIGN: Used for cross-cycle accidental-dup detection ONLY.
 * Intra-cycle samples are NEVER cache-collapsed.
 *
 * Returns created_at so callers can enforce TTL and intra-cycle isolation
 * (require created_at < run.started_at to exclude same-run entries).
 */
export async function lookupResponseCache(
  requestHash: string,
): Promise<{ answer_text: string; created_at: Date } | null> {
  const row = await db()
    .selectFrom('response_cache')
    .select(['answer_text', 'created_at'])
    .where('request_hash', '=', requestHash)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Store a response in the cross-cycle cache.
 * Idempotent — ON CONFLICT DO NOTHING.
 */
export async function insertResponseCache(entry: {
  requestHash: string;
  answerText: string;
}): Promise<void> {
  const values: NewResponseCache = {
    request_hash: entry.requestHash,
    answer_text: entry.answerText,
  };

  await db()
    .insertInto('response_cache')
    .values(values)
    .onConflict((oc) => oc.column('request_hash').doNothing())
    .execute();
}

// ===========================================================================
// Response Raw
// ===========================================================================

/**
 * Insert a response_raw row (hypertable — captured_at must be set).
 * Returns the persisted id and captured_at.
 */
export async function insertResponseRaw(r: {
  runId: string;
  customerId: string;
  questionId: string;
  modelId: string;
  language: string;
  sampleIdx: number;
  temperature: number;
  requestHash: string;
  promptVersion: string;
  answerText: string | null;
  providerMeta: Record<string, unknown> | null;
  status: 'ok' | 'not_configured' | 'error' | 'cached';
  capturedAt?: Date;
}): Promise<{ id: string; captured_at: Date }> {
  const capturedAt = r.capturedAt ?? new Date();

  const values: NewResponseRaw = {
    captured_at: capturedAt,
    run_id: r.runId,
    customer_id: r.customerId,
    question_id: r.questionId,
    model_id: r.modelId,
    language: r.language,
    sample_idx: r.sampleIdx,
    temperature: String(r.temperature),
    request_hash: r.requestHash,
    prompt_version: r.promptVersion,
    answer_text: r.answerText,
    // Serialize jsonb columns explicitly — node-postgres would otherwise encode
    // a JS object/array as a Postgres ARRAY literal, not valid JSON.
    provider_meta: r.providerMeta !== null
      ? sql`${JSON.stringify(r.providerMeta)}::jsonb`
      : null,
    status: r.status,
  };

  const rows = await db()
    .insertInto('response_raw')
    .values(values)
    .returning(['id', 'captured_at'])
    .execute();

  const row = rows[0];
  if (!row) throw new Error(`insertResponseRaw: no row returned`);
  return row;
}

/**
 * Fetch a response_raw by id (scans the hypertable index).
 */
export async function findResponseRaw(responseRawId: string): Promise<{
  id: string;
  captured_at: Date;
  run_id: string;
  customer_id: string;
  question_id: string;
  model_id: string;
  language: string;
  sample_idx: number;
  answer_text: string | null;
  status: 'ok' | 'not_configured' | 'error' | 'cached';
} | null> {
  const row = await db()
    .selectFrom('response_raw')
    .select([
      'id',
      'captured_at',
      'run_id',
      'customer_id',
      'question_id',
      'model_id',
      'language',
      'sample_idx',
      'answer_text',
      'status',
    ])
    .where('id', '=', responseRawId)
    .executeTakeFirst();

  return row ?? null;
}

// ===========================================================================
// Mention Judgment
// ===========================================================================

/**
 * Insert a mention_judgment row.
 * APPEND-ONLY — re-judging appends; current_judgment view selects the latest.
 * Returns the persisted id and captured_at.
 */
export async function insertJudgment(j: {
  responseRawId: string;
  runId: string;
  customerId: string;
  questionId: string;
  modelId: string;
  language: string;
  responseStatus: 'ok' | 'not_configured' | 'error' | 'cached';
  brandMentioned: boolean;
  brandRank: number | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  competitorsFound: Array<{ name: string; rank: number | null }>;
  evidenceQuote: string | null;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  /** Citation channel (MUST #2). Optional — defaults to no-citation when omitted. */
  citationPresent?: boolean;
  citationUrl?: string | null;
  citationQuote?: string | null;
  /** Recommendation channel (R1). Optional — defaults to no-recommendation. */
  recommendationPresent?: boolean;
  recommendationQuote?: string | null;
  provenance: 'judge' | 'fallback' | 'abstain';
  judgeModel: string | null;
  judgeRaw: unknown | null;
  guardrailStatus: 'pass' | 'downgraded_abstain';
  capturedAt?: Date;
}): Promise<{ id: string; captured_at: Date }> {
  const capturedAt = j.capturedAt ?? new Date();

  const values: NewMentionJudgment = {
    captured_at: capturedAt,
    response_raw_id: j.responseRawId,
    run_id: j.runId,
    customer_id: j.customerId,
    question_id: j.questionId,
    model_id: j.modelId,
    language: j.language,
    response_status: j.responseStatus,
    brand_mentioned: j.brandMentioned,
    brand_rank: j.brandRank,
    sentiment: j.sentiment,
    // Serialize jsonb columns explicitly — node-postgres encodes a JS array as a
    // Postgres ARRAY literal (not JSON), causing "invalid input syntax for type json"
    // on every row with >=1 competitor. JSON.stringify + ::jsonb cast fixes both
    // non-empty arrays and empty [] (which node-postgres otherwise binds as {}).
    competitors_found: sql`${JSON.stringify(j.competitorsFound)}::jsonb`,
    evidence_quote: j.evidenceQuote,
    evidence_start: j.evidenceStart,
    evidence_end: j.evidenceEnd,
    citation_present: j.citationPresent ?? false,
    citation_url: j.citationUrl ?? null,
    citation_quote: j.citationQuote ?? null,
    recommendation_present: j.recommendationPresent ?? false,
    recommendation_quote: j.recommendationQuote ?? null,
    provenance: j.provenance,
    judge_model: j.judgeModel,
    judge_raw: j.judgeRaw !== null
      ? sql`${JSON.stringify(j.judgeRaw)}::jsonb`
      : null,
    guardrail_status: j.guardrailStatus,
  };

  const rows = await db()
    .insertInto('mention_judgment')
    .values(values)
    .returning(['id', 'captured_at'])
    .execute();

  const row = rows[0];
  if (!row) throw new Error(`insertJudgment: no row returned`);
  return row;
}

// ===========================================================================
// security_audit (MUST #6) — append-only, hash-chained
// ===========================================================================

/**
 * Append a hash-chained security audit row.
 *
 * Reads the most recent row_hash to chain onto, builds the record via the pure
 * securityAudit domain layer, and inserts. APPEND-ONLY — never updates/deletes.
 *
 * NOTE: the last-hash read + insert is not transactionally serialized; at the
 * very low write rate of security events this is acceptable, and the chain
 * verifier tolerates concurrent inserts by checking link continuity (a true
 * fork would surface as a broken link, which is itself a detectable anomaly).
 */
export async function recordSecurityAudit(
  input: SecurityAuditInput & { requestHash?: string | null },
): Promise<{ id: string; rowHash: string }> {
  const last = await db()
    .selectFrom('security_audit')
    .select('row_hash')
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();

  const prevHash = last?.row_hash ?? AUDIT_GENESIS_HASH;
  const record = buildAuditRecord(prevHash, input);

  const values: NewSecurityAudit = {
    event_type: record.eventType,
    result: record.outcome,
    subject_id: record.subjectId,
    source_ip: record.sourceIp,
    detail: sql`${JSON.stringify(record.detail)}::jsonb`,
    request_hash: input.requestHash ?? null,
    prev_hash: record.prevHash,
    row_hash: record.rowHash,
  };

  const rows = await db()
    .insertInto('security_audit')
    .values(values)
    .returning(['id'])
    .execute();

  const row = rows[0];
  if (!row) throw new Error('recordSecurityAudit: no row returned');
  return { id: row.id, rowHash: record.rowHash };
}

/**
 * Read recent security audit rows (newest first) for ops/compliance review.
 */
export async function listRecentSecurityAudit(
  limit = 100,
  eventType?: SecurityAuditEventType,
): Promise<SecurityAuditRow[]> {
  let q = db().selectFrom('security_audit').selectAll();
  if (eventType !== undefined) q = q.where('event_type', '=', eventType);
  return q.orderBy('occurred_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
}

/**
 * Re-walk the FULL security audit chain (ts ascending) and verify integrity.
 * Returns { ok, brokenAtIndex, reason } — ok=false means a row was edited,
 * deleted, or reordered since it was written.
 */
export async function verifySecurityAuditChain(): Promise<ReturnType<typeof verifyAuditChain>> {
  const rows = await db()
    .selectFrom('security_audit')
    .selectAll()
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const chainRows: AuditChainRow[] = rows.map((r) => ({
    eventType: r.event_type as SecurityAuditEventType,
    outcome: r.result,
    subjectId: r.subject_id,
    sourceIp: r.source_ip,
    detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : (r.detail ?? {})) as Record<string, unknown>,
    prevHash: r.prev_hash,
    rowHash: r.row_hash,
  }));

  return verifyAuditChain(chainRows);
}

/**
 * Read the current (latest) judgment for a response_raw_id via the
 * current_judgment view (DISTINCT ON, latest captured_at wins).
 */
export async function findCurrentJudgment(
  responseRawId: string,
): Promise<CurrentJudgmentRow | null> {
  const row = await db()
    .selectFrom('current_judgment')
    .selectAll()
    .where('response_raw_id', '=', responseRawId)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Read ALL judgments for a response (for audit / history).
 * Returns oldest-first.
 */
export async function findAllJudgments(
  responseRawId: string,
): Promise<CurrentJudgmentRow[]> {
  return db()
    .selectFrom('mention_judgment')
    .selectAll()
    .where('response_raw_id', '=', responseRawId)
    .orderBy('captured_at', 'asc')
    .execute() as unknown as CurrentJudgmentRow[];
}

/**
 * Read all current judgments for a run via the current_judgment view.
 * Used by the metrics aggregator.
 */
export async function findCurrentJudgmentsForRun(
  runId: string,
): Promise<CurrentJudgmentRow[]> {
  return db()
    .selectFrom('current_judgment')
    .selectAll()
    .where('run_id', '=', runId)
    .execute();
}

// ===========================================================================
// LLM Call Ledger
// ===========================================================================

/**
 * Insert an llm_call row for a generation or judge call.
 * usd=0 + cache_hit=true for cache hits; usd=0 for abstains/not_configured.
 */
export async function insertLlmCall(c: {
  /**
   * Nullable for Phase 1 onboarding-time calls that fire before a customer row
   * exists (URL-first diagnosis). Operational (run-scoped) calls always supply a
   * non-null customerId. NULL rows fall into a NULL bucket in cost_daily and are
   * excluded from per-customer budget reads — intentional, global-cap only.
   */
  customerId: string | null;
  /**
   * Nullable for Phase 1 generation calls that have no associated run row.
   * Operational judge calls always supply a non-null runId.
   */
  runId: string | null;
  purpose: 'generation' | 'judge';
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  cacheHit: boolean;
  responseRawId: string | null;
  ts?: Date;
}): Promise<{ id: string }> {
  const ts = c.ts ?? new Date();

  const values: NewLlmCall = {
    ts,
    customer_id: c.customerId,
    run_id: c.runId,
    purpose: c.purpose,
    provider: c.provider,
    model_id: c.modelId,
    input_tokens: c.inputTokens,
    output_tokens: c.outputTokens,
    usd: String(c.usd),
    cache_hit: c.cacheHit,
    response_raw_id: c.responseRawId,
  };

  const rows = await db()
    .insertInto('llm_call')
    .values(values)
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error(`insertLlmCall: no row returned`);
  return row;
}

// ===========================================================================
// Run SMR Overall (view)
// ===========================================================================

/**
 * Read the run_smr_overall aggregated view for a run.
 * Returns null if no judgments exist yet.
 */
export async function findRunSmrOverall(
  runId: string,
): Promise<RunSmrOverallRow | null> {
  const row = await db()
    .selectFrom('run_smr_overall')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirst();

  return row ?? null;
}

// ===========================================================================
// Cost Daily (continuous aggregate)
// ===========================================================================

/**
 * Sum USD spend for a customer over a rolling window (for budget checks).
 *
 * DESIGN: reads from cost_daily (the CAGG), NOT a raw llm_call scan.
 * Fail-closed: if the CAGG has no data, returns null so callers can BLOCK.
 *
 * @param customerId  - customer to aggregate
 * @param since       - start of the rolling window (inclusive)
 * @returns total USD sum or null if no data in the CAGG for this window
 */
export async function sumCostSince(
  customerId: string,
  since: Date,
): Promise<number | null> {
  const row = await db()
    .selectFrom('cost_daily')
    .select(db().fn.sum<string>('usd').as('total_usd'))
    .where('customer_id', '=', customerId)
    .where('day', '>=', since)
    .executeTakeFirst();

  if (!row) return null;
  if (row['total_usd'] === null) return null;

  // pg returns numeric sums as strings
  const parsed = parseFloat(row['total_usd']);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Return true when the customer has at least one llm_call row.
 *
 * DESIGN §11 fail-closed: isNewCustomer should be false for any customer that
 * has prior spend history so that missing CAGG data causes fail-closed, not
 * a silent $0 bypass.  Only the truly first-ever call should bypass fail-closed.
 *
 * @param excludeRunId  Optional run_id to exclude.  Pass the CURRENT run's id on
 *   the async operating path so that sample 0's freshly-written llm_call row is
 *   not seen by siblings in the same run — all samples of a first-ever run must
 *   agree that isNewCustomer=true (§11 fix: async-first-run-isNewCustomer).
 */
export async function customerHasPriorLlmCall(
  customerId: string,
  excludeRunId?: string,
): Promise<boolean> {
  let q = db()
    .selectFrom('llm_call')
    .select('id')
    .where('customer_id', '=', customerId);

  if (excludeRunId !== undefined) {
    q = q.where('run_id', '!=', excludeRunId);
  }

  const row = await q.limit(1).executeTakeFirst();
  return row !== undefined;
}

/**
 * Fetch per-day cost rows for a customer over a window.
 * Used by alerts and dashboards.
 */
export async function findCostDailyRows(
  customerId: string,
  since: Date,
): Promise<Array<{ day: Date; usd: string; calls: string; cache_hits: string }>> {
  return db()
    .selectFrom('cost_daily')
    .select(['day', 'usd', 'calls', 'cache_hits'])
    .where('customer_id', '=', customerId)
    .where('day', '>=', since)
    .orderBy('day', 'asc')
    .execute();
}

// ===========================================================================
// Rotation State
// ===========================================================================

/**
 * Read the rotation cursor for a customer + density tier.
 * Returns 0 if the row does not exist yet (first cycle).
 */
export async function readRotationState(
  customerId: string,
  densityTier: string,
): Promise<number> {
  const row = await db()
    .selectFrom('rotation_state')
    .select('last_cycle_index')
    .where('customer_id', '=', customerId)
    .where('density_tier', '=', densityTier)
    .executeTakeFirst();

  return row?.['last_cycle_index'] ?? 0;
}

/**
 * Advance (upsert) the rotation cursor for a customer + density tier.
 * Sets last_cycle_index to the provided value.
 */
export async function advanceRotationState(
  customerId: string,
  densityTier: string,
  newIndex: number,
): Promise<void> {
  await db()
    .insertInto('rotation_state')
    .values({
      customer_id: customerId,
      density_tier: densityTier,
      last_cycle_index: newIndex,
    })
    .onConflict((oc) =>
      oc
        .columns(['customer_id', 'density_tier'])
        .doUpdateSet({ last_cycle_index: newIndex }),
    )
    .execute();
}

// ===========================================================================
// Phase 2 — Content Set
// ===========================================================================

/**
 * Insert a new content_set row and return its id.
 * Groups all content_asset rows from one generation run.
 */
export async function insertContentSet(s: {
  customerId: string | null;
  industry: string;
  templateId: string;
  templateVersion: number;
  totalUsd?: number | null;
}): Promise<{ id: string }> {
  const values: NewContentSet = {
    customer_id: s.customerId,
    industry: s.industry,
    template_id: s.templateId,
    template_version: s.templateVersion,
    total_usd: s.totalUsd != null ? String(s.totalUsd) : null,
  };

  const rows = await db()
    .insertInto('content_set')
    .values(values)
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error('insertContentSet: no row returned');
  return row;
}

// ===========================================================================
// Phase 2 — Content Asset
// ===========================================================================

/**
 * Insert a single content_asset row.
 *
 * Uses the natural-key UNIQUE index uq_content_asset_natural for idempotency:
 * (content_set_id, phrasing_group_id, format, language, channel_class).
 * ON CONFLICT DO NOTHING — a concurrent run for the same set is a no-op.
 *
 * Returns the persisted id, or null when the ON CONFLICT DO NOTHING path fired.
 */
export async function insertContentAsset(a: {
  contentSetId: string;
  customerId: string | null;
  industry: string;
  templateId: string;
  templateVersion: number;
  contentType: string;
  format: string;
  channelClass: string;
  language: string;
  phrasingGroupId: string;
  body: unknown;
  claims?: unknown;
  wordCount?: number | null;
  gateStatus?: string;
  gateReport?: unknown | null;
  disclosureTag?: string | null;
  needsNativeReview?: boolean;
  regenAttempts?: number;
  provenance?: unknown | null;
}): Promise<{ id: string } | null> {
  const values: NewContentAsset = {
    content_set_id: a.contentSetId,
    customer_id: a.customerId,
    industry: a.industry,
    template_id: a.templateId,
    template_version: a.templateVersion,
    content_type: a.contentType,
    format: a.format,
    channel_class: a.channelClass,
    language: a.language,
    phrasing_group_id: a.phrasingGroupId,
    body: sql`${JSON.stringify(a.body)}::jsonb`,
    claims: sql`${JSON.stringify(a.claims ?? [])}::jsonb`,
    word_count: a.wordCount ?? null,
    gate_status: a.gateStatus ?? 'pending',
    gate_report: a.gateReport != null
      ? sql`${JSON.stringify(a.gateReport)}::jsonb`
      : null,
    disclosure_tag: a.disclosureTag ?? null,
    needs_native_review: a.needsNativeReview ?? false,
    regen_attempts: a.regenAttempts ?? 0,
    provenance: a.provenance != null
      ? sql`${JSON.stringify(a.provenance)}::jsonb`
      : null,
  };

  const rows = await db()
    .insertInto('content_asset')
    .values(values)
    .onConflict((oc) =>
      oc
        .columns(['content_set_id', 'phrasing_group_id', 'format', 'language', 'channel_class'])
        .doNothing(),
    )
    .returning('id')
    .execute();

  return rows[0] ?? null;
}

/**
 * List all content_asset rows for a content_set (all statuses).
 * Ordered by created_at ascending.
 */
export async function listContentAssetsForSet(
  contentSetId: string,
): Promise<ContentAssetRow[]> {
  return db()
    .selectFrom('content_asset')
    .selectAll()
    .where('content_set_id', '=', contentSetId)
    .orderBy('created_at', 'asc')
    .execute();
}

/**
 * List content_asset rows for a set filtered by language.
 * Used by phrasingVariationGate to find same-language siblings for dedup.
 * Ordered by created_at ascending.
 */
export async function listContentAssetsForDedup(
  contentSetId: string,
  language: string,
): Promise<ContentAssetRow[]> {
  return db()
    .selectFrom('content_asset')
    .selectAll()
    .where('content_set_id', '=', contentSetId)
    .where('language', '=', language)
    .orderBy('created_at', 'asc')
    .execute();
}

/**
 * Update the gate_status and gate_report of a content_asset after running gates.
 * Called by assembleContentSet once the runContentGates() fold is complete.
 */
export async function updateAssetGateStatus(
  assetId: string,
  update: {
    gateStatus: 'pending' | 'passed' | 'blocked' | 'needs_human';
    gateReport?: unknown | null;
    claims?: unknown;
  },
): Promise<void> {
  const updateSet: ContentAssetUpdate = {
    gate_status: update.gateStatus,
  };

  if (update.gateReport !== undefined) {
    updateSet.gate_report = update.gateReport != null
      ? sql`${JSON.stringify(update.gateReport)}::jsonb`
      : null;
  }

  if (update.claims !== undefined) {
    updateSet.claims = sql`${JSON.stringify(update.claims)}::jsonb`;
  }

  await db()
    .updateTable('content_asset')
    .set(updateSet)
    .where('id', '=', assetId)
    .execute();
}

/**
 * Queue all gate_status='passed' assets in a content_set that are not yet in
 * content_deploy_queue.  Idempotent via the uq_deploy_queue_asset UNIQUE index
 * (ON CONFLICT DO NOTHING).
 *
 * Returns the number of rows newly inserted into the queue.
 */
export async function queuePassedAssets(
  contentSetId: string,
): Promise<{ queued: number }> {
  // Select passed assets that are not already in the deploy queue.
  const passedAssets = await db()
    .selectFrom('content_asset')
    .select(['id', 'channel_class'])
    .where('content_set_id', '=', contentSetId)
    .where('gate_status', '=', 'passed')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('content_deploy_queue')
            .select('id')
            .whereRef('content_deploy_queue.asset_id', '=', 'content_asset.id'),
        ),
      ),
    )
    .execute();

  if (passedAssets.length === 0) return { queued: 0 };

  const queueValues: NewContentDeployQueue[] = passedAssets.map((a) => ({
    asset_id: a.id,
    channel_class: a.channel_class,
    status: 'queued' as const,
  }));

  // ON CONFLICT DO NOTHING makes this idempotent (uq_deploy_queue_asset).
  await db()
    .insertInto('content_deploy_queue')
    .values(queueValues)
    .onConflict((oc) => oc.column('asset_id').doNothing())
    .execute();

  return { queued: passedAssets.length };
}

// ===========================================================================
// Phase 2 — Claim Source
// ===========================================================================

/**
 * Insert a single claim_source row and return its id.
 */
export async function insertClaimSource(c: {
  customerId: string;
  claimText: string;
  claimKind: 'numeric' | 'capability' | 'superlative' | 'comparative';
  numericValue?: number | null;
  numericUnit?: string | null;
  numericBound?: 'exact' | 'upTo' | 'atLeast' | null;
  sourceKind: 'customer_attested' | 'public_url' | 'third_party_doc';
  sourceRef?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: Date | null;
}): Promise<{ id: string }> {
  const values: NewClaimSource = {
    customer_id: c.customerId,
    claim_text: c.claimText,
    claim_kind: c.claimKind,
    numeric_value: c.numericValue != null ? String(c.numericValue) : null,
    numeric_unit: c.numericUnit ?? null,
    numeric_bound: c.numericBound ?? null,
    source_kind: c.sourceKind,
    source_ref: c.sourceRef ?? null,
    verified_by: c.verifiedBy ?? null,
    verified_at: c.verifiedAt ?? null,
  };

  const rows = await db()
    .insertInto('claim_source')
    .values(values)
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error('insertClaimSource: no row returned');
  return row;
}

// ---------------------------------------------------------------------------
// Simple English superlative/absolute-claim word list used exclusively by
// seedClaimSourcesFromBrief to skip attributes that are unbounded marketing
// claims with no supporting evidence (cannot be seeded as customer_attested).
//
// This list is INTENTIONALLY narrow: it only filters productAttributes that
// are PURELY superlative phrases with no associated numeric evidence. It is
// NOT the per-language superlative lexicon used by the gate (config/content-terms/).
// ---------------------------------------------------------------------------
const SEED_SUPERLATIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bbest\b/i,
  /#1\b/i,                     // "#1" — # is not a word char so no \b before it
  /\bnumber[\s-]?one\b/i,
  /\bmost\b/i,
  /\bgreatest\b/i,
  /\bunmatched\b/i,
  /\bunrivall?ed\b/i,
  /\btop[\s-]rated\b/i,
  /\bindustry[\s-]leading\b/i,
  /\bworld[\s-]class\b/i,
  /\bpremier\b/i,
  /\bunsurpassed\b/i,
  /\bsuperior\b/i,
];

/**
 * Returns true when an attribute string appears to be an unbounded superlative
 * marketing claim with no numeric evidence — such attributes CANNOT be seeded
 * as customer_attested claim_source rows because there is no bound to check.
 */
function isSuperlativeAttribute(attribute: string): boolean {
  return SEED_SUPERLATIVE_PATTERNS.some((rx) => rx.test(attribute));
}

/**
 * Seed claim_source rows from BrandBrief.productAttributes.
 *
 * Non-superlative attributes are inserted as 'customer_attested' rows with
 * verified_by=NULL (awaiting human sign-off via reviewClaims.ts).
 * Superlative/unbounded attributes are skipped (no source row without evidence).
 *
 * Idempotent: existing rows with the same (customer_id, claim_text) are
 * skipped at the application level — we check first and only insert new ones.
 * This avoids the "missing unique index" DB error while keeping the operation
 * safe to call on every run start.
 *
 * Returns the ids of newly inserted rows (skipped rows are not included).
 */
export async function seedClaimSourcesFromBrief(
  customerId: string,
  brief: BrandBrief,
): Promise<Array<{ id: string; claim_text: string }>> {
  const attributes = brief.productAttributes;
  if (!attributes || attributes.length === 0) return [];

  // Fetch existing rows to avoid duplicates (application-level idempotency).
  const existing = await db()
    .selectFrom('claim_source')
    .select(['claim_text'])
    .where('customer_id', '=', customerId)
    .execute();

  const existingTexts = new Set(existing.map((r) => r.claim_text.toLowerCase().trim()));

  const inserted: Array<{ id: string; claim_text: string }> = [];

  for (const attr of attributes) {
    const trimmed = attr.trim();
    if (!trimmed) continue;
    if (isSuperlativeAttribute(trimmed)) continue;
    if (existingTexts.has(trimmed.toLowerCase())) continue;

    const values: NewClaimSource = {
      customer_id: customerId,
      claim_text: trimmed,
      claim_kind: 'capability',
      numeric_value: null,
      numeric_unit: null,
      numeric_bound: null,
      source_kind: 'customer_attested',
      source_ref: null,
      verified_by: null,
      verified_at: null,
    };

    const rows = await db()
      .insertInto('claim_source')
      .values(values)
      .returning(['id', 'claim_text'])
      .execute();

    const row = rows[0];
    if (row) {
      inserted.push(row);
      existingTexts.add(trimmed.toLowerCase());
    }
  }

  return inserted;
}

/**
 * Fetch all claim_source rows for a customer (the registry used by gates).
 * Returns rows ordered by created_at ascending (oldest first).
 */
export async function findClaimSources(
  customerId: string,
): Promise<ClaimSourceRow[]> {
  return db()
    .selectFrom('claim_source')
    .selectAll()
    .where('customer_id', '=', customerId)
    .orderBy('created_at', 'asc')
    .execute();
}

/**
 * Sign a claim_source row (human review sign-off via reviewClaims.ts).
 *
 * Sets verified_by and verified_at=now() on the claim_source row.
 * A signed row is considered externally verified; numeric claims can then
 * pass the claimVerificationGate without needs_human routing.
 *
 * Throws if the row is not found (caller should verify existence first).
 */
export async function signClaimSource(
  id: string,
  verifiedBy: string,
): Promise<void> {
  const result = await db()
    .updateTable('claim_source')
    .set({ verified_by: verifiedBy, verified_at: new Date() })
    .where('id', '=', id)
    .executeTakeFirst();

  if (result.numUpdatedRows === BigInt(0)) {
    throw new Error(`signClaimSource: claim_source row not found for id=${id}`);
  }
}

// ===========================================================================
// Phase 2 — Deploy Queue (read)
// ===========================================================================

/**
 * List all rows in content_deploy_queue for a given asset_id.
 * Used by tests to assert idempotency of queuePassedAssets.
 */
export async function findDeployQueueEntriesForAsset(
  assetId: string,
): Promise<ContentDeployQueueRow[]> {
  return db()
    .selectFrom('content_deploy_queue')
    .selectAll()
    .where('asset_id', '=', assetId)
    .execute();
}

// ===========================================================================
// Phase 3 — Deploy Connector Layer (T05)
// ===========================================================================

// ---------------------------------------------------------------------------
// Stale-lease reaper
// ---------------------------------------------------------------------------

/**
 * Reclaim stale 'leased' queue rows back to 'queued'.
 *
 * A row is stale when leased_at < now() - timeoutMs.  The reaper runs before
 * each dispatch claim so transient worker crashes do not permanently strand rows.
 *
 * Returns the number of rows reclaimed.
 */
export async function reapStaleLeases(timeoutMs: number): Promise<{ reclaimed: number }> {
  const cutoff = new Date(Date.now() - timeoutMs);

  const result = await db()
    .updateTable('content_deploy_queue')
    .set({ status: 'queued', leased_at: null })
    .where('status', '=', 'leased')
    .where('leased_at', '<', cutoff)
    .executeTakeFirst();

  return { reclaimed: Number(result.numUpdatedRows) };
}

// ---------------------------------------------------------------------------
// Throttle helpers — read + increment channel_throttle_state (FOR UPDATE)
// ---------------------------------------------------------------------------

/**
 * Result of a throttle policy + state lookup.
 */
export interface ThrottlePolicyAndState {
  /**
   * channel_throttle row (the policy), or null if no enabled policy exists.
   * null → fail-closed (canPublishNow returns allowed:false in throttle.ts).
   */
  policy: {
    channel_class: string;
    max_per_day: number;
    max_per_week: number;
    min_interval_minutes: number;
    enabled: boolean;
  } | null;
  /**
   * channel_throttle_state row for this (customer_id, channel_class) pair,
   * or null if no counter row exists yet.
   */
  state: {
    id: string;
    customer_id: string | null;
    channel_class: string;
    window_start: Date;
    count: number;
    last_publish_at: Date | null;
  } | null;
}

/**
 * Read the throttle policy for a channel class.
 *
 * Returns null when the channel_throttle row is absent or enabled=false —
 * callers treat null as fail-closed (canPublishNow returns allowed:false).
 */
export async function readThrottlePolicy(channelClass: string): Promise<{
  channel_class: string;
  max_per_day: number;
  max_per_week: number;
  min_interval_minutes: number;
  enabled: boolean;
} | null> {
  const row = await db()
    .selectFrom('channel_throttle')
    .selectAll()
    .where('channel_class', '=', channelClass)
    .where('enabled', '=', true)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Read the throttle state row for a (customerId, channelClass) pair.
 *
 * This is a plain read (no lock); the transactional FOR UPDATE lock happens
 * inside claimNextDeployBatch.  Used by throttle.ts for standalone canPublishNow
 * checks outside of the claim transaction (e.g. dispatch budget estimation).
 *
 * NULL customer_id = generic owned-net assets (the COALESCE NULL bucket).
 */
export async function readThrottleState(
  customerId: string | null,
  channelClass: string,
): Promise<{
  id: string;
  customer_id: string | null;
  channel_class: string;
  window_start: Date;
  count: number;
  week_count: number;
  week_start: Date | null;
  last_publish_at: Date | null;
} | null> {
  // The uq_throttle_state index uses COALESCE(customer_id, zero-uuid).
  // In Kysely we implement the NULL-safe lookup with a WHERE clause:
  //   customer_id IS NULL when customerId is null, else customer_id = customerId.
  let query = db()
    .selectFrom('channel_throttle_state')
    .selectAll()
    .where('channel_class', '=', channelClass);

  if (customerId === null) {
    query = query.where('customer_id', 'is', null);
  } else {
    query = query.where('customer_id', '=', customerId);
  }

  const row = await query.executeTakeFirst();
  return row ?? null;
}

/**
 * Upsert a throttle state row and increment its counter atomically.
 *
 * Called INSIDE the claimNextDeployBatch transaction (the caller holds a
 * FOR UPDATE lock on the row via readThrottleStateForUpdate).
 *
 * windowStart is the start of the current rolling window (midnight UTC today
 * for daily, or monday of this week for weekly — computed by the caller).
 *
 * If a state row already exists for (customerId, channelClass) with a
 * window_start in the same day/week, increment count.  Otherwise insert fresh.
 *
 * This function does NOT lock — it is the counter-increment half; the caller
 * must have already acquired the row lock within the same transaction.
 *
 * Returns the new count.
 */
export async function upsertThrottleStateIncrement(
  executor: Kysely<import('./schema.js').Database>,
  customerId: string | null,
  channelClass: string,
  windowStart: Date,
  publishedAt: Date,
  weekStart: Date,
): Promise<number> {
  // The uq_throttle_state index uses COALESCE(customer_id, zero-uuid).
  // Kysely does not natively support functional-index ON CONFLICT targets, so
  // we use raw SQL for the UPSERT to correctly target that index.
  //
  // Week-count logic (IDEMP-02/THR-01 fix):
  //   - If the existing row's week_start matches weekStart → increment week_count.
  //   - If the existing row's week_start is from a prior week → reset week_count to 1.
  //   - On insert → week_count = 1.
  // This gives accurate weekly accumulation across day-window rollovers.
  const result = await sql<{ count: number }>`
    INSERT INTO channel_throttle_state
      (customer_id, channel_class, window_start, count, week_count, week_start, last_publish_at)
    VALUES
      (${customerId}::uuid, ${channelClass}, ${windowStart}, 1, 1, ${weekStart}, ${publishedAt})
    ON CONFLICT (COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'::uuid), channel_class)
    DO UPDATE SET
      count        = CASE
                       WHEN channel_throttle_state.window_start = ${windowStart}
                       THEN channel_throttle_state.count + 1
                       ELSE 1
                     END,
      week_count   = CASE
                       WHEN channel_throttle_state.week_start = ${weekStart}
                       THEN channel_throttle_state.week_count + 1
                       ELSE 1
                     END,
      last_publish_at = ${publishedAt},
      window_start = ${windowStart},
      week_start   = ${weekStart}
    RETURNING count
  `.execute(executor);

  return result.rows[0]?.count ?? 1;
}

/**
 * Lock and read the throttle state row for UPDATE (within a transaction).
 *
 * Returns null when no counter row exists yet (first publish for this
 * customer+channel pair in the current window).
 *
 * Includes week_count and week_start added by migration 0011 for per-week
 * cap enforcement inside the claim transaction (§7#5 IDEMP-02/THR-01 fix).
 */
export async function readThrottleStateForUpdate(
  executor: Kysely<import('./schema.js').Database>,
  customerId: string | null,
  channelClass: string,
): Promise<{
  id: string;
  customer_id: string | null;
  channel_class: string;
  window_start: Date;
  count: number;
  week_count: number;
  week_start: Date | null;
  last_publish_at: Date | null;
} | null> {
  // FOR UPDATE lock so no concurrent transaction can increment the same counter.
  const row = await sql<{
    id: string;
    customer_id: string | null;
    channel_class: string;
    window_start: Date;
    count: number;
    week_count: number;
    week_start: Date | null;
    last_publish_at: Date | null;
  }>`
    SELECT * FROM channel_throttle_state
    WHERE channel_class = ${channelClass}
    AND ${customerId === null ? sql`customer_id IS NULL` : sql`customer_id = ${customerId}::uuid`}
    FOR UPDATE
  `.execute(executor).then((r) => r.rows[0] ?? null);

  return row;
}

// ---------------------------------------------------------------------------
// claimNextDeployBatch — atomic lease + throttle-check + counter-increment
// ---------------------------------------------------------------------------

/**
 * Enriched queue row returned by claimNextDeployBatch.
 *
 * Includes asset metadata (customer_id, language, phrasing_group_id, industry,
 * disclosure_tag) JOINed from content_asset — the queue row itself has no
 * customer_id and the dispatch/unit handlers need them for throttle + §0 checks.
 */
export interface ClaimedDeployRow {
  /** content_deploy_queue.id */
  queue_id: string;
  /** content_asset.id */
  asset_id: string;
  /** content_asset.channel_class */
  channel_class: string;
  /** content_asset.customer_id (nullable — generic owned-net) */
  customer_id: string | null;
  /** content_asset.language */
  language: string;
  /** content_asset.phrasing_group_id */
  phrasing_group_id: string;
  /** content_asset.industry */
  industry: string;
  /** content_asset.disclosure_tag (nullable) */
  disclosure_tag: string | null;
  /** content_asset.gate_status (should always be 'passed' at this point) */
  gate_status: string;
  /** content_asset.content_set_id */
  content_set_id: string;
  /** content_deploy_queue.approved_by */
  approved_by: string | null;
  /** content_deploy_queue.approved_at */
  approved_at: Date | null;
  /** content_deploy_queue.attempts (after increment) */
  attempts: number;
}

/**
 * Claim a batch of deploy queue rows for a channel atomically.
 *
 * §7#5 / DESIGN-phase3.md §"Naturalness Throttle":
 *   The throttle cap check + counter increment + row lease ALL happen in ONE
 *   transaction with SKIP LOCKED so concurrent dispatchers cannot race to
 *   over-claim beyond the daily cap.
 *
 * Eligibility predicate enforced at claim time:
 *   status='queued' AND approved_by IS NOT NULL AND gate_status='passed' (via JOIN)
 *
 * When throttle budget is exhausted (remainingBudget=0), an empty array is
 * returned — the caller re-queues with delay (§7#5 defer, never drop).
 *
 * IDEMP-02/THR-01 fix: enforces max_per_day, max_per_week, AND min_interval_minutes
 * using canPublishNow-equivalent checks against the locked throttle state row.
 *
 * THR-03/IT-02 fix: when dryRun=true the rows are LEASED for preview but the
 * throttle counter is NOT incremented (dry-run consumes no budget, §7#5 design).
 *
 * @param channelClass        - Target channel class.
 * @param limit               - Maximum rows to claim (bounded by throttle budget).
 * @param throttleWindowStart - Start of the current rolling throttle window
 *   (midnight UTC for daily check). Passed by the caller so the window
 *   boundary is consistent for the entire dispatch tick.
 * @param dryRun              - When true, lease rows but do NOT increment the
 *   throttle counter (previews consume no budget). Default false.
 * @returns The claimed rows enriched with asset metadata, or [] when the
 *   throttle budget is exhausted or no eligible rows exist.
 */
export async function claimNextDeployBatch(
  channelClass: string,
  limit: number,
  throttleWindowStart: Date,
  dryRun = false,
): Promise<ClaimedDeployRow[]> {
  const claimed: ClaimedDeployRow[] = [];

  await db().transaction().execute(async (tx) => {
    // 1. Lock the throttle state row FOR UPDATE (or null if no row yet).
    const throttleState = await readThrottleStateForUpdate(tx, null, channelClass)
      .catch(() => null);

    // 2. Read the full throttle policy (enabled, max_per_day, max_per_week, min_interval).
    const policy = await tx
      .selectFrom('channel_throttle')
      .selectAll()
      .where('channel_class', '=', channelClass)
      .where('enabled', '=', true)
      .executeTakeFirst();

    // Fail-closed: no enabled policy → 0 budget.
    if (!policy) return;

    const now = new Date();

    // ── IDEMP-02/THR-01: enforce ALL THREE constraints (daily, weekly, min_interval) ──
    // Compute week start (Monday 00:00:00 UTC) for weekly cap.
    const weekStart = repoCurrentWeekStart(now);

    const todayCount = (throttleState && throttleState.window_start >= throttleWindowStart)
      ? throttleState.count
      : 0;
    const weekCount = (throttleState && throttleState.week_start != null && throttleState.week_start >= weekStart)
      ? throttleState.week_count
      : 0;

    // ── Daily cap ──────────────────────────────────────────────────────────────
    if (todayCount >= policy.max_per_day) return;

    // ── Weekly cap ─────────────────────────────────────────────────────────────
    if (weekCount >= policy.max_per_week) return;

    // ── Min-interval cadence (burst spacing) ───────────────────────────────────
    if (policy.min_interval_minutes > 0 && throttleState?.last_publish_at) {
      const minIntervalMs = policy.min_interval_minutes * 60 * 1000;
      const nextAllowedAt = new Date(throttleState.last_publish_at.getTime() + minIntervalMs);
      if (now < nextAllowedAt) {
        // Too soon since last publish — defer (return empty).
        return;
      }
    }

    // Compute how many we can still publish this tick (smallest of all caps).
    const dailyRemaining = Math.max(0, policy.max_per_day - todayCount);
    const weeklyRemaining = Math.max(0, policy.max_per_week - weekCount);
    const claimLimit = Math.min(limit, dailyRemaining, weeklyRemaining);

    if (claimLimit === 0) return;

    // 3. Claim rows: UPDATE ... SET status='leased', attempts=attempts+1
    //    WHERE id IN (SELECT ... SKIP LOCKED) RETURNING *.
    //
    //    Eligibility: status='queued' AND approved_by IS NOT NULL.
    //    We also JOIN content_asset to verify gate_status='passed' and get metadata.
    //
    //    Kysely does not support SKIP LOCKED natively, so we use a raw UPDATE
    //    with a subselect.

    const rawRows = await sql<{
      queue_id: string;
      asset_id: string;
      channel_class: string;
      customer_id: string | null;
      language: string;
      phrasing_group_id: string;
      industry: string;
      disclosure_tag: string | null;
      gate_status: string;
      content_set_id: string;
      approved_by: string | null;
      approved_at: Date | null;
      attempts: number;
    }>`
      UPDATE content_deploy_queue cdq
      SET
        status = 'leased',
        leased_at = ${now},
        attempts = cdq.attempts + 1
      FROM (
        SELECT cdq2.id
        FROM content_deploy_queue cdq2
        JOIN content_asset ca ON ca.id = cdq2.asset_id
        WHERE cdq2.status = 'queued'
          AND cdq2.approved_by IS NOT NULL
          AND cdq2.channel_class = ${channelClass}
          AND ca.gate_status = 'passed'
        ORDER BY cdq2.created_at ASC
        FOR UPDATE OF cdq2 SKIP LOCKED
        LIMIT ${claimLimit}
      ) sub
      WHERE cdq.id = sub.id
      RETURNING
        cdq.id           AS queue_id,
        cdq.asset_id,
        cdq.channel_class,
        cdq.approved_by,
        cdq.approved_at,
        cdq.attempts,
        (SELECT ca2.customer_id      FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS customer_id,
        (SELECT ca2.language         FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS language,
        (SELECT ca2.phrasing_group_id FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS phrasing_group_id,
        (SELECT ca2.industry         FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS industry,
        (SELECT ca2.disclosure_tag   FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS disclosure_tag,
        (SELECT ca2.gate_status      FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS gate_status,
        (SELECT ca2.content_set_id   FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS content_set_id
    `.execute(tx);

    if (rawRows.rows.length === 0) {
      return;
    }

    // 4. Increment the throttle counter — ONLY when this is a real (non-dry-run) publish.
    //    THR-03/IT-02 fix: dry-run LEASES rows but must NOT charge the budget counter.
    if (!dryRun) {
      const claimedCount = rawRows.rows.length;
      await sql`
        INSERT INTO channel_throttle_state
          (customer_id, channel_class, window_start, count, week_count, week_start, last_publish_at)
        VALUES
          (NULL, ${channelClass}, ${throttleWindowStart}, ${claimedCount}, ${claimedCount}, ${weekStart}, ${now})
        ON CONFLICT (COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'::uuid), channel_class)
        DO UPDATE SET
          count        = CASE
                           WHEN channel_throttle_state.window_start = ${throttleWindowStart}
                           THEN channel_throttle_state.count + ${claimedCount}
                           ELSE ${claimedCount}
                         END,
          week_count   = CASE
                           WHEN channel_throttle_state.week_start = ${weekStart}
                           THEN channel_throttle_state.week_count + ${claimedCount}
                           ELSE ${claimedCount}
                         END,
          last_publish_at = ${now},
          window_start = ${throttleWindowStart},
          week_start   = ${weekStart}
      `.execute(tx);
    }

    // 5. Collect the claimed rows.
    for (const row of rawRows.rows) {
      claimed.push({
        queue_id: row.queue_id,
        asset_id: row.asset_id,
        channel_class: row.channel_class,
        customer_id: row.customer_id,
        language: row.language,
        phrasing_group_id: row.phrasing_group_id,
        industry: row.industry,
        disclosure_tag: row.disclosure_tag,
        gate_status: row.gate_status,
        content_set_id: row.content_set_id,
        approved_by: row.approved_by,
        approved_at: row.approved_at,
        attempts: row.attempts,
      });
    }
  });

  return claimed;
}

/**
 * Pure helper: midnight UTC of the given date (daily window boundary).
 * Inlined here to avoid a circular import with throttle.ts (which imports from repo.ts).
 */
function repoCurrentWindowStart(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Pure helper: Monday 00:00:00 UTC of the ISO week containing `now`.
 * Inlined here to avoid a circular import with throttle.ts.
 */
function repoCurrentWeekStart(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d;
}

// ---------------------------------------------------------------------------
// Per-customer claimNextDeployBatch variant
// ---------------------------------------------------------------------------

/**
 * Claim a batch scoped to a specific (customerId, channelClass) pair.
 *
 * Used when the dispatch loop needs to respect per-customer throttle budgets
 * independently (so one noisy customer cannot starve another).
 *
 * Mirrors claimNextDeployBatch but filters by customer_id from content_asset
 * and applies the per-customer throttle state row.
 *
 * IDEMP-02/THR-01 fix: enforces max_per_day, max_per_week, AND min_interval_minutes.
 * THR-03/IT-02 fix: when dryRun=true, LEASE rows but do NOT increment the throttle counter.
 * THR-02 fix: dispatch.ts now calls this function per-customer (not claimNextDeployBatch).
 */
export async function claimNextDeployBatchForCustomer(
  channelClass: string,
  customerId: string | null,
  limit: number,
  throttleWindowStart: Date,
  dryRun = false,
): Promise<ClaimedDeployRow[]> {
  const claimed: ClaimedDeployRow[] = [];

  await db().transaction().execute(async (tx) => {
    // 1. Lock per-customer throttle state.
    const throttleState = await readThrottleStateForUpdate(tx, customerId, channelClass)
      .catch(() => null);

    // 2. Read full throttle policy (enabled, max_per_day, max_per_week, min_interval).
    const policy = await tx
      .selectFrom('channel_throttle')
      .selectAll()
      .where('channel_class', '=', channelClass)
      .where('enabled', '=', true)
      .executeTakeFirst();

    // Fail-closed: no enabled policy → 0 budget.
    if (!policy) return;

    const now = new Date();
    const weekStart = repoCurrentWeekStart(now);

    // ── IDEMP-02/THR-01: enforce ALL THREE constraints (daily, weekly, min_interval) ──
    const todayCount = (throttleState && throttleState.window_start >= throttleWindowStart)
      ? throttleState.count
      : 0;
    const weekCount = (throttleState && throttleState.week_start != null && throttleState.week_start >= weekStart)
      ? throttleState.week_count
      : 0;

    // ── Daily cap ──────────────────────────────────────────────────────────────
    if (todayCount >= policy.max_per_day) return;

    // ── Weekly cap ─────────────────────────────────────────────────────────────
    if (weekCount >= policy.max_per_week) return;

    // ── Min-interval cadence (burst spacing) ───────────────────────────────────
    if (policy.min_interval_minutes > 0 && throttleState?.last_publish_at) {
      const minIntervalMs = policy.min_interval_minutes * 60 * 1000;
      const nextAllowedAt = new Date(throttleState.last_publish_at.getTime() + minIntervalMs);
      if (now < nextAllowedAt) {
        return;
      }
    }

    const dailyRemaining = Math.max(0, policy.max_per_day - todayCount);
    const weeklyRemaining = Math.max(0, policy.max_per_week - weekCount);
    const claimLimit = Math.min(limit, dailyRemaining, weeklyRemaining);

    if (claimLimit === 0) return;

    // 3. Claim rows for this specific customer.
    const customerFilter = customerId === null
      ? sql`ca.customer_id IS NULL`
      : sql`ca.customer_id = ${customerId}::uuid`;

    const rawRows = await sql<{
      queue_id: string;
      asset_id: string;
      channel_class: string;
      customer_id: string | null;
      language: string;
      phrasing_group_id: string;
      industry: string;
      disclosure_tag: string | null;
      gate_status: string;
      content_set_id: string;
      approved_by: string | null;
      approved_at: Date | null;
      attempts: number;
    }>`
      UPDATE content_deploy_queue cdq
      SET
        status = 'leased',
        leased_at = ${now},
        attempts = cdq.attempts + 1
      FROM (
        SELECT cdq2.id
        FROM content_deploy_queue cdq2
        JOIN content_asset ca ON ca.id = cdq2.asset_id
        WHERE cdq2.status = 'queued'
          AND cdq2.approved_by IS NOT NULL
          AND cdq2.channel_class = ${channelClass}
          AND ca.gate_status = 'passed'
          AND ${customerFilter}
        ORDER BY cdq2.created_at ASC
        FOR UPDATE OF cdq2 SKIP LOCKED
        LIMIT ${claimLimit}
      ) sub
      WHERE cdq.id = sub.id
      RETURNING
        cdq.id           AS queue_id,
        cdq.asset_id,
        cdq.channel_class,
        cdq.approved_by,
        cdq.approved_at,
        cdq.attempts,
        (SELECT ca2.customer_id       FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS customer_id,
        (SELECT ca2.language          FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS language,
        (SELECT ca2.phrasing_group_id FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS phrasing_group_id,
        (SELECT ca2.industry          FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS industry,
        (SELECT ca2.disclosure_tag    FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS disclosure_tag,
        (SELECT ca2.gate_status       FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS gate_status,
        (SELECT ca2.content_set_id    FROM content_asset ca2 WHERE ca2.id = cdq.asset_id) AS content_set_id
    `.execute(tx);

    if (rawRows.rows.length === 0) return;

    // 4. Increment the throttle counter — ONLY for real (non-dry-run) publishes.
    //    THR-03/IT-02 fix: skip counter mutation when dryRun=true.
    if (!dryRun) {
      const claimedCount = rawRows.rows.length;
      await sql`
        INSERT INTO channel_throttle_state
          (customer_id, channel_class, window_start, count, week_count, week_start, last_publish_at)
        VALUES
          (${customerId}::uuid, ${channelClass}, ${throttleWindowStart}, ${claimedCount}, ${claimedCount}, ${weekStart}, ${now})
        ON CONFLICT (COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'::uuid), channel_class)
        DO UPDATE SET
          count        = CASE
                           WHEN channel_throttle_state.window_start = ${throttleWindowStart}
                           THEN channel_throttle_state.count + ${claimedCount}
                           ELSE ${claimedCount}
                         END,
          week_count   = CASE
                           WHEN channel_throttle_state.week_start = ${weekStart}
                           THEN channel_throttle_state.week_count + ${claimedCount}
                           ELSE ${claimedCount}
                         END,
          last_publish_at = ${now},
          window_start = ${throttleWindowStart},
          week_start   = ${weekStart}
      `.execute(tx);
    }

    for (const row of rawRows.rows) {
      claimed.push({
        queue_id: row.queue_id,
        asset_id: row.asset_id,
        channel_class: row.channel_class,
        customer_id: row.customer_id,
        language: row.language,
        phrasing_group_id: row.phrasing_group_id,
        industry: row.industry,
        disclosure_tag: row.disclosure_tag,
        gate_status: row.gate_status,
        content_set_id: row.content_set_id,
        approved_by: row.approved_by,
        approved_at: row.approved_at,
        attempts: row.attempts,
      });
    }
  });

  return claimed;
}

// ---------------------------------------------------------------------------
// readDistinctCustomersWithQueuedRows — enumerate customers for per-customer dispatch
// ---------------------------------------------------------------------------

/**
 * Return the distinct customer_ids (including null for generic assets) that have
 * eligible (status='queued', approved_by IS NOT NULL, gate_status='passed') rows
 * for the given channel class.
 *
 * Used by dispatch.ts (THR-02 fix) to drive per-customer claim iterations so each
 * customer's throttle state row is locked and incremented independently.
 *
 * @param channelClass - Channel class to query.
 * @returns Array of customer_id values (null = generic NULL-bucket).
 */
export async function readDistinctCustomersWithQueuedRows(
  channelClass: string,
): Promise<Array<string | null>> {
  const rows = await sql<{ customer_id: string | null }>`
    SELECT DISTINCT ca.customer_id
    FROM content_deploy_queue cdq
    JOIN content_asset ca ON ca.id = cdq.asset_id
    WHERE cdq.status = 'queued'
      AND cdq.approved_by IS NOT NULL
      AND cdq.channel_class = ${channelClass}
      AND ca.gate_status = 'passed'
  `.execute(db());

  return rows.rows.map((r) => r.customer_id);
}

// ---------------------------------------------------------------------------
// Human approval
// ---------------------------------------------------------------------------

/**
 * Set approved_by + approved_at on queue rows for an asset (human sign-off).
 *
 * §11/§12: approverIdentity is a non-empty string capturing the approver's
 * identity (e.g. username, email, or system identity) — NOT a bare boolean.
 *
 * Idempotent: calling again with the same assetId + approverIdentity is safe
 * (the row is already approved; the UPDATE is a no-op for rows already approved
 * if called again with the same identity).
 *
 * Returns the number of rows updated (0 if no matching 'queued' row found).
 */
export async function approveDeployRow(
  assetId: string,
  approverIdentity: string,
): Promise<{ updated: number }> {
  const now = new Date();

  const result = await db()
    .updateTable('content_deploy_queue')
    .set({
      approved_by: approverIdentity,
      approved_at: now,
    })
    .where('asset_id', '=', assetId)
    .where('status', 'in', ['queued', 'leased'])
    // Only update rows that are not yet approved, or allow re-approval.
    .executeTakeFirst();

  return { updated: Number(result.numUpdatedRows) };
}

// ---------------------------------------------------------------------------
// Queue row status transitions
// ---------------------------------------------------------------------------

/**
 * Update a content_deploy_queue row's status.
 *
 * Used by publish.unit and publish.dispatch to transition rows through
 * the lifecycle: leased → published | failed | unpublished, or back to queued.
 *
 * Note: 'dry_run' is NOT a queue status (that lives in url_registry only).
 */
export async function markDeployStatus(
  queueId: string,
  status: 'queued' | 'leased' | 'published' | 'failed' | 'unpublished',
): Promise<void> {
  await db()
    .updateTable('content_deploy_queue')
    .set({ status })
    .where('id', '=', queueId)
    .execute();
}

// ---------------------------------------------------------------------------
// url_registry — idempotency claim + publish + dry-run + indexing
// ---------------------------------------------------------------------------

/**
 * Claim the url_registry idempotency slot for a (assetId, channelClass) pair.
 *
 * Inserts a publish_status='publishing' row with ON CONFLICT DO NOTHING.
 * The partial UNIQUE index uq_url_registry_live on (asset_id, channel_class)
 * WHERE publish_status IN ('publishing','published') is the SINGLE arbiter.
 *
 * Returns { claimed: true } when THIS caller won the slot (rows-affected=1).
 * Returns { claimed: false } when another worker already holds the slot
 * (ON CONFLICT fired — the unique violation is NOT a failure, it is a no-op).
 *
 * CLAIM-BEFORE-SIDE-EFFECT: callers MUST check claimed=true before calling
 * connector.publish() so a retried job cannot double-publish an irreversible
 * channel (pr_wire / entity).
 */
export async function claimUrlRegistry(p: {
  assetId: string;
  contentSetId: string | null;
  customerId: string | null;
  channelClass: string;
  /** Placeholder URL written at claim time; updated to the real URL on success. */
  publishedUrl: string;
  disclosureTag: string | null;
  language: string;
  approverAudit: unknown | null;
}): Promise<{ claimed: boolean; registryId: string | null }> {
  try {
    const values: NewUrlRegistry = {
      asset_id: p.assetId,
      content_set_id: p.contentSetId,
      customer_id: p.customerId,
      channel_class: p.channelClass,
      published_url: p.publishedUrl,
      external_ref: null,
      disclosure_tag: p.disclosureTag,
      language: p.language,
      publish_status: 'publishing',
      approver_audit: p.approverAudit != null
        ? sql`${JSON.stringify(p.approverAudit)}::jsonb`
        : null,
      publish_meta: null,
      published_at: null,
    };

    // IDEMP-01/IT-01 fix: the partial unique index uq_url_registry_live is defined
    //   ON (asset_id, channel_class) WHERE publish_status IN ('publishing','published').
    // Postgres requires the ON CONFLICT clause to include the WHERE predicate so it
    // can infer (match) the partial index.  Without the WHERE, PG raises 42P10
    // ("there is no unique or exclusion constraint matching the ON CONFLICT specification")
    // on EVERY insert — making the claim permanently broken.
    //
    // Kysely 0.27 supports .where() on the onConflict builder which compiles to:
    //   ON CONFLICT (asset_id, channel_class) WHERE publish_status IN ('publishing','published')
    //   DO NOTHING
    const rows = await db()
      .insertInto('url_registry')
      .values(values)
      .onConflict((oc) => oc
        .columns(['asset_id', 'channel_class'])
        .where('publish_status', 'in', ['publishing', 'published'])
        .doNothing(),
      )
      .returning('id')
      .execute();

    if (rows.length === 0) {
      // ON CONFLICT DO NOTHING fired — another worker holds the slot.
      return { claimed: false, registryId: null };
    }

    const row = rows[0];
    if (!row) return { claimed: false, registryId: null };
    return { claimed: true, registryId: row.id };
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === '23505') {
      // unique_violation — another worker won the race; treat as no-op.
      return { claimed: false, registryId: null };
    }
    // IDEMP-01/IT-01: surface 42P10 distinctly so a partial-index mismatch never
    // silently falls through.  42P10 means the ON CONFLICT clause does not match
    // any unique/exclusion index — this is always a programming error, not a
    // benign conflict.
    if (pgErr.code === '42P10') {
      throw new Error(
        `claimUrlRegistry: ON CONFLICT clause does not match the partial unique index ` +
        `uq_url_registry_live (PG error 42P10). ` +
        `Ensure the onConflict builder includes the WHERE predicate ` +
        `WHERE publish_status IN ('publishing','published').`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Mark a url_registry row as successfully published.
 *
 * Transitions publish_status from 'publishing' → 'published', stamps
 * published_at, sets the real published_url, external_ref, and publish_meta.
 *
 * Only updates when the row is still 'publishing' (idempotent: if already
 * 'published' by a concurrent worker, the UPDATE is a no-op).
 */
export async function markUrlRegistryPublished(p: {
  registryId: string;
  publishedUrl: string;
  externalRef?: string | null;
  publishMeta?: unknown | null;
}): Promise<void> {
  await db()
    .updateTable('url_registry')
    .set({
      publish_status: 'published',
      published_url: p.publishedUrl,
      external_ref: p.externalRef ?? null,
      published_at: new Date(),
      publish_meta: p.publishMeta != null
        ? sql`${JSON.stringify(p.publishMeta)}::jsonb`
        : null,
    })
    .where('id', '=', p.registryId)
    .where('publish_status', '=', 'publishing')
    .execute();
}

/**
 * Mark a url_registry row as failed.
 *
 * Used when the connector returns a permanent error or eligibility fails
 * after the idempotency claim was made.
 */
export async function markUrlRegistryFailed(registryId: string): Promise<void> {
  await db()
    .updateTable('url_registry')
    .set({ publish_status: 'failed' })
    .where('id', '=', registryId)
    .where('publish_status', '=', 'publishing')
    .execute();
}

/**
 * Insert a url_registry row for a dry-run result.
 *
 * publish_status='dry_run' is EXCLUDED from the idempotency arbiter
 * (uq_url_registry_live WHERE publish_status IN ('publishing','published')),
 * so dry-run rows do NOT consume the idempotency slot — a later real publish
 * can proceed without conflict.
 *
 * Throttle counter is NOT incremented for dry runs (no budget consumed).
 *
 * Returns the new row id.
 */
export async function insertUrlRegistryDryRun(p: {
  assetId: string;
  contentSetId: string | null;
  customerId: string | null;
  channelClass: string;
  plannedUrl: string;
  disclosureTag: string | null;
  language: string;
  approverAudit: unknown | null;
}): Promise<{ registryId: string }> {
  const values: NewUrlRegistry = {
    asset_id: p.assetId,
    content_set_id: p.contentSetId,
    customer_id: p.customerId,
    channel_class: p.channelClass,
    published_url: p.plannedUrl,
    external_ref: null,
    disclosure_tag: p.disclosureTag,
    language: p.language,
    publish_status: 'dry_run',
    approver_audit: p.approverAudit != null
      ? sql`${JSON.stringify(p.approverAudit)}::jsonb`
      : null,
    publish_meta: null,
    published_at: null,
  };

  const rows = await db()
    .insertInto('url_registry')
    .values(values)
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error('insertUrlRegistryDryRun: no row returned');
  return { registryId: row.id };
}

/**
 * Update the indexing_status on a url_registry row.
 *
 * Called by publish.verify after calling connector.confirmIndexing?().
 *
 * NEVER sets indexing_status='indexed' for owned_net FsTarget (the local file
 * is not publicly crawlable; §7#3 / no false signal into the Phase 0 monitor).
 * That constraint is enforced by the caller (verifyIndexing.ts); this function
 * accepts whatever the caller provides.
 *
 * Also stamps first_seen_indexed_at when transitioning to 'indexed' for the
 * first time (for audit / Phase 4 monitoring).
 */
export async function updateIndexingStatus(
  registryId: string,
  indexingStatus: 'unknown' | 'submitted' | 'indexed' | 'not_indexed',
): Promise<void> {
  const now = new Date();

  if (indexingStatus === 'indexed') {
    // Only stamp first_seen_indexed_at if it hasn't been set yet.
    await db()
      .updateTable('url_registry')
      .set({
        indexing_status: indexingStatus,
        first_seen_indexed_at: sql`COALESCE(first_seen_indexed_at, ${now})`,
      })
      .where('id', '=', registryId)
      .execute();
  } else {
    await db()
      .updateTable('url_registry')
      .set({ indexing_status: indexingStatus })
      .where('id', '=', registryId)
      .execute();
  }
}

// ---------------------------------------------------------------------------
// §3 feedback — read-only monitoring surface
// ---------------------------------------------------------------------------

/**
 * List published url_registry rows for the Phase 0/4 monitoring read path.
 *
 * STRICTLY READ-ONLY: this function performs NO writes.  Phase 3 only writes
 * url_registry; the monitoring consumer is DEFERRED to Phase 4.
 *
 * §3 FEEDBACK CONTRACT: Phase 3 delivers the table + this read function.
 * The consumer (Phase 4) reads published URLs for monitoring; Phase 3 does
 * NOT edit cycle.plan, does NOT auto-seed monitoring questions, and does NOT
 * write the measurement context.
 *
 * @param customerId - Filter by customer; omit for all customers.
 * @param since      - Filter rows with published_at >= since; omit for all time.
 * @returns Rows ordered by published_at ascending (oldest first).
 */
export async function listPublishedUrlsForMonitoring(
  customerId?: string | null,
  since?: Date,
): Promise<Array<{
  id: string;
  asset_id: string;
  content_set_id: string | null;
  customer_id: string | null;
  channel_class: string;
  published_url: string;
  external_ref: string | null;
  disclosure_tag: string | null;
  language: string;
  publish_status: string;
  indexing_status: string;
  first_seen_indexed_at: Date | null;
  approver_audit: unknown | null;
  publish_meta: unknown | null;
  published_at: Date | null;
  created_at: Date;
}>> {
  let query = db()
    .selectFrom('url_registry')
    .selectAll()
    .where('publish_status', '=', 'published')
    .orderBy('published_at', 'asc');

  if (customerId !== undefined && customerId !== null) {
    query = query.where('customer_id', '=', customerId);
  }

  if (since !== undefined) {
    query = query.where('published_at', '>=', since);
  }

  return query.execute();
}

/**
 * Fetch a single url_registry row by id.
 * Used by publish.verify to load the row before calling confirmIndexing?.
 */
export async function findUrlRegistryRow(
  registryId: string,
): Promise<UrlRegistryRow | null> {
  const row = await db()
    .selectFrom('url_registry')
    .selectAll()
    .where('id', '=', registryId)
    .executeTakeFirst();

  return row ?? null;
}

// ===========================================================================
// Phase 4 — Surface Scan Queue (migration 0012)
// ===========================================================================

/**
 * Upsert a surface_scan_queue row (keyed on surface_id PK).
 *
 * Idempotent: ON CONFLICT (surface_id) DO UPDATE preserves operator config
 * (enabled flag) when called on a row that already exists.
 *
 * §12 compliance: scrape_allowed is derived from modality — 'serp' surfaces
 * (googleAio, naverAi) are always forced to scrape_allowed=false regardless of
 * any scrapeAllowed argument, enforcing the official-SERP-API-only invariant
 * structurally rather than by convention (see also src/surfaces/compliance.ts).
 */
export async function upsertSurfaceScanQueue(s: {
  surfaceId: string;
  modality: 'serp' | 'scrape';
  scrapeAllowed?: boolean;
  enabled?: boolean;
  nextRunAt?: Date | null;
}): Promise<void> {
  // §12: SERP surfaces must never allow scraping — force false regardless of caller.
  const scrapeAllowed = s.modality === 'serp' ? false : (s.scrapeAllowed ?? true);

  const values: NewSurfaceScanQueue = {
    surface_id: s.surfaceId,
    modality: s.modality,
    scrape_allowed: scrapeAllowed,
    enabled: s.enabled ?? false,
    next_run_at: s.nextRunAt ?? null,
    last_run_at: null,
  };

  await db()
    .insertInto('surface_scan_queue')
    .values(values)
    .onConflict((oc) =>
      oc.column('surface_id').doUpdateSet({
        modality: s.modality,
        scrape_allowed: scrapeAllowed,
        enabled: s.enabled ?? false,
        next_run_at: s.nextRunAt ?? null,
      }),
    )
    .execute();
}

/**
 * Fetch a single surface_scan_queue row by surface_id.
 * Returns null if not found.
 */
export async function findSurfaceScanQueue(
  surfaceId: string,
): Promise<SurfaceScanQueueRow | null> {
  const row = await db()
    .selectFrom('surface_scan_queue')
    .selectAll()
    .where('surface_id', '=', surfaceId)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * List all surface_scan_queue rows (all surfaces, regardless of enabled status).
 * Used by diagnostics and the surface registry.
 */
export async function listSurfaceScanQueue(): Promise<SurfaceScanQueueRow[]> {
  return db()
    .selectFrom('surface_scan_queue')
    .selectAll()
    .orderBy('surface_id', 'asc')
    .execute();
}

/**
 * List enabled surface_scan_queue rows (surfaces ready to run).
 *
 * Returns only rows with enabled=true; disabled (NOT_CONFIGURED) surfaces are
 * excluded.  The surface selection layer (T12) further filters by modality for
 * baseline vs. operating run contexts.
 */
export async function findEnabledSurfaces(): Promise<SurfaceScanQueueRow[]> {
  return db()
    .selectFrom('surface_scan_queue')
    .selectAll()
    .where('enabled', '=', true)
    .orderBy('surface_id', 'asc')
    .execute();
}

/**
 * Mark a surface's last_run_at and optionally schedule the next run.
 *
 * Called by the surface runner (T16) after a successful scan completes.
 * Idempotent when called with the same timestamps.
 */
export async function markSurfaceRanAt(
  surfaceId: string,
  lastRunAt: Date,
  nextRunAt?: Date | null,
): Promise<void> {
  await db()
    .updateTable('surface_scan_queue')
    .set({
      last_run_at: lastRunAt,
      next_run_at: nextRunAt ?? null,
    })
    .where('surface_id', '=', surfaceId)
    .execute();
}

/**
 * Return the modality for a model id from the model table.
 *
 * Used by the sampling planner (T13) to clamp nSamples=1 for non-chat surfaces.
 * Returns 'chat' as a safe default when the row is not found (backward compat).
 */
export async function getModelModality(
  modelId: string,
): Promise<'chat' | 'serp' | 'scrape'> {
  const row = await db()
    .selectFrom('model')
    .select('modality')
    .where('id', '=', modelId)
    .executeTakeFirst();

  const m = row?.modality ?? 'chat';
  if (m === 'serp' || m === 'scrape') return m;
  return 'chat';
}

// ===========================================================================
// Phase 5 — Auth (app_user / app_session)
// ===========================================================================

/**
 * Find an app_user row by email (case-sensitive UNIQUE lookup).
 * Returns null if not found.
 */
export async function findAppUserByEmail(email: string): Promise<AppUserRow | null> {
  const row = await db()
    .selectFrom('app_user')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Create an app_user row.
 * Normally called during seed/invite flows only; the Phase 5 auth surface reads, not creates, user rows.
 */
export async function createAppUser(u: {
  email: string;
  passwordHash: string;
  customerId: string | null;
  role: 'owner' | 'member' | 'staff';
}): Promise<{ id: string }> {
  const values: NewAppUser = {
    email: u.email,
    password_hash: u.passwordHash,
    customer_id: u.customerId,
    role: u.role,
  };

  const rows = await db()
    .insertInto('app_user')
    .values(values)
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error(`createAppUser: no row returned for email=${u.email}`);
  return row;
}

/**
 * Create an app_session row.
 *
 * SECURITY: token_hash is the SHA-256 of the raw opaque token; the raw token is
 * NEVER stored. The caller hashes before passing here.
 *
 * Returns the session id.
 */
export async function createSession(s: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<{ id: string }> {
  const values: NewAppSession = {
    user_id: s.userId,
    token_hash: s.tokenHash,
    expires_at: s.expiresAt,
  };

  const rows = await db()
    .insertInto('app_session')
    .values(values)
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error('createSession: no row returned');
  return row;
}

/**
 * Look up a session by token_hash and check it is not expired.
 *
 * Returns the session row (with user_id) if valid; null if not found or expired.
 * Expired sessions are NOT automatically deleted here — a background sweep can do that.
 */
export async function findSession(tokenHash: string): Promise<AppSessionRow | null> {
  const now = new Date();

  const row = await db()
    .selectFrom('app_session')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .where('expires_at', '>', now)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Delete a session row (logout).
 * Idempotent — no-op if the row is already gone.
 */
export async function deleteSession(tokenHash: string): Promise<void> {
  await db()
    .deleteFrom('app_session')
    .where('token_hash', '=', tokenHash)
    .execute();
}

// ===========================================================================
// Phase 5 — Report Snapshots (report_snapshot / report_delivery)
// ===========================================================================

/**
 * List all report_snapshot rows for a customer, ordered by week_start descending.
 * Returns summary columns only (no report_json to keep the list lightweight).
 */
export async function listReportSnapshots(customerId: string): Promise<
  Array<{
    id: string;
    customer_id: string;
    run_id: string;
    week_start: Date;
    smr: string;
    visibility: string;
    top_sov: string | null;
    abstain_rate: string;
    wow_smr_delta: string | null;
    generated_at: Date;
  }>
> {
  return db()
    .selectFrom('report_snapshot')
    .select([
      'id',
      'customer_id',
      'run_id',
      'week_start',
      'smr',
      'visibility',
      'top_sov',
      'abstain_rate',
      'wow_smr_delta',
      'generated_at',
    ])
    .where('customer_id', '=', customerId)
    .orderBy('week_start', 'desc')
    .execute();
}

/**
 * Fetch a single report_snapshot row by id (INCLUDES report_json and customer_id).
 *
 * The caller MUST check that row.customer_id === session.customerId after receiving
 * this row — returning a 404 on mismatch (no existence leak).
 *
 * Returns null if not found.
 */
export async function getReportSnapshot(id: string): Promise<ReportSnapshotRow | null> {
  const row = await db()
    .selectFrom('report_snapshot')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Insert a report_snapshot row (immutable as-delivered record).
 *
 * UNIQUE(run_id) makes this idempotent — ON CONFLICT DO NOTHING fires when the
 * same run has already been snapshotted (e.g. report.deliver retried).
 *
 * Returns the snapshot id, or null when the row already existed (idempotent path).
 */
export async function insertReportSnapshot(s: {
  customerId: string;
  runId: string;
  weekStart: Date;
  smr: number;
  visibility: number;
  topSov: number | null;
  abstainRate: number;
  wowSmrDelta: number | null;
  reportJson: unknown;
}): Promise<{ id: string } | null> {
  const values: NewReportSnapshot = {
    customer_id: s.customerId,
    run_id: s.runId,
    week_start: s.weekStart,
    smr: String(s.smr),
    visibility: String(s.visibility),
    top_sov: s.topSov != null ? String(s.topSov) : null,
    abstain_rate: String(s.abstainRate),
    wow_smr_delta: s.wowSmrDelta != null ? String(s.wowSmrDelta) : null,
    report_json: sql`${JSON.stringify(s.reportJson)}::jsonb`,
  };

  const rows = await db()
    .insertInto('report_snapshot')
    .values(values)
    .onConflict((oc) => oc.column('run_id').doNothing())
    .returning('id')
    .execute();

  return rows[0] ?? null;
}

/**
 * Find the previous COMPLETED operating run for a customer before a given planned_at.
 *
 * DESIGN: WoW delta uses ONLY completed operating runs (status='completed',
 * kind='operating'). Failed / over_budget / partial runs have different n_total
 * snapshots and would mislead the headline delta.
 *
 * Returns null if no prior completed operating run exists.
 */
export async function findPreviousOperatingRun(
  customerId: string,
  beforePlannedAt: Date,
): Promise<{
  id: string;
  customer_id: string;
  kind: 'baseline' | 'operating';
  status: 'planned' | 'running' | 'completed' | 'failed' | 'over_budget';
  planned_at: Date;
  finished_at: Date | null;
  n_total: number | null;
} | null> {
  const row = await db()
    .selectFrom('run')
    .select(['id', 'customer_id', 'kind', 'status', 'planned_at', 'finished_at', 'n_total'])
    .where('customer_id', '=', customerId)
    .where('kind', '=', 'operating')
    .where('status', '=', 'completed')
    .where('planned_at', '<', beforePlannedAt)
    .orderBy('planned_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Insert a report_delivery row (delivery audit + exactly-once backstop).
 *
 * Exactly-once semantics (post migration 0018):
 * - 'sent' rows: guarded by a PARTIAL UNIQUE index on (snapshot_id, recipient)
 *   WHERE status='sent'.  ON CONFLICT DO NOTHING means a duplicate sent is a
 *   no-op (concurrent delivery race) — returns null.
 * - 'failed' rows: plain insert, NO ON CONFLICT.  A failed row must NOT occupy
 *   the exactly-once slot so that a later successful retry can insert the 'sent'
 *   row.  Multiple failed rows for the same (snapshot, recipient) are allowed
 *   and are useful for the ops audit trail.
 *
 * Returns the new delivery row id, or null when the partial unique fired (already
 * delivered — only possible for 'sent' status).
 */
export async function insertReportDelivery(d: {
  snapshotId: string;
  recipient: string;
  channel?: string;
  status: 'sent' | 'failed';
  sentAt?: Date;
}): Promise<{ id: string } | null> {
  const values: NewReportDelivery = {
    snapshot_id: d.snapshotId,
    recipient: d.recipient,
    channel: d.channel ?? 'email',
    status: d.status,
    sent_at: d.sentAt ?? new Date(),
  };

  if (d.status === 'sent') {
    // Guard by the partial unique index uq_report_delivery_sent (migration 0018):
    //   UNIQUE (snapshot_id, recipient) WHERE status = 'sent'
    // ON CONFLICT DO NOTHING: a concurrent duplicate sent is safe — the first
    // writer wins and both paths result in exactly one 'sent' row.
    //
    // Kysely requires the .where() predicate on the onConflict builder so
    // PostgreSQL can infer (match) the partial index.  Without it PG raises
    // 42P10 ("there is no unique or exclusion constraint matching the ON CONFLICT
    // specification") on every insert — the 42P10 lesson from url_registry.
    const rows = await db()
      .insertInto('report_delivery')
      .values(values)
      .onConflict((oc) =>
        oc
          .columns(['snapshot_id', 'recipient'])
          .where('status', '=', 'sent')
          .doNothing(),
      )
      .returning('id')
      .execute();

    return rows[0] ?? null;
  } else {
    // 'failed': plain insert — never conflicts with a 'sent' row because the
    // partial index only covers status='sent'.  Multiple failure audit rows
    // for the same (snapshot, recipient) are intentional.
    const rows = await db()
      .insertInto('report_delivery')
      .values(values)
      .returning('id')
      .execute();

    return rows[0] ?? null;
  }
}

/**
 * Check whether a report_snapshot already exists for a given run_id.
 * Used by boot catch-up to identify completed runs lacking a snapshot.
 */
export async function findReportSnapshotByRunId(
  runId: string,
): Promise<{ id: string; customer_id: string } | null> {
  const row = await db()
    .selectFrom('report_snapshot')
    .select(['id', 'customer_id'])
    .where('run_id', '=', runId)
    .executeTakeFirst();

  return row ?? null;
}

// ===========================================================================
// Phase 5 — Billing (subscription / invoice / invoice_line)
// ===========================================================================

/**
 * Fetch the subscription row for a customer. Returns null if not found.
 */
export async function getSubscription(customerId: string): Promise<SubscriptionRow | null> {
  const row = await db()
    .selectFrom('subscription')
    .selectAll()
    .where('customer_id', '=', customerId)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Upsert a subscription row for a customer.
 * Uses customer_id PK ON CONFLICT to update plan fields.
 */
export async function upsertSubscription(s: {
  customerId: string;
  planTier: string;
  baseKrw: number;
  status: 'trialing' | 'active' | 'paused' | 'canceled';
  startedAt?: Date;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd?: boolean;
}): Promise<void> {
  const now = new Date();
  const values: NewSubscription = {
    customer_id: s.customerId,
    plan_tier: s.planTier,
    base_krw: String(s.baseKrw),
    status: s.status,
    started_at: s.startedAt ?? now,
    current_period_start: s.currentPeriodStart,
    current_period_end: s.currentPeriodEnd,
    cancel_at_period_end: s.cancelAtPeriodEnd ?? false,
    updated_at: now,
  };

  await db()
    .insertInto('subscription')
    .values(values)
    .onConflict((oc) =>
      oc.column('customer_id').doUpdateSet({
        plan_tier: s.planTier,
        base_krw: String(s.baseKrw),
        status: s.status,
        current_period_start: s.currentPeriodStart,
        current_period_end: s.currentPeriodEnd,
        cancel_at_period_end: s.cancelAtPeriodEnd ?? false,
        updated_at: now,
      }),
    )
    .execute();
}

/**
 * Set cancel_at_period_end = true for a customer's subscription.
 *
 * §1 month-to-month/no-lock-in: access ends at period_end, no immediate data loss.
 * Idempotent — safe to call multiple times.
 */
export async function cancelAtPeriodEnd(customerId: string): Promise<void> {
  await db()
    .updateTable('subscription')
    .set({ cancel_at_period_end: true, updated_at: new Date() })
    .where('customer_id', '=', customerId)
    .execute();
}

/**
 * List invoice rows for a customer, ordered by period_start descending.
 * Returns all statuses (draft, issued, paid, void).
 */
export async function listInvoices(customerId: string): Promise<InvoiceRow[]> {
  return db()
    .selectFrom('invoice')
    .selectAll()
    .where('customer_id', '=', customerId)
    .orderBy('period_start', 'desc')
    .execute();
}

/**
 * Insert an invoice row.
 *
 * UNIQUE(customer_id, period_start, period_end) makes the monthly close idempotent:
 * ON CONFLICT DO NOTHING fires when the same period has already been invoiced.
 *
 * Returns the invoice id, or null on the idempotent conflict path.
 */
export async function insertInvoice(i: {
  customerId: string;
  periodStart: Date;
  periodEnd: Date;
  baseKrw: number;
  usageOverageKrw: number;
  vatKrw: number;
  totalKrw: number;
  status?: 'draft' | 'issued' | 'paid' | 'void';
  issuedAt?: Date | null;
}): Promise<{ id: string } | null> {
  const values: NewInvoice = {
    customer_id: i.customerId,
    period_start: i.periodStart,
    period_end: i.periodEnd,
    base_krw: String(i.baseKrw),
    usage_overage_krw: String(i.usageOverageKrw),
    vat_krw: String(i.vatKrw),
    total_krw: String(i.totalKrw),
    status: i.status ?? 'draft',
    issued_at: i.issuedAt ?? null,
  };

  const rows = await db()
    .insertInto('invoice')
    .values(values)
    .onConflict((oc) =>
      oc.columns(['customer_id', 'period_start', 'period_end']).doNothing(),
    )
    .returning('id')
    .execute();

  return rows[0] ?? null;
}

/**
 * Insert an invoice_line row for a given invoice.
 * Always inserts — no conflict handling (multiple lines per invoice).
 *
 * Returns the line id.
 */
export async function insertInvoiceLine(l: {
  invoiceId: string;
  kind: 'base' | 'overage' | 'human_ops' | 'vat';
  label: string;
  amountKrw: number;
}): Promise<{ id: string }> {
  const values: NewInvoiceLine = {
    invoice_id: l.invoiceId,
    kind: l.kind,
    label: l.label,
    amount_krw: String(l.amountKrw),
  };

  const rows = await db()
    .insertInto('invoice_line')
    .values(values)
    .returning('id')
    .execute();

  const row = rows[0];
  if (!row) throw new Error('insertInvoiceLine: no row returned');
  return row;
}

/**
 * List invoice_line rows for an invoice, ordered by kind then label.
 */
export async function listInvoiceLines(invoiceId: string): Promise<InvoiceLineRow[]> {
  return db()
    .selectFrom('invoice_line')
    .selectAll()
    .where('invoice_id', '=', invoiceId)
    .orderBy('kind', 'asc')
    .orderBy('label', 'asc')
    .execute();
}

/**
 * Sum LLM usage (in USD) for a customer over a billing period, reading from cost_daily CAGG.
 *
 * DESIGN: reads cost_daily (the CAGG), NOT a raw llm_call scan — consistent with
 * sumCostSince. NULL-customer rows are excluded: per §billing design, those are
 * absorbed as overhead and never attributed to any tenant invoice.
 *
 * Returns null when there are no cost_daily rows for the period (fail-closed
 * for callers that need to distinguish "no spend" from "no data").
 */
export async function sumLlmUsageForPeriod(
  customerId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number | null> {
  const row = await db()
    .selectFrom('cost_daily')
    .select(db().fn.sum<string>('usd').as('total_usd'))
    .where('customer_id', '=', customerId)
    .where('day', '>=', periodStart)
    .where('day', '<', periodEnd)
    .executeTakeFirst();

  if (!row) return null;
  if (row['total_usd'] === null) return null;

  const parsed = parseFloat(row['total_usd']);
  return isNaN(parsed) ? null : parsed;
}

// ===========================================================================
// Phase 5 — Fail-closed customer-keyed mutation wrappers
// ===========================================================================

/**
 * Error thrown when a row's owner does not match the session customer.
 *
 * SECURITY: callers MUST catch this and return HTTP 404 (NOT 403) to avoid
 * existence leakage (a 403 would confirm the row exists; 404 is ambiguous).
 */
export class NotOwned extends Error {
  readonly code = 'NOT_OWNED' as const;

  constructor(
    public readonly resourceType: string,
    public readonly resourceId: string,
    public readonly customerId: string,
  ) {
    super(
      `NotOwned: ${resourceType} id=${resourceId} is not owned by customer=${customerId}`,
    );
    this.name = 'NotOwned';
  }
}

/**
 * Fail-closed wrapper: sign a claim_source row ONLY when it belongs to the
 * session customerId.
 *
 * Loads the claim_source row, resolves its owner, and throws NotOwned when:
 *   - The row is not found (treat as not-owned to avoid existence leak).
 *   - The row's customer_id is NULL.
 *   - The row's customer_id !== customerId.
 *
 * Only then calls the Phase-0 primitive signClaimSource(claimId, by).
 *
 * MULTI-TENANT MUST: signClaimSource(id, by) is id-keyed with no customer
 * predicate; without this wrapper a customer could sign another tenant's claim.
 */
export async function signClaimSourceForCustomer(
  claimId: string,
  customerId: string,
  by: string,
): Promise<void> {
  const row = await db()
    .selectFrom('claim_source')
    .select(['id', 'customer_id'])
    .where('id', '=', claimId)
    .executeTakeFirst();

  // Treat not-found as not-owned (no existence leak).
  if (!row) {
    throw new NotOwned('claim_source', claimId, customerId);
  }

  // Fail-closed on NULL owner or owner mismatch.
  if (row.customer_id === null || row.customer_id !== customerId) {
    throw new NotOwned('claim_source', claimId, customerId);
  }

  // Ownership confirmed — call the Phase-0 primitive.
  await signClaimSource(claimId, by);
}

/**
 * Fail-closed wrapper: approve a content_deploy_queue row ONLY when the
 * underlying content_asset belongs to the session customerId.
 *
 * The content_deploy_queue has NO customer_id column; ownership is resolved
 * through the asset_id FK → content_asset.customer_id (which is NULLABLE).
 *
 * Throws NotOwned when:
 *   - The queue row is not found.
 *   - The joined content_asset is not found.
 *   - content_asset.customer_id is NULL (no owner → reject, fail-closed).
 *   - content_asset.customer_id !== customerId.
 *
 * Only then calls the Phase-0 primitive approveDeployRow(assetId, by).
 *
 * MULTI-TENANT MUST: approveDeployRow(assetId, by) is asset-id-keyed with no
 * customer predicate; without this wrapper a customer could approve another
 * tenant's deploy queue entry.
 */
export async function approveDeployRowForCustomer(
  assetId: string,
  customerId: string,
  by: string,
): Promise<{ updated: number }> {
  // Resolve the asset owner via the asset_id.
  const asset = await db()
    .selectFrom('content_asset')
    .select(['id', 'customer_id'])
    .where('id', '=', assetId)
    .executeTakeFirst();

  // Treat not-found as not-owned.
  if (!asset) {
    throw new NotOwned('content_asset', assetId, customerId);
  }

  // Fail-closed on NULL owner — a NULL customer_id means no customer owns it;
  // no customer should be able to approve it through the dashboard.
  if (asset.customer_id === null || asset.customer_id !== customerId) {
    throw new NotOwned('content_asset', assetId, customerId);
  }

  // Ownership confirmed — call the Phase-0 primitive.
  return approveDeployRow(assetId, by);
}
