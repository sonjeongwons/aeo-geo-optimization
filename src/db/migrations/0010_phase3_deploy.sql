-- =============================================================================
-- 0010_phase3_deploy.sql — Phase 3 PLAIN tables + ALTER content_deploy_queue
--
-- ALL tables are PLAIN (no hypertable, no CAGG, no policy/compression DDL),
-- so this migration is fully transactional (no .cjs needed).
-- All operations are idempotent (CREATE ... IF NOT EXISTS /
-- ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS).
--
-- Tables created:
--   url_registry          — publish ledger + §3/§9 tracking surface (PLAIN,
--                           bounded ledger; kept PLAIN to avoid the hypertable
--                           partition-col unique-index rule)
--   channel_throttle      — §7#5 naturalness throttle config (PLAIN, seeded)
--   channel_throttle_state — §7#5 per-(customer, channel) counters (PLAIN)
--
-- Tables altered:
--   content_deploy_queue  — ADD approval columns; widen status CHECK
--
-- Idempotency arbiter:
--   uq_url_registry_live  — PARTIAL UNIQUE on (asset_id, channel_class)
--                           WHERE publish_status IN ('publishing','published')
--                           This is the SINGLE canonical arbiter that prevents
--                           double-publish: claim the 'publishing' row first
--                           with ON CONFLICT DO NOTHING; only the winner calls
--                           the connector.  dry_run/failed/unpublished are
--                           EXCLUDED so previews and retries coexist freely.
--
-- §7#3 structural exclusion:
--   channel_class CHECK in url_registry and channel_throttle includes exactly
--   the 6 enum values from content_asset (owned_net, pr_wire, directory, web2,
--   social, entity).  community/review are intentionally ABSENT.
--
-- All CHECKs are SINGLE-TABLE (no cross-table CHECK).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. url_registry — publish ledger + §3/§9 publish-tracking surface
--
-- Columns:
--   id              — uuid PK
--   asset_id        — FK to content_asset (not enforced by FK here to avoid
--                     cross-table coupling; enforced at app layer)
--   content_set_id  — denormalized for monitoring queries; nullable (generic)
--   customer_id     — copied from content_asset at publish; NULL = generic
--   channel_class   — the deploy channel (6-value enum, mirrors content_asset)
--   published_url   — OUR hub or external channel URL (NEVER customer domain)
--   external_ref    — channel-specific reference handle (e.g. PR-wire ID)
--   disclosure_tag  — carried from content_asset for §7#6 audit; nullable
--   language        — BCP-47 language code
--   publish_status  — lifecycle state
--   indexing_status — crawl/index state; 'submitted'/'unknown' only for
--                     owned_net FsTarget (never 'indexed' from file presence)
--   first_seen_indexed_at — when indexing_status first became 'indexed'
--   approver_audit  — identity + timestamp from approveDeploy CLI (§12 audit)
--   publish_meta    — connector-specific metadata (outPath, hubBaseUrl, etc.)
--   published_at    — timestamp of the successful publish
--   created_at      — row creation timestamp
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS url_registry (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id               uuid        NOT NULL,
  content_set_id         uuid        NULL,
  customer_id            uuid        NULL,
  channel_class          text        NOT NULL
    CHECK (channel_class IN (
      'owned_net', 'pr_wire', 'directory', 'web2', 'social', 'entity'
    )),
  published_url          text        NOT NULL,
  external_ref           text        NULL,
  disclosure_tag         text        NULL,
  language               text        NOT NULL,
  publish_status         text        NOT NULL
    CHECK (publish_status IN (
      'publishing', 'published', 'dry_run', 'failed', 'unpublished'
    )),
  indexing_status        text        NOT NULL DEFAULT 'unknown'
    CHECK (indexing_status IN (
      'unknown', 'submitted', 'indexed', 'not_indexed'
    )),
  first_seen_indexed_at  timestamptz NULL,
  approver_audit         jsonb       NULL,
  publish_meta           jsonb       NULL,
  published_at           timestamptz NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Idempotency arbiter: at-most-one live (claimed or published) row per
-- (asset_id, channel_class).  dry_run/failed/unpublished rows are excluded
-- so previews and retries coexist without violating the unique.
--
-- 42P10 lesson: ON CONFLICT targets need a matching unique INDEX (not just
-- a UNIQUE constraint).  This is a CREATE UNIQUE INDEX so pg-boss / Kysely
-- ON CONFLICT DO NOTHING can rely on it as the arbiter.
CREATE UNIQUE INDEX IF NOT EXISTS uq_url_registry_live
  ON url_registry (asset_id, channel_class)
  WHERE publish_status IN ('publishing', 'published');

-- Operational indexes for the Phase 0/4 monitoring read path
CREATE INDEX IF NOT EXISTS ix_url_registry_indexing
  ON url_registry (indexing_status);

CREATE INDEX IF NOT EXISTS ix_url_registry_customer
  ON url_registry (customer_id);

CREATE INDEX IF NOT EXISTS ix_url_registry_published_at
  ON url_registry (published_at);

-- ---------------------------------------------------------------------------
-- 2. channel_throttle — §7#5 naturalness throttle configuration
--
-- One row per channel_class.  Seeded conservatively:
--   owned_net  — generous (our hub, no ToS to respect, volume is fine)
--   pr_wire    — tight (cost + perception risk of over-syndication)
--   directory  — moderate (manually-submitted anyway; requiresHumanSubmit)
--   web2       — moderate (rate limits vary by platform)
--   social     — tight (naturalness + platform ToS)
--   entity     — very tight (semi-manual, 1-time per entity in practice)
--
-- enabled=false → fail-closed: canPublishNow returns allowed=false.
-- NULL/missing row → fail-closed by default in app code.
-- Seeds use ON CONFLICT DO NOTHING so a re-run leaves existing config intact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_throttle (
  channel_class        text    PRIMARY KEY
    CHECK (channel_class IN (
      'owned_net', 'pr_wire', 'directory', 'web2', 'social', 'entity'
    )),
  max_per_day          int     NOT NULL,
  max_per_week         int     NOT NULL,
  min_interval_minutes int     NOT NULL,
  enabled              boolean NOT NULL DEFAULT true
);

-- Conservative seed: insert only if the row does not exist yet.
-- Operators can UPDATE these values post-seed; re-running the migration is safe.
INSERT INTO channel_throttle
  (channel_class, max_per_day, max_per_week, min_interval_minutes, enabled)
VALUES
  -- owned_net: our hub — generous limits; no external ToS
  ('owned_net',  50,  200, 5,    true),
  -- pr_wire: syndication cost + press-release naturalness ceiling
  ('pr_wire',    2,   5,   480,  true),
  -- directory: semi-auto requiresHumanSubmit — still cap auto drafts
  ('directory',  5,   20,  60,   true),
  -- web2: Medium/dev.to/Hashnode/Brunch — platform-specific rate limits
  ('web2',       10,  40,  30,   true),
  -- social: LinkedIn/X — strict naturalness + platform ToS
  ('social',     3,   10,  120,  true),
  -- entity: Wikidata/Crunchbase — essentially manual, very low cap
  ('entity',     1,   2,   1440, true)
ON CONFLICT (channel_class) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. channel_throttle_state — §7#5 per-(customer, channel) counters
--
-- One row per (customer_id, channel_class) within a rolling window.
-- customer_id NULL = generic owned-net assets with no customer association.
--
-- The COALESCE functional unique index treats NULL customer_id as the sentinel
-- UUID '00000000-0000-0000-0000-000000000000', so the NULL bucket is unique
-- without a special IS NULL partial index and WITHOUT violating the SQL
-- NULL != NULL rule in a plain UNIQUE constraint.
--
-- Row-level FOR UPDATE in the claim transaction + SKIP LOCKED prevents
-- the count-then-publish race admitted by a live COUNT approach (§7#5 design).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_throttle_state (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid        NULL,
  channel_class    text        NOT NULL
    CHECK (channel_class IN (
      'owned_net', 'pr_wire', 'directory', 'web2', 'social', 'entity'
    )),
  window_start     timestamptz NOT NULL,
  count            int         NOT NULL DEFAULT 0,
  last_publish_at  timestamptz NULL
);

-- Functional unique index on COALESCE(customer_id, zero-uuid) + channel_class.
-- This makes the NULL-customer bucket addressable as a unique row so the app
-- can upsert/lock a single row for generic owned-net assets, exactly like a
-- named customer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_throttle_state
  ON channel_throttle_state (
    COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
    channel_class
  );

-- ---------------------------------------------------------------------------
-- 4. ALTER content_deploy_queue — additive columns + widen status CHECK
--
-- Phase 2 (migration 0009) created content_deploy_queue with:
--   status CHECK (status IN ('queued'))
--
-- Phase 3 needs to:
--   (a) Widen status to ('queued','leased','published','failed','unpublished')
--       so the dispatch/unit handlers can transition rows through their lifecycle.
--       NOTE: 'dry_run' is NOT a queue status (it is a url_registry publish_status
--       only) — dry-runs do not strand rows in the claim predicate.
--       NOTE: 'deferred' is NOT a queue status — deferral = re-queue to 'queued'
--             with a delay; no extra status value needed.
--   (b) Add leased_at    — when the row was last leased (for stale-lease reaping)
--   (c) Add attempts     — monotone counter incremented on each dispatch claim
--   (d) Add approved_by  — human approver identity (§11/§12 audit; NOT a bare bool)
--   (e) Add approved_at  — timestamp of approval
--
-- The uq_deploy_queue_asset UNIQUE index (on asset_id) is retained unchanged.
--
-- No test in Phase 0/1/2 pins the old single-value 'queued' CHECK:
--   queueForDeploy.ts and its test suite only INSERT status='queued', so the
--   wider CHECK is backward-compatible.
-- ---------------------------------------------------------------------------

-- Drop the old single-value CHECK and re-add the widened version.
-- Both operations are idempotent:
--   DROP CONSTRAINT IF EXISTS is a no-op if the constraint was already removed.
--   ADD CONSTRAINT also uses the same name so a re-run will fail gracefully if
--   the wide constraint is already present — to make the ADD truly idempotent we
--   wrap it in a DO block that catches duplicate-object errors.
ALTER TABLE content_deploy_queue
  DROP CONSTRAINT IF EXISTS content_deploy_queue_status_check;

-- Re-add the widened CHECK under the same name.
-- A DO block is used so the migration is idempotent: if the constraint was
-- already added by a prior run, the duplicate_object exception is caught and
-- swallowed rather than aborting the transaction.
DO $$
BEGIN
  ALTER TABLE content_deploy_queue
    ADD CONSTRAINT content_deploy_queue_status_check
    CHECK (status IN ('queued', 'leased', 'published', 'failed', 'unpublished'));
EXCEPTION
  WHEN duplicate_object THEN
    -- Constraint already exists (idempotent re-run); nothing to do.
    NULL;
END;
$$;

-- Add the Phase 3 columns additively (all nullable / have defaults; safe on
-- a live table because existing rows will get NULL / default values).
ALTER TABLE content_deploy_queue
  ADD COLUMN IF NOT EXISTS leased_at    timestamptz,
  ADD COLUMN IF NOT EXISTS attempts     int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approved_by  text,
  ADD COLUMN IF NOT EXISTS approved_at  timestamptz;
