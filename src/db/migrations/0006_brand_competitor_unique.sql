-- =============================================================================
-- 0006_brand_competitor_unique.sql
--
-- BUGFIX (found by live DB verification, not caught by unit tests):
--   upsertBrand / upsertCompetitor (src/db/repo.ts) use
--   `ON CONFLICT (customer_id, name) DO UPDATE`, but 0001_dimensions.sql created
--   the brand and competitor tables WITHOUT a unique constraint/index on
--   (customer_id, name).  Postgres then raises 42P10
--   ("there is no unique or exclusion constraint matching the ON CONFLICT
--   specification" / infer_arbiter_indexes), so loadTemplate() — the entire
--   config->DB seed path — failed on a real database.
--
-- A unique INDEX is a valid ON CONFLICT arbiter (same as a constraint), and
-- CREATE UNIQUE INDEX IF NOT EXISTS is idempotent, so this is safe to (re)run.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS brand_customer_name_uniq
  ON brand (customer_id, name);

CREATE UNIQUE INDEX IF NOT EXISTS competitor_customer_name_uniq
  ON competitor (customer_id, name);
