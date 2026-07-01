-- ===== 0017_invoice_line_vat_kind.sql =====
-- Add 'vat' to invoice_line.kind CHECK constraint so VAT lines are correctly
-- labelled and not double-counted into the base subtotal.
--
-- BHB-3 fix: close.ts was inserting the VAT line with kind='base', causing
-- SUM(amount_krw) WHERE kind='base' to include VAT — mislabelling the tax line
-- and making the base subtotal diverge from invoice.base_krw.
--
-- Strategy: DROP + re-ADD the CHECK constraint (idempotent — both old and new
-- values remain valid after migration). PostgreSQL does not support ALTER CHECK
-- inline; constraint must be dropped and re-added.
--
-- Safe to apply on a live DB: CHECK constraints are NOT VALID by default on
-- older PG, but here we use plain ADD CONSTRAINT (validates existing rows).
-- All existing kind values ('base', 'overage', 'human_ops') remain valid.

BEGIN;

-- 1. Drop the existing CHECK constraint (name assigned by PostgreSQL from 0014).
--    Use IF EXISTS so re-running this migration is safe (idempotent).
ALTER TABLE invoice_line
  DROP CONSTRAINT IF EXISTS invoice_line_kind_check;

-- 2. Re-add the CHECK constraint with 'vat' included.
--    'vat' replaces the incorrect 'base' label for VAT lines.
ALTER TABLE invoice_line
  ADD CONSTRAINT invoice_line_kind_check
  CHECK (kind IN ('base', 'overage', 'human_ops', 'vat'));

COMMIT;
