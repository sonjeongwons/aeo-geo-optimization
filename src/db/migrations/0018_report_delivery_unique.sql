-- ===== 0018_report_delivery_unique.sql =====
-- Fix RI-01: replace blanket UNIQUE(snapshot_id, recipient) on report_delivery
-- with a PARTIAL UNIQUE index WHERE status='sent'.
--
-- Problem: the old constraint treats a 'failed' row as occupying the slot,
-- so a successful retry cannot insert a 'sent' row — ON CONFLICT DO NOTHING
-- silently swallows the insert and the sent audit row is never recorded.
--
-- Fix: only 'sent' rows occupy the exactly-once slot.  A 'failed' row does
-- NOT conflict with a later 'sent' row, so a retry that succeeds after an
-- earlier failure correctly records the sent audit.
--
-- The pre-check in deliver.ts (query for existing 'sent' row) is already
-- status-aware, so idempotency for true duplicate sends is preserved.

BEGIN;

-- 1. Drop the blanket unique constraint from 0015 (both name variants, idempotent).
ALTER TABLE report_delivery
  DROP CONSTRAINT IF EXISTS report_delivery_snapshot_id_recipient_key;

-- Also drop the index form in case it was created as an index (not a constraint).
DROP INDEX IF EXISTS report_delivery_snapshot_id_recipient_key;

-- 2. Create a partial unique index restricted to delivered (sent) rows only.
--    This is the correct exactly-once backstop: only one 'sent' row per
--    (snapshot, recipient) pair is allowed; 'failed' rows are unrestricted.
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_delivery_sent
  ON report_delivery (snapshot_id, recipient)
  WHERE status = 'sent';

COMMIT;
