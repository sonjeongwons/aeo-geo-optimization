/**
 * src/db/schema.ts
 *
 * Kysely Database type — mirrors every table and view from the canonical DDL
 * (0001_dimensions.sql + 0002_hypertables.sql + 0003_views_aggregates.sql).
 *
 * Column names are in snake_case (matching the SQL DDL exactly).
 * Kysely uses this type to provide compile-time safety on all queries.
 *
 * DESIGN notes:
 * - hypertable PKs include the partition column (captured_at / ts) first.
 * - mention_judgment is DENORMALIZED: includes response_status + coords so
 *   SMR aggregation is single-table (no two-hypertable CAGG join).
 * - current_judgment and run_smr_overall are views, included as SELECT-only.
 * - cost_daily is a materialized view (continuous aggregate) — read-only here.
 */

import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UUID column */
type Uuid = string;

/** Numeric / decimal columns come back as string from pg */
type PgNumeric = string;

/** timestamptz comes back as Date from pg */
type Timestamp = ColumnType<Date, Date | string, Date | string>;

/** Generated uuid (server default) — omit on insert */
type GeneratedUuid = ColumnType<Uuid, never, never>;

/** Generated timestamp (server default) — omit on insert */
type GeneratedTimestamp = ColumnType<Date, never, never>;

// ---------------------------------------------------------------------------
// 0001_dimensions.sql — plain relational tables
// ---------------------------------------------------------------------------

export interface CustomerTable {
  id: GeneratedUuid;
  slug: string;
  created_at: GeneratedTimestamp;
}

export interface BrandTable {
  id: GeneratedUuid;
  customer_id: Uuid;
  name: string;
  aliases: string[];
}

export interface CompetitorTable {
  id: GeneratedUuid;
  customer_id: Uuid;
  name: string;
  aliases: string[];
}

export interface QuestionTable {
  id: GeneratedUuid;
  customer_id: Uuid;
  text: string;
  language: string;
  funnel_stage: string | null;
  density_tier: 'core' | 'secondary' | 'longtail';
  active: boolean;
}

export interface ModelTable {
  id: string; // PK is the model id string, e.g. "gemini-2.5-flash"
  provider: string;
  /**
   * Surface modality — added by migration 0012_phase4_surfaces.sql.
   * DEFAULT 'chat' for all pre-Phase-4 rows (backward-compatible).
   * Values mirror the Modality union in src/domain/types.ts: 'chat' | 'serp' | 'scrape'.
   */
  modality: ColumnType<string, string | undefined, string>;
  is_cheap_monitor: boolean;
  is_judge: boolean;
  input_usd_per_mtok: PgNumeric;
  output_usd_per_mtok: PgNumeric;
  enabled: boolean;
}

export interface BudgetTable {
  customer_id: Uuid; // PK + FK
  max_models: number;
  max_samples: number;
  max_languages: number;
  weekly_usd_cap: PgNumeric;
  monthly_usd_cap: PgNumeric;
  // Phase 2 additive columns (migration 0009) — all nullable; NULL = use env default
  max_content_assets_per_run: number | null;
  max_formats: number | null;
  content_run_ceiling_usd: PgNumeric | null;
}

export interface CustomerLanguageTable {
  customer_id: Uuid;
  language: string;
  weight: PgNumeric;
}

export interface IndustryTemplateTable {
  id: GeneratedUuid;
  industry: string;
  /** Server default = 1; omittable on insert. */
  version: ColumnType<number, number | undefined, number>;
  status: 'draft' | 'reviewed' | 'active';
  questions: unknown; // jsonb
  competitors: unknown; // jsonb
  reviewed_by: string | null;
  reviewed_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  // Advisory columns added in 0007_phase1_templatestore.sql (all nullable/additive):
  /** URL that was diagnosed to seed this template, if any. */
  source_url: string | null;
  /** Customer slug that initiated generation, if any. */
  customer_slug: string | null;
  /** Total number of questions generated before dedup/guardrails. */
  generated_total: number | null;
  /**
   * Full diagnosed BrandBrief snapshot (jsonb), added in 0019_brief_snapshot.sql.
   * Carries productAttributes + detectedLanguages so gen-content rebuilds the
   * real multilingual, claim-seeding brief. NULL on legacy rows (scalar fallback).
   */
  brief_snapshot: unknown | null; // jsonb — full BrandBrief
}

