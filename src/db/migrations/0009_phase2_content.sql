-- =============================================================================
-- 0009_phase2_content.sql — Phase 2 PLAIN tables + budget columns
--
-- ALL tables are PLAIN (no hypertable, no CAGG, no policy/compression DDL),
-- so this migration is fully transactional (no .cjs needed).
-- All operations are idempotent (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
-- Tables created:
--   content_set          — groups one generation run's assets
--   content_asset        — the gated content unit (bounded catalog, not time-series)
--   claim_source         — external provenance registry for §7#2/#7 claim resolution
--   content_deploy_queue — minimal Phase 3 handoff (PROVISIONAL)
--
-- Budget extensions:
--   budget.max_content_assets_per_run — cap on assets per content run
--   budget.max_formats                — cap on format types per run
--   budget.content_run_ceiling_usd    — per-run USD ceiling for content generation
--
-- NATURAL KEY invariant (§7#1 schema):
--   UNIQUE(content_set_id, phrasing_group_id, format, language, channel_class)
--   ensures the same meaning yields DISTINCT (format,language,channel) rows.
--   The ON CONFLICT target uq_content_asset_natural has a matching UNIQUE INDEX
--   (the brand/competitor 42P10 lesson: ON CONFLICT target needs a matching
--   unique index — plain UNIQUE constraint not assumed).
--
-- All CHECKs are SINGLE-TABLE (no cross-table CHECK).
-- content_asset is PLAIN (bounded catalog), so no hypertable partition-column
-- constraint applies; the natural-key UNIQUE index is legal as written.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. content_set — groups one generation run's assets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_set (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid        NULL,
  industry         text        NOT NULL,
  template_id      uuid        NOT NULL,
  template_version int         NOT NULL,
  total_usd        numeric     NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. content_asset — the gated content unit
--
-- gate_status values:
--   pending      — not yet gated
--   passed       — all §7 gates cleared; eligible for Phase 3 queue
--   blocked      — at least one gate hard-blocked (numeric bound exceeded, etc.)
--   needs_human  — requires human review (unresolved superlative/comparative, etc.)
--
-- channel_class enum (§8 deploy-channel families):
--   community/review is intentionally ABSENT — §7#3 structural exclusion.
--
-- content_type / format enums: exact values from the canonical design.
--
-- claims jsonb DEFAULT '[]' encodes §7#2: a bare numeric token with no
--   ClaimRecord is unrepresentable (AnswerBlock.numeric_claim_ids must reference
--   claim_ids stored here).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_asset (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  content_set_id      uuid        NOT NULL,
  customer_id         uuid        NULL,
  industry            text        NOT NULL,
  template_id         uuid        NOT NULL,
  template_version    int         NOT NULL,
  content_type        text        NOT NULL
    CHECK (content_type IN (
      'definition','answer_block','faq','comparison','case_study','jsonld'
    )),
  format              text        NOT NULL
    CHECK (format IN (
      'definition_sentence','answer_block','faq_table','comparison_table',
      'case_study','jsonld_org','jsonld_faqpage','jsonld_article'
    )),
  channel_class       text        NOT NULL
    CHECK (channel_class IN (
      'owned_net','pr_wire','directory','web2','social','entity'
    )),
  language            text        NOT NULL,
  phrasing_group_id   text        NOT NULL,
  body                jsonb       NOT NULL,
  claims              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  word_count          int         NULL,
  gate_status         text        NOT NULL DEFAULT 'pending'
    CHECK (gate_status IN ('pending','passed','blocked','needs_human')),
  gate_report         jsonb       NULL,
  disclosure_tag      text        NULL,
  needs_native_review boolean     NOT NULL DEFAULT false,
  regen_attempts      int         NOT NULL DEFAULT 0,
  provenance          jsonb       NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Natural-key UNIQUE index (the §7#1 schema invariant + ON CONFLICT arbiter).
-- Ensures the same meaning yields DISTINCT (format,language,channel) rows.
-- A concurrent run for the same set collides at the DB layer rather than
-- double-inserting (matches the brand/competitor 42P10 lesson).
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_asset_natural
  ON content_asset (content_set_id, phrasing_group_id, format, language, channel_class);

-- Operational indexes
CREATE INDEX IF NOT EXISTS ix_content_asset_gate
  ON content_asset (gate_status);

CREATE INDEX IF NOT EXISTS ix_content_asset_set
  ON content_asset (content_set_id);

-- ---------------------------------------------------------------------------
-- 3. claim_source — external provenance registry for §7#2/#7 claim resolution
--
-- A customer factual claim is verifiable ONLY if it resolves to a claim_source
-- row here.  Seeded at run start from BrandBrief.productAttributes via
-- repo.seedClaimSourcesFromBrief; grown by reviewClaims.ts human sign-off.
--
-- source_kind:
--   customer_attested — brand-provided fact, awaiting human sign-off
--   public_url        — publicly verifiable URL
--   third_party_doc   — third-party document / audit
--
-- numeric_bound must be one of: exact / upTo / atLeast (or NULL for
--   non-numeric claims).  Bound-check is UNIT/SCALE-NORMALIZED at the app
--   layer (typed {value,unit,bound} compare).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_source (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid        NOT NULL,
  claim_text    text        NOT NULL,
  claim_kind    text        NOT NULL
    CHECK (claim_kind IN ('numeric','capability','superlative','comparative')),
  numeric_value numeric     NULL,
  numeric_unit  text        NULL,
  numeric_bound text        NULL
    CHECK (numeric_bound IS NULL OR numeric_bound IN ('exact','upTo','atLeast')),
  source_kind   text        NOT NULL
    CHECK (source_kind IN ('customer_attested','public_url','third_party_doc')),
  source_ref    text        NULL,
  verified_by   text        NULL,
  verified_at   timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Index for per-customer registry lookups (claim resolution + seeding)
CREATE INDEX IF NOT EXISTS ix_claim_source_customer
  ON claim_source (customer_id);

-- ---------------------------------------------------------------------------
-- 4. content_deploy_queue — minimal Phase 3 handoff (PROVISIONAL)
--
-- Kept deliberately minimal (no scheduling metadata) to avoid speculative
-- coupling to a non-existent Phase 3 connector.
-- Status is intentionally constrained to 'queued' only — Phase 3 owns
-- any transitions beyond this point.
--
-- The uq_deploy_queue_asset UNIQUE index makes queuePassedAssets idempotent:
-- re-queuing an already-queued asset is a no-op at the DB layer.
-- This is the ON CONFLICT arbiter for repo.queuePassedAssets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_deploy_queue (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      uuid        NOT NULL,
  channel_class text        NOT NULL,
  status        text        NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Unique index: one queue entry per asset (idempotency + ON CONFLICT arbiter)
CREATE UNIQUE INDEX IF NOT EXISTS uq_deploy_queue_asset
  ON content_deploy_queue (asset_id);

-- ---------------------------------------------------------------------------
-- 5. budget — additive columns for content generation caps
--
-- budget is a PLAIN table (not a hypertable), so additive columns are legal
-- and safe to roll into this migration.
-- All three columns are nullable (existing rows are unaffected — NULL means
-- "use the env default / no explicit override").
-- ---------------------------------------------------------------------------
ALTER TABLE budget
  ADD COLUMN IF NOT EXISTS max_content_assets_per_run int,
  ADD COLUMN IF NOT EXISTS max_formats                int,
  ADD COLUMN IF NOT EXISTS content_run_ceiling_usd    numeric;
