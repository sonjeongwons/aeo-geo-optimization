-- ===== 0016_phase5_indexes.sql : Phase 5 supporting indexes =====
-- Additional scoping / period-query indexes discovered during build.
-- Most primary indexes are inlined in 0013-0015; this file holds supplementary ones.
-- No Timescale-object DDL (no hypertables, no CAGGs, no compression/retention policies).

BEGIN;

-- Support sumLlmUsageForPeriod: filter by customer_id (non-null) + day range on cost_daily.
-- cost_daily is a TimescaleDB continuous aggregate — we do NOT add an index there
-- (Timescale manages its own internal indexes; adding one is unsupported and could break refresh).
-- The query planner uses the existing bucket column; no additional DDL needed here.

-- Support app_session expiry cleanup queries (find expired sessions efficiently).
-- Already created in 0013; this is a placeholder for any extra indexes needed.

-- Support report_delivery status queries (e.g. fetch failed deliveries for retry).
CREATE INDEX IF NOT EXISTS ix_report_delivery_status
  ON report_delivery (status, sent_at DESC);

-- Support subscription period queries (find subscriptions whose period ends soon).
CREATE INDEX IF NOT EXISTS ix_subscription_period_end
  ON subscription (current_period_end)
  WHERE status IN ('trialing', 'active');

-- Support invoice period queries per customer (billing close reads recent invoices).
-- Already covered by ix_invoice_customer in 0014; add a status-filtered variant.
CREATE INDEX IF NOT EXISTS ix_invoice_status
  ON invoice (status, period_start DESC);

COMMIT;
