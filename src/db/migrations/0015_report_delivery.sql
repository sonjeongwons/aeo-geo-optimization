-- ===== 0015_report_delivery.sql : weekly snapshot (immutable) + delivery audit =====
-- PLAIN tables — fully transactional; no Timescale objects (NOT a hypertable), no RLS.
-- report_snapshot is IMMUTABLE: report_json stores the as-delivered RunReport so
-- trend charts and the emailed report never drift from a later re-judge.
-- Bounded: O(weeks × customers), not a time-series volume table.

BEGIN;

CREATE TABLE IF NOT EXISTS report_snapshot (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid        NOT NULL REFERENCES customer(id),
  -- References run.id — FK omitted intentionally (run is referenced app-side, like url_registry)
  run_id          uuid        NOT NULL,
  -- Derived from run.finished_at / planned_at (no run.week_start column exists)
  week_start      timestamptz NOT NULL,
  smr             numeric     NOT NULL,
  visibility      numeric     NOT NULL,
  top_sov         numeric     NULL,
  abstain_rate    numeric     NOT NULL,
  -- WoW delta vs previous COMPLETED operating run (NULL if no prior completed run exists)
  wow_smr_delta   numeric     NULL,
  -- The literal RunReport jsonb at delivery time — never updated (immutable)
  report_json     jsonb       NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  -- One snapshot per run: idempotent delivery backstop
  UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS ix_report_snapshot_customer_week
  ON report_snapshot (customer_id, week_start DESC);

CREATE TABLE IF NOT EXISTS report_delivery (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id  uuid        NOT NULL REFERENCES report_snapshot(id) ON DELETE CASCADE,
  recipient    text        NOT NULL,
  channel      text        NOT NULL DEFAULT 'email',
  -- 'sent' | 'failed'
  status       text        NOT NULL CHECK (status IN ('sent','failed')),
  sent_at      timestamptz NOT NULL DEFAULT now(),
  -- Exactly-once delivery backstop: one delivery record per (snapshot, recipient)
  UNIQUE (snapshot_id, recipient)
);

COMMIT;
