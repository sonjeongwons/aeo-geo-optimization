-- =============================================================================
-- 0003_views_aggregates.sql — views + continuous aggregates
--
-- RESOLVED (FATAL): only ONE hypertable per continuous aggregate.
--   cost_daily CAGG references ONLY llm_call (a single hypertable).
--   SMR/SoV/Visibility use plain SQL over current_judgment view (NOT a CAGG).
--
-- current_judgment uses DISTINCT ON to implement "latest-judgment-wins":
--   re-judging appends a row to mention_judgment; the view always exposes the
--   most-recently captured judgment per response_raw_id.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- current_judgment — latest judgment per response
-- DISTINCT ON (response_raw_id) ORDER BY response_raw_id, captured_at DESC
-- gives exactly one row per response, the most recent judgment.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW current_judgment AS
  SELECT DISTINCT ON (response_raw_id)
    *
  FROM mention_judgment
  ORDER BY response_raw_id, captured_at DESC;

-- ---------------------------------------------------------------------------
-- run_smr_overall — per-run aggregation helper
-- aggregate.ts joins this to run.n_total to compute:
--   SMR        = brand_hits   / run.n_total
--   Visibility = inv_rank_sum / run.n_total
-- Guardrail: only guardrail_status='pass' rows count in the numerator.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW run_smr_overall AS
  SELECT
    cj.run_id,
    cj.customer_id,
    count(*) FILTER (WHERE cj.response_status = 'ok' AND cj.guardrail_status = 'pass')                                    AS judged_ok,
    count(*) FILTER (WHERE cj.brand_mentioned  AND cj.guardrail_status = 'pass')                                          AS brand_hits,
    sum(1.0 / NULLIF(cj.brand_rank, 0)) FILTER (WHERE cj.brand_mentioned AND cj.guardrail_status = 'pass')               AS inv_rank_sum
  FROM current_judgment cj
  GROUP BY cj.run_id, cj.customer_id;

-- ---------------------------------------------------------------------------
-- cost_daily continuous aggregate + refresh policy are intentionally NOT
-- included here.  TimescaleDB forbids CREATE MATERIALIZED VIEW ... WITH
-- (timescaledb.continuous) and add_continuous_aggregate_policy() inside an
-- explicit transaction block.  node-pg-migrate wraps every .sql file in
-- BEGIN/COMMIT, so these statements must live in a JS migration that calls
-- pgm.noTransaction().  See 0004_cagg_policy.js.
-- ---------------------------------------------------------------------------
