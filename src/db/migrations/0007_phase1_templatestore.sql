-- =============================================================================
-- 0007_phase1_templatestore.sql — Phase 1 industry_template indexes + advisory cols
--
-- industry_template is a PLAIN (non-hypertable) table, so:
--   • Partial unique indexes are legal (no hypertable partition-column constraint).
--   • This migration is plain transactional SQL (no pgm.noTransaction() needed).
--   • All operations are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
-- DESIGN NOTE (DESIGN-phase1.md §Industry-Template Store & Lifecycle):
--   AT-MOST-ONE-ACTIVE-PER-INDUSTRY is enforced by a PARTIAL UNIQUE INDEX on
--   (industry) WHERE status='active'. This is race-free at the database level;
--   activating a new version must demote the prior active to 'reviewed' inside
--   the same transaction so the partial index is never transiently violated.
--
--   The at-most-one-per-version uniqueness is enforced by a composite unique
--   index on (industry, version) so that the append-only version history is
--   collision-free.
--
--   NO 'archived' status value is added here — that would require widening the
--   status CHECK ('draft','reviewed','active') and auditing every TS status
--   union/exhaustive-switch, an unnecessary risk flagged by all design reviews.
--
-- ADVISORY COLUMNS (all nullable, additive — zero impact on existing rows):
--   source_url     — the URL that was diagnosed to produce this template draft
--   customer_slug  — the customer slug if seeded from an existing customer
--   generated_total — total questions generated before dedup/guardrails
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Composite unique index: enforce per-industry version uniqueness.
--    Ensures the append-only version log never has two rows for the same
--    (industry, version) pair.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_industry_template_version
  ON industry_template (industry, version);

-- ---------------------------------------------------------------------------
-- 2. Partial unique index: at-most-one-active-per-industry constraint.
--    Only rows WHERE status='active' participate, so draft/reviewed rows are
--    unconstrained (many drafts per industry are allowed).
--    This is race-free: a concurrent activation that does not first demote the
--    existing active row will hit a unique-violation, guaranteeing the invariant
--    is enforced at the storage layer, not just at the application layer.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_industry_template_active
  ON industry_template (industry)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 3. Advisory columns (nullable, additive — no effect on existing rows or the
--    status CHECK constraint which remains ('draft','reviewed','active')).
-- ---------------------------------------------------------------------------
ALTER TABLE industry_template
  ADD COLUMN IF NOT EXISTS source_url      text,
  ADD COLUMN IF NOT EXISTS customer_slug   text,
  ADD COLUMN IF NOT EXISTS generated_total int;
