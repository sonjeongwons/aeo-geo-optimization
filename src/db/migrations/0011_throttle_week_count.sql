-- =============================================================================
-- 0011_throttle_week_count.sql — Add week_count + week_start to channel_throttle_state
--
-- Phase 3 fix: enforce max_per_week transactionally inside the claim transaction.
-- The daily-window count column cannot accumulate across calendar-day boundaries,
-- so a separate week_count column is required to enforce max_per_week accurately.
--
-- Columns added to channel_throttle_state:
--   week_count  int DEFAULT 0  — weekly publish counter; resets when week_start rolls.
--   week_start  timestamptz    — start of the current ISO week (Monday 00:00:00 UTC);
--                               NULL for legacy rows (treated as 0 for the weekly cap).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is safe on re-run.
-- PLAIN table; migration is fully transactional.
-- =============================================================================

ALTER TABLE channel_throttle_state
  ADD COLUMN IF NOT EXISTS week_count  int          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS week_start  timestamptz  NULL;