export interface RunTable {
  id: GeneratedUuid;
  customer_id: Uuid;
  kind: 'baseline' | 'operating';
  status: 'planned' | 'running' | 'completed' | 'failed' | 'over_budget';
  n_samples: number;
  temperature: PgNumeric;
  /** Snapshotted BEFORE execution. Null until plan phase sets it. */
  n_total: number | null;
  planned_at: GeneratedTimestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

export interface RotationStateTable {
  customer_id: Uuid;
  density_tier: string;
  last_cycle_index: number;
}

export interface WorkUnitTable {
  run_id: Uuid;
  question_id: Uuid;
  model_id: string;
  language: string;
  sample_idx: number;
  status: 'pending' | 'done' | 'skipped' | 'error';
  response_raw_id: Uuid | null;
}

export interface ResponseCacheTable {
  request_hash: string; // PK
  answer_text: string;
  created_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------
// 0009_phase2_content.sql — Phase 2 PLAIN tables (bounded catalog)
// ---------------------------------------------------------------------------

/**
 * content_set — groups one generation run's assets.
 * customer_id is NULL for owned-net generic assets (mirrors llm_call convention).
 */
export interface ContentSetTable {
  id: GeneratedUuid;
  customer_id: Uuid | null;
  industry: string;
  template_id: Uuid;
  template_version: number;
  total_usd: PgNumeric | null;
  created_at: GeneratedTimestamp;
}

/**
 * content_asset — the gated content unit.
 *
 * content_type values: 'definition' | 'answer_block' | 'faq' | 'comparison' | 'case_study' | 'jsonld'
 * format values: 'definition_sentence' | 'answer_block' | 'faq_table' | 'comparison_table' | 'case_study' | 'jsonld_org' | 'jsonld_faqpage' | 'jsonld_article'
 * channel_class values: 'owned_net' | 'pr_wire' | 'directory' | 'web2' | 'social' | 'entity'
 * gate_status values: 'pending' | 'passed' | 'blocked' | 'needs_human'
 *
 * claims jsonb: ClaimRecord[] — a bare numeric without a ClaimRecord is unrepresentable
 *   (§7#2 encoded structurally, AnswerBlock.numeric_claim_ids must reference claim_ids).
 * body jsonb: typed ContentBody discriminated on content_type (see src/content/types.ts).
 * gate_report jsonb: ALL gate verdicts per asset for §12 audit trail.
 * provenance jsonb: {brief_hash, model, generated_at} snapshot.
 */
export interface ContentAssetTable {
  id: GeneratedUuid;
  content_set_id: Uuid;
  customer_id: Uuid | null;
  industry: string;
  template_id: Uuid;
  template_version: number;
  content_type: string;
  format: string;
  channel_class: string;
  language: string;
  phrasing_group_id: string;
  body: unknown; // jsonb — typed ContentBody in app layer
  claims: unknown; // jsonb — ClaimRecord[]
  word_count: number | null;
  gate_status: string;
  gate_report: unknown | null; // jsonb — ContentGateVerdict[]
  disclosure_tag: string | null;
  needs_native_review: boolean;
  regen_attempts: number;
  provenance: unknown | null; // jsonb
  created_at: GeneratedTimestamp;
}

/**
 * claim_source — external provenance registry for §7#2/#7 claim resolution.
 *
 * A customer factual claim is verifiable ONLY if it resolves to a claim_source row.
 * Seeded from BrandBrief.productAttributes via repo.seedClaimSourcesFromBrief;
 * grown by reviewClaims.ts human sign-off.
 *
 * claim_kind: 'numeric' | 'capability' | 'superlative' | 'comparative'
 * source_kind: 'customer_attested' | 'public_url' | 'third_party_doc'
 * numeric_bound: 'exact' | 'upTo' | 'atLeast' | null
 */
export interface ClaimSourceTable {
  id: GeneratedUuid;
  customer_id: Uuid;
  claim_text: string;
  claim_kind: string;
  numeric_value: PgNumeric | null;
  numeric_unit: string | null;
  numeric_bound: string | null;
  source_kind: string;
  source_ref: string | null;
  verified_by: string | null;
  verified_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

/**
 * content_deploy_queue — Phase 3 deploy handoff.
 *
 * Phase 2 created this table with status='queued' only.
 * Migration 0010 widens status and adds approval + lease columns.
 *
 * status values: 'queued' | 'leased' | 'published' | 'failed' | 'unpublished'
 *   ('dry_run' is NOT a queue status; deferral re-queues to 'queued' with delay)
 * approved_by/approved_at: human approver identity (§11/§12 audit trail).
 * uq_deploy_queue_asset makes queuePassedAssets idempotent (ON CONFLICT DO NOTHING).
 */
export interface ContentDeployQueueTable {
  id: GeneratedUuid;
  asset_id: Uuid;
  channel_class: string;
  status: string; // CHECK: 'queued'|'leased'|'published'|'failed'|'unpublished'
  created_at: GeneratedTimestamp;
  // Phase 3 additive columns (migration 0010) — all nullable or have defaults
  leased_at: Timestamp | null;
  /** DEFAULT 0 — omittable on insert; incremented on each dispatch claim. */
  attempts: ColumnType<number, number | undefined, number>;
  approved_by: string | null;
  approved_at: Timestamp | null;
}

// ---------------------------------------------------------------------------
// 0010_phase3_deploy.sql — Phase 3 PLAIN tables (bounded ledger/config)
// ---------------------------------------------------------------------------

/**
 * url_registry — publish ledger + §3/§9 publish-tracking surface.
 *
 * PLAIN table (bounded ledger; kept PLAIN to avoid the hypertable
 * partition-col unique-index rule).
 *
 * publish_status values: 'publishing' | 'published' | 'dry_run' | 'failed' | 'unpublished'
 * indexing_status values: 'unknown' | 'submitted' | 'indexed' | 'not_indexed'
 *   owned_net FsTarget sets 'submitted' at most — NEVER 'indexed' (local file
 *   is not crawlable; §7#3 / idempotency arbiter design).
 *
 * Idempotency arbiter: partial UNIQUE index uq_url_registry_live on
 *   (asset_id, channel_class) WHERE publish_status IN ('publishing','published').
 *   claim-before-side-effect: INSERT publish_status='publishing' with ON CONFLICT
 *   DO NOTHING; proceed to connector only if rows-affected=1.
 *
 * channel_class values: 'owned_net'|'pr_wire'|'directory'|'web2'|'social'|'entity'
 *   (community/review intentionally ABSENT — §7#3 structural exclusion).
 */
export interface UrlRegistryTable {
  id: GeneratedUuid;
  asset_id: Uuid;
  content_set_id: Uuid | null;
  customer_id: Uuid | null;
  channel_class: string; // CHECK mirrors content_asset.channel_class (6 values)
  published_url: string;
  external_ref: string | null;
  disclosure_tag: string | null;
  language: string;
  publish_status: string; // CHECK: 'publishing'|'published'|'dry_run'|'failed'|'unpublished'
  /** DEFAULT 'unknown' — omittable on insert. */
  indexing_status: ColumnType<string, string | undefined, string>; // CHECK: 'unknown'|'submitted'|'indexed'|'not_indexed'
  first_seen_indexed_at: Timestamp | null;
  approver_audit: unknown | null; // jsonb — identity + timestamp from approveDeploy CLI
  publish_meta: unknown | null; // jsonb — connector-specific metadata
  published_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

/**
 * channel_throttle — §7#5 naturalness throttle configuration.
 *
 * PLAIN config table.  One row per channel_class.  Seeded conservatively.
 * enabled=false (or missing row) → fail-closed: canPublishNow returns allowed=false.
 *
 * channel_class is the PK (matches the 6-value content_asset enum).
 */
export interface ChannelThrottleTable {
  channel_class: string; // PK; CHECK: the 6 enum values
  max_per_day: number;
  max_per_week: number;
  min_interval_minutes: number;
  /** DEFAULT true — omittable on insert. */
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
}

/**
 * channel_throttle_state — §7#5 per-(customer, channel) counters.
 *
 * PLAIN counter table.  One row per (customer_id, channel_class) within a
 * rolling window.  customer_id NULL = generic owned-net assets (NULL bucket
 * addressed via COALESCE functional unique index uq_throttle_state).
 *
 * Row-level FOR UPDATE in the claim transaction + SKIP LOCKED prevents the
 * count-then-publish race (§7#5 design; cap check + counter increment + lease
 * all in ONE transaction).
 */
export interface ChannelThrottleStateTable {
  id: GeneratedUuid;
  customer_id: Uuid | null;
  channel_class: string; // CHECK: the 6 enum values
  window_start: Timestamp;
  /** DEFAULT 0 — omittable on insert. Daily publish count for the current window_start day. */
  count: ColumnType<number, number | undefined, number>;
  /**
   * Weekly publish count — accumulated across ALL days in the current ISO week.
   * Resets when the week rolls over (week_start changes).
   * Enforces max_per_week from channel_throttle across calendar-week boundaries
   * (§7#5; the daily count alone cannot represent cross-day weekly totals).
   * Added by migration 0011_throttle_week_count.sql.
   * DEFAULT 0 — omittable on insert.
   */
  week_count: ColumnType<number, number | undefined, number>;
  /** Start of the current ISO week (Monday 00:00:00 UTC) for week_count resets. */
  week_start: Timestamp | null;
  last_publish_at: Timestamp | null;
}

// ---------------------------------------------------------------------------
// 0012_phase4_surfaces.sql — Phase 4 PLAIN tables (bounded queue/config)
// ---------------------------------------------------------------------------

/**
 * surface_scan_queue — scheduling queue for SERP + scrape surfaces.
 *
 * One row per surface.  Tracks readiness, run cadence, and §12 compliance flags.
 *
 * §12 invariant: googleAio + naverAi have scrape_allowed=false (SERP-API-only;
 * may NOT be constructed via RPA runner — encoded by construction in this table
 * and enforced in src/surfaces/compliance.ts).
 *
 * modality: 'serp' | 'scrape' (chat surfaces do not use this queue).
 * enabled: false until the relevant key/runner arrives; skipped by selectEligibleModels.
 * next_run_at: NULL = not yet scheduled (treated as past-due by the scheduler).
 */
export interface SurfaceScanQueueTable {
  surface_id: string; // PK — canonical surface identifier (e.g. 'googleAio', 'copilot')
  modality: string; // CHECK: 'serp' | 'scrape'
  /** false for SERP-API-only surfaces (§12: googleAio + naverAi). DEFAULT true. */
  scrape_allowed: ColumnType<boolean, boolean | undefined, boolean>;
  /** false until the relevant key/runner arrives. DEFAULT false. */
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  next_run_at: Timestamp | null;
  last_run_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------
// 0002_hypertables.sql — time-series (append-only)
// ---------------------------------------------------------------------------

export interface ResponseRawTable {
  /** Hypertable partition column — must be in every INSERT. */
  captured_at: Timestamp;
  /** UUID — NOT a serial; set by app or DB DEFAULT. */
  id: ColumnType<Uuid, Uuid | undefined, never>;
  run_id: Uuid;
  customer_id: Uuid;
  question_id: Uuid;
  model_id: string;
  language: string;
  sample_idx: number;
  temperature: PgNumeric;
  request_hash: string;
  prompt_version: string;
  answer_text: string | null;
  provider_meta: unknown | null; // jsonb
  status: 'ok' | 'not_configured' | 'error' | 'cached';
}

/**
 * mention_judgment — DENORMALIZED: includes response_status + brand coords so
 * SMR aggregation is single-table (no two-hypertable CAGG join required).
 *
 * Re-judging APPENDS a new row; latest-judgment-wins is enforced by the
 * current_judgment DISTINCT ON view.
 *
 * DB CHECK: brand_mentioned = false OR evidence_quote IS NOT NULL
 * (defense-in-depth; the app also enforces this in the evidence-required gate).
 */
export interface MentionJudgmentTable {
  captured_at: Timestamp;
  id: ColumnType<Uuid, Uuid | undefined, never>;
  response_raw_id: Uuid;
  run_id: Uuid;
  customer_id: Uuid;
  question_id: Uuid;
  model_id: string;
  language: string;
  /** Denormalized from response_raw.status */
  response_status: 'ok' | 'not_configured' | 'error' | 'cached';
  brand_mentioned: boolean;
  brand_rank: number | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  /** jsonb: Array<{name: string, rank: number|null}> */
  competitors_found: unknown;
  /** Required when brand_mentioned=true (same-table CHECK + evidence gate). */
  evidence_quote: string | null;
  evidence_start: number | null;
  evidence_end: number | null;
  /**
   * Citation channel (migration 0020 / MUST #2). DEFAULT false at the DB layer so
   * every legacy insert stays valid; true ONLY when the brand is a linked/attributed
   * SOURCE (citation ⊆ mention).
   */
  citation_present: ColumnType<boolean, boolean | undefined, boolean>;
  citation_url: string | null;
  citation_quote: string | null;
  /** Recommendation channel (migration 0022 / R1). DEFAULT false; recommendation ⊆ mention. */
  recommendation_present: ColumnType<boolean, boolean | undefined, boolean>;
  recommendation_quote: string | null;
  provenance: 'judge' | 'fallback' | 'abstain';
  judge_model: string | null;
  judge_raw: unknown | null; // jsonb
  guardrail_status: 'pass' | 'downgraded_abstain';
}

/**
 * security_audit (migration 0021 / MUST #6) — append-only, hash-chained security
 * audit log. No "latest-wins" view: every row is a distinct immutable event.
 */
export interface SecurityAuditTable {
  // DEFAULT now() at the DB layer — optional on insert (never updated).
  occurred_at: ColumnType<Date, Date | string | undefined, never>;
  id: ColumnType<Uuid, Uuid | undefined, never>;
  event_type: string;
  result: 'success' | 'failure' | 'denied';
  subject_id: Uuid | null;
  source_ip: string | null;
  detail: unknown; // jsonb
  request_hash: string | null;
  prev_hash: string;
  row_hash: string;
}

export interface LlmCallTable {
  ts: Timestamp;
  id: ColumnType<Uuid, Uuid | undefined, never>;
  /**
   * Nullable since migration 0008_phase1_llmcall.cjs:
   * URL-first onboarding diagnosis fires before a customer row exists.
   * NULL customer_id rows fall into a NULL bucket in cost_daily and are
   * excluded from per-customer budget reads (intentional — global-cap only).
   */
  customer_id: Uuid | null;
  /**
   * Nullable since migration 0008_phase1_llmcall.cjs:
   * Phase 1 generation calls have no associated run row.
   * run_id has NO FK to run (verified in 0002_hypertables.sql).
   */
  run_id: Uuid | null;
  purpose: 'generation' | 'judge';
  provider: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  usd: PgNumeric;
  cache_hit: boolean;
  response_raw_id: Uuid | null;
}

// ---------------------------------------------------------------------------
// 0003_views_aggregates.sql — read-only views
// ---------------------------------------------------------------------------

/**
 * current_judgment — SELECT DISTINCT ON (response_raw_id) FROM mention_judgment
 * ORDER BY response_raw_id, captured_at DESC.
 * Returns exactly ONE row per response_raw_id (latest judgment wins).
 */
export interface CurrentJudgmentView {
  captured_at: Date;
  id: Uuid;
  response_raw_id: Uuid;
  run_id: Uuid;
  customer_id: Uuid;
  question_id: Uuid;
  model_id: string;
  language: string;
  response_status: 'ok' | 'not_configured' | 'error' | 'cached';
  brand_mentioned: boolean;
  brand_rank: number | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  competitors_found: unknown;
  evidence_quote: string | null;
  evidence_start: number | null;
  evidence_end: number | null;
  citation_present: boolean;
  citation_url: string | null;
  citation_quote: string | null;
  recommendation_present: boolean;
  recommendation_quote: string | null;
  provenance: 'judge' | 'fallback' | 'abstain';
  judge_model: string | null;
  judge_raw: unknown | null;
  guardrail_status: 'pass' | 'downgraded_abstain';
}

/**
 * run_smr_overall — aggregated counts per run_id.
 * Joined to run.n_total by aggregate.ts to compute SMR/Visibility.
 */
export interface RunSmrOverallView {
  run_id: Uuid;
  customer_id: Uuid;
  judged_ok: string; // bigint comes back as string
  brand_hits: string; // bigint comes back as string
  /** citation_hits (migration 0020 / MUST #2) — bigint comes back as string. */
  citation_hits: string;
  /** recommendation_hits (migration 0022 / R1) — bigint comes back as string. */
  recommendation_hits: string;
  inv_rank_sum: string | null; // numeric comes back as string
}

/**
 * cost_daily — continuous aggregate (materialized view) fed by llm_call.
 * Used by budget.ts for rolling spend reads (NOT a raw llm_call scan).
 */
export interface CostDailyView {
  day: Date;
  customer_id: Uuid;
  usd: PgNumeric;
  calls: string; // bigint -> string
  cache_hits: string; // bigint -> string
}

// ---------------------------------------------------------------------------
// Kysely Database interface
// ---------------------------------------------------------------------------

export interface Database {
  // Plain dimension tables
  customer: CustomerTable;
  brand: BrandTable;
  competitor: CompetitorTable;
  question: QuestionTable;
  model: ModelTable;
  budget: BudgetTable;
  customer_language: CustomerLanguageTable;
  industry_template: IndustryTemplateTable;
  run: RunTable;
  rotation_state: RotationStateTable;
  work_unit: WorkUnitTable;
  response_cache: ResponseCacheTable;

