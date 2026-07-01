-- =============================================================================
-- 0022_recommendation_channel.sql — SOTA v2 R1: mention → citation → RECOMMENDATION
--
-- A RECOMMENDATION is the answer AFFIRMATIVELY advising the brand (a "best/top/
-- recommended" list item, or a recommend-verb with the brand as object) — a
-- strict subset of a mention, commercially distinct from a citation (a brand can
-- be cited as a source yet NOT recommended). Denormalized columns make it a
-- first-class, separately-aggregated channel (recommendationShare).
--
-- Columns are DEFAULT false / NULL so every existing row + legacy insert stays
-- valid — purely additive.
-- =============================================================================

ALTER TABLE mention_judgment
  ADD COLUMN IF NOT EXISTS recommendation_present boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recommendation_quote   text;

-- current_judgment is `SELECT *`; re-create so it surfaces the new columns.
CREATE OR REPLACE VIEW current_judgment AS
  SELECT DISTINCT ON (response_raw_id)
    *
  FROM mention_judgment
  ORDER BY response_raw_id, captured_at DESC;

-- Extend the per-run aggregation helper with recommendation_hits.
-- recommendation counts ONLY when the brand is also a grounded, gate-passed
-- MENTION (recommendation ⊆ mention) — so recommendation_hits ≤ brand_hits.
-- NOTE: CREATE OR REPLACE VIEW can only APPEND columns at the end (it cannot
-- insert a column before an existing one). So recommendation_hits is appended
-- AFTER inv_rank_sum (the prior last column). Kysely selectAll is order-agnostic.
-- Column order must match the post-0020 view (…, inv_rank_sum, citation_hits)
-- then APPEND recommendation_hits last (CREATE OR REPLACE can only append).
CREATE OR REPLACE VIEW run_smr_overall AS
  SELECT
    cj.run_id,
    cj.customer_id,
    count(*) FILTER (WHERE cj.response_status = 'ok' AND cj.guardrail_status = 'pass')                                          AS judged_ok,
    count(*) FILTER (WHERE cj.brand_mentioned  AND cj.guardrail_status = 'pass')                                                AS brand_hits,
    sum(1.0 / NULLIF(cj.brand_rank, 0)) FILTER (WHERE cj.brand_mentioned AND cj.guardrail_status = 'pass')                     AS inv_rank_sum,
    count(*) FILTER (WHERE cj.citation_present AND cj.brand_mentioned AND cj.guardrail_status = 'pass')                         AS citation_hits,
    count(*) FILTER (WHERE cj.recommendation_present AND cj.brand_mentioned AND cj.guardrail_status = 'pass')                  AS recommendation_hits
  FROM current_judgment cj
  GROUP BY cj.run_id, cj.customer_id;
