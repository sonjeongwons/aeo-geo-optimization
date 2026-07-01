-- =============================================================================
-- 0020_citation_channel.sql — hi-end audit MUST #2: mention vs CITATION split
--
-- A MENTION is the brand named in prose; a CITATION is the brand presented as a
-- clickable/linked SOURCE or explicit attribution. The engine sells citations but
-- historically measured only mentions. These denormalized columns make the
-- citation channel a first-class, separately-aggregated signal (SMR_citation).
--
-- Columns are NULL-safe / DEFAULT false so every existing mention_judgment row
-- (and every legacy insert path) stays valid — citation is purely additive.
-- =============================================================================

ALTER TABLE mention_judgment
  ADD COLUMN IF NOT EXISTS citation_present boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS citation_url     text,
  ADD COLUMN IF NOT EXISTS citation_quote   text;

-- current_judgment is `SELECT *`; re-create so it surfaces the new columns.
-- (Postgres expands * at view-definition time — appended table columns require a
--  CREATE OR REPLACE to appear in the view. Appending columns is permitted.)
CREATE OR REPLACE VIEW current_judgment AS
  SELECT DISTINCT ON (response_raw_id)
    *
  FROM mention_judgment
  ORDER BY response_raw_id, captured_at DESC;

-- Extend the per-run aggregation helper with citation_hits.
-- citation counts ONLY when the brand is also a grounded, gate-passed MENTION
-- (citation ⊆ mention) — this prevents URL-substring false positives from
-- inflating the citation rate above the mention rate.
-- NOTE: CREATE OR REPLACE VIEW can only APPEND columns (it cannot rename or
-- insert before an existing column). The base view (migration 0003) ends with
-- inv_rank_sum, so citation_hits MUST be appended AFTER it. Kysely selectAll is
-- column-order-agnostic, so aggregate.ts reads .citation_hits by name regardless.
CREATE OR REPLACE VIEW run_smr_overall AS
  SELECT
    cj.run_id,
    cj.customer_id,
    count(*) FILTER (WHERE cj.response_status = 'ok' AND cj.guardrail_status = 'pass')                                    AS judged_ok,
    count(*) FILTER (WHERE cj.brand_mentioned  AND cj.guardrail_status = 'pass')                                          AS brand_hits,
    sum(1.0 / NULLIF(cj.brand_rank, 0)) FILTER (WHERE cj.brand_mentioned AND cj.guardrail_status = 'pass')               AS inv_rank_sum,
    count(*) FILTER (WHERE cj.citation_present AND cj.brand_mentioned AND cj.guardrail_status = 'pass')                   AS citation_hits
  FROM current_judgment cj
  GROUP BY cj.run_id, cj.customer_id;