  // Phase 2 PLAIN tables (migration 0009)
  content_set: ContentSetTable;
  content_asset: ContentAssetTable;
  claim_source: ClaimSourceTable;
  content_deploy_queue: ContentDeployQueueTable;

  // Phase 3 PLAIN tables (migration 0010)
  url_registry: UrlRegistryTable;
  channel_throttle: ChannelThrottleTable;
  channel_throttle_state: ChannelThrottleStateTable;

  // Phase 4 PLAIN tables (migration 0012)
  surface_scan_queue: SurfaceScanQueueTable;

  // Phase 5 PLAIN tables (migrations 0013-0016)
  app_user: AppUserTable;
  app_session: AppSessionTable;
  subscription: SubscriptionTable;
  invoice: InvoiceTable;
  invoice_line: InvoiceLineTable;
  report_snapshot: ReportSnapshotTable;
  report_delivery: ReportDeliveryTable;

  // Hypertables (append-only)
  response_raw: ResponseRawTable;
  mention_judgment: MentionJudgmentTable;
  llm_call: LlmCallTable;
  security_audit: SecurityAuditTable;

  // Views (SELECT only)
  current_judgment: CurrentJudgmentView;
  run_smr_overall: RunSmrOverallView;
  cost_daily: CostDailyView;
}

// ---------------------------------------------------------------------------
// Convenience type aliases (Kysely Selectable/Insertable/Updateable helpers)
// ---------------------------------------------------------------------------

export type CustomerRow = Selectable<CustomerTable>;
export type NewCustomer = Insertable<CustomerTable>;

export type BrandRow = Selectable<BrandTable>;
export type NewBrand = Insertable<BrandTable>;

export type CompetitorRow = Selectable<CompetitorTable>;
export type NewCompetitor = Insertable<CompetitorTable>;

export type QuestionRow = Selectable<QuestionTable>;
export type NewQuestion = Insertable<QuestionTable>;

export type ModelRow = Selectable<ModelTable>;
export type NewModel = Insertable<ModelTable>;

export type BudgetRow = Selectable<BudgetTable>;
export type NewBudget = Insertable<BudgetTable>;

export type CustomerLanguageRow = Selectable<CustomerLanguageTable>;
export type NewCustomerLanguage = Insertable<CustomerLanguageTable>;

export type IndustryTemplateRow = Selectable<IndustryTemplateTable>;
export type NewIndustryTemplate = Insertable<IndustryTemplateTable>;

export type RunRow = Selectable<RunTable>;
export type NewRun = Insertable<RunTable>;
export type RunUpdate = Updateable<RunTable>;

export type RotationStateRow = Selectable<RotationStateTable>;

export type WorkUnitRow = Selectable<WorkUnitTable>;
export type NewWorkUnit = Insertable<WorkUnitTable>;

export type ResponseCacheRow = Selectable<ResponseCacheTable>;
export type NewResponseCache = Insertable<ResponseCacheTable>;

export type ResponseRawRow = Selectable<ResponseRawTable>;
export type NewResponseRaw = Insertable<ResponseRawTable>;

export type MentionJudgmentRow = Selectable<MentionJudgmentTable>;
export type NewMentionJudgment = Insertable<MentionJudgmentTable>;

export type SecurityAuditRow = Selectable<SecurityAuditTable>;
export type NewSecurityAudit = Insertable<SecurityAuditTable>;

export type LlmCallRow = Selectable<LlmCallTable>;
export type NewLlmCall = Insertable<LlmCallTable>;

export type CurrentJudgmentRow = Selectable<CurrentJudgmentView>;
export type RunSmrOverallRow = Selectable<RunSmrOverallView>;
export type CostDailyRow = Selectable<CostDailyView>;

// ---------------------------------------------------------------------------
// Phase 2 type aliases (migration 0009)
// ---------------------------------------------------------------------------

export type ContentSetRow = Selectable<ContentSetTable>;
export type NewContentSet = Insertable<ContentSetTable>;

export type ContentAssetRow = Selectable<ContentAssetTable>;
export type NewContentAsset = Insertable<ContentAssetTable>;
export type ContentAssetUpdate = Updateable<ContentAssetTable>;

export type ClaimSourceRow = Selectable<ClaimSourceTable>;
export type NewClaimSource = Insertable<ClaimSourceTable>;
export type ClaimSourceUpdate = Updateable<ClaimSourceTable>;

export type ContentDeployQueueRow = Selectable<ContentDeployQueueTable>;
export type NewContentDeployQueue = Insertable<ContentDeployQueueTable>;
export type ContentDeployQueueUpdate = Updateable<ContentDeployQueueTable>;

// ---------------------------------------------------------------------------
// Phase 3 type aliases (migration 0010)
// ---------------------------------------------------------------------------

export type UrlRegistryRow = Selectable<UrlRegistryTable>;
export type NewUrlRegistry = Insertable<UrlRegistryTable>;
export type UrlRegistryUpdate = Updateable<UrlRegistryTable>;

export type ChannelThrottleRow = Selectable<ChannelThrottleTable>;
export type NewChannelThrottle = Insertable<ChannelThrottleTable>;
export type ChannelThrottleUpdate = Updateable<ChannelThrottleTable>;

export type ChannelThrottleStateRow = Selectable<ChannelThrottleStateTable>;
export type NewChannelThrottleState = Insertable<ChannelThrottleStateTable>;
export type ChannelThrottleStateUpdate = Updateable<ChannelThrottleStateTable>;

// ---------------------------------------------------------------------------
// Phase 4 type aliases (migration 0012)
// ---------------------------------------------------------------------------

export type SurfaceScanQueueRow = Selectable<SurfaceScanQueueTable>;
export type NewSurfaceScanQueue = Insertable<SurfaceScanQueueTable>;
export type SurfaceScanQueueUpdate = Updateable<SurfaceScanQueueTable>;

// ---------------------------------------------------------------------------
// Phase 5 PLAIN tables (migrations 0013–0016)
// ---------------------------------------------------------------------------

/**
 * app_user — multi-tenant user table; staff users have customer_id = NULL.
 *
 * role values: 'owner' | 'member' | 'staff'
 * Constraint app_user_scope_chk: non-staff users MUST be scoped to a customer.
 * Staff (role='staff', customer_id NULL) may act across customers for ops/templates.
 */
export interface AppUserTable {
  id:            GeneratedUuid;
  email:         string;          // UNIQUE NOT NULL
  password_hash: string;
  /** NULL for internal staff (cross-customer ops). */
  customer_id:   Uuid | null;
  role:          'owner' | 'member' | 'staff';
  created_at:    GeneratedTimestamp;
}

/**
 * app_session — opaque-token sessions (httpOnly cookie, SHA-256 hash stored).
 *
 * token_hash is UNIQUE; raw token never persisted.
 */
export interface AppSessionTable {
  id:         GeneratedUuid;
  user_id:    Uuid;
  /** SHA-256 hex of the raw opaque cookie token. */
  token_hash: string;
  expires_at: Timestamp;
  created_at: GeneratedTimestamp;
}

/**
 * subscription — one row per customer; tracks plan + billing period.
 *
 * status values: 'trialing' | 'active' | 'paused' | 'canceled'
 * cancel_at_period_end: access ends at period_end; no immediate data loss.
 */
export interface SubscriptionTable {
  customer_id:          Uuid;   // PK + FK
  plan_tier:            string;
  base_krw:             PgNumeric;
  status:               'trialing' | 'active' | 'paused' | 'canceled';
  started_at:           Timestamp;
  current_period_start: Timestamp;
  current_period_end:   Timestamp;
  cancel_at_period_end: boolean;
  updated_at:           Timestamp;
}

/**
 * invoice — monthly billing record per customer.
 *
 * UNIQUE(customer_id, period_start, period_end) makes monthly close idempotent.
 * All amounts in KRW; §1 'VAT 별도' is explicit (vat_krw column).
 * usage_overage_krw reflects margin + USD→KRW FX, NOT raw llm_call.usd.
 *
 * status values: 'draft' | 'issued' | 'paid' | 'void'
 */
export interface InvoiceTable {
  id:                GeneratedUuid;
  customer_id:       Uuid;
  period_start:      Timestamp;
  period_end:        Timestamp;
  base_krw:          PgNumeric;
  usage_overage_krw: PgNumeric;
  vat_krw:           PgNumeric;
  total_krw:         PgNumeric;
  status:            'draft' | 'issued' | 'paid' | 'void';
  issued_at:         Timestamp | null;
  created_at:        GeneratedTimestamp;
}

/**
 * invoice_line — individual line items within an invoice.
 *
 * kind values: 'base' | 'overage' | 'human_ops' | 'vat'
 * 'overage' includes margin + FX layering; 'human_ops' is manually entered.
 * 'vat' is the §1 VAT-별도 tax line (BHB-3: never labelled 'base').
 * The DB CHECK is extended by migration 0017_invoice_line_vat_kind.sql.
 */
export interface InvoiceLineTable {
  id:         GeneratedUuid;
  invoice_id: Uuid;
  kind:       'base' | 'overage' | 'human_ops' | 'vat';
  label:      string;
  amount_krw: PgNumeric;
}

/**
 * report_snapshot — IMMUTABLE as-delivered weekly report.
 *
 * report_json = the literal RunReport jsonb at delivery time; never updated.
 * Trends and emailed links render this snapshot so numbers never drift on re-judge.
 * UNIQUE(run_id): one snapshot per run (idempotent delivery backstop).
 * week_start: derived from run.finished_at / planned_at (no run.week_start column).
 */
export interface ReportSnapshotTable {
  id:            GeneratedUuid;
  customer_id:   Uuid;
  /** References run.id — no FK declared (run referenced app-side). */
  run_id:        Uuid;
  week_start:    Timestamp;
  smr:           PgNumeric;
  visibility:    PgNumeric;
  top_sov:       PgNumeric | null;
  abstain_rate:  PgNumeric;
  /** WoW delta vs previous COMPLETED operating run; NULL if no prior completed run. */
  wow_smr_delta: PgNumeric | null;
  /** The literal RunReport at delivery time — immutable. */
  report_json:   unknown;   // jsonb — RunReport shape
  generated_at:  GeneratedTimestamp;
}

/**
 * report_delivery — delivery audit + exactly-once idempotency backstop.
 *
 * UNIQUE(snapshot_id, recipient): prevents double-send per recipient per snapshot.
 * status values: 'sent' | 'failed'
 */
export interface ReportDeliveryTable {
  id:          GeneratedUuid;
  snapshot_id: Uuid;
  recipient:   string;
  channel:     string;  // DEFAULT 'email'
  status:      'sent' | 'failed';
  sent_at:     Timestamp;
}

// ---------------------------------------------------------------------------
// Phase 5 type aliases (migrations 0013-0016)
// ---------------------------------------------------------------------------

export type AppUserRow = Selectable<AppUserTable>;
export type NewAppUser = Insertable<AppUserTable>;
export type AppUserUpdate = Updateable<AppUserTable>;

export type AppSessionRow = Selectable<AppSessionTable>;
export type NewAppSession = Insertable<AppSessionTable>;

export type SubscriptionRow = Selectable<SubscriptionTable>;
export type NewSubscription = Insertable<SubscriptionTable>;
export type SubscriptionUpdate = Updateable<SubscriptionTable>;

export type InvoiceRow = Selectable<InvoiceTable>;
export type NewInvoice = Insertable<InvoiceTable>;
export type InvoiceUpdate = Updateable<InvoiceTable>;

export type InvoiceLineRow = Selectable<InvoiceLineTable>;
export type NewInvoiceLine = Insertable<InvoiceLineTable>;

export type ReportSnapshotRow = Selectable<ReportSnapshotTable>;
export type NewReportSnapshot = Insertable<ReportSnapshotTable>;

export type ReportDeliveryRow = Selectable<ReportDeliveryTable>;
export type NewReportDelivery = Insertable<ReportDeliveryTable>;
