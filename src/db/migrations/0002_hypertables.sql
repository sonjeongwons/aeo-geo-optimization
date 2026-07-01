-- =============================================================================
-- 0002_hypertables.sql — time-series hypertables
-- Each table is converted with create_hypertable() immediately after CREATE.
-- RESOLVED: no hypertable has a UNIQUE index that omits the partition column.
--           Cross-table checks are handled in app code, NOT DB CHECKs.
--           mention_judgment is DENORMALIZED (status+coords) so SMR aggregates
--           can run as a SINGLE-TABLE scan / DISTINCT ON view.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- response_raw
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS response_raw (
  captured_at    timestamptz NOT NULL DEFAULT now(),
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  run_id         uuid        NOT NULL,
  customer_id    uuid        NOT NULL,
  question_id    uuid        NOT NULL,
  model_id       text        NOT NULL,
  language       text        NOT NULL,
  sample_idx     int         NOT NULL,
  temperature    numeric     NOT NULL,
  request_hash   text        NOT NULL,
  prompt_version text        NOT NULL,
  answer_text    text,
  provider_meta  jsonb,
  status         text        NOT NULL CHECK (status IN ('ok','not_configured','error','cached')),
  PRIMARY KEY (captured_at, id)
);

SELECT create_hypertable(
  'response_raw',
  'captured_at',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS ix_resp_customer_time ON response_raw (customer_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS ix_resp_run           ON response_raw (run_id);
CREATE INDEX IF NOT EXISTS ix_resp_dims          ON response_raw (question_id, model_id, language, captured_at DESC);

-- ---------------------------------------------------------------------------
-- mention_judgment
-- DENORMALIZED: response_status + evidence coords duplicated here so that
-- SMR/SoV/Visibility aggregations can scan this single table only.
-- same-table CHECK: brand_mentioned=true requires evidence_quote NOT NULL
--   (defense-in-depth; cross-table "evidence ⊂ answer_text" check is app code).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mention_judgment (
  captured_at      timestamptz NOT NULL DEFAULT now(),
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  response_raw_id  uuid        NOT NULL,
  run_id           uuid        NOT NULL,
  customer_id      uuid        NOT NULL,
  question_id      uuid        NOT NULL,
  model_id         text        NOT NULL,
  language         text        NOT NULL,
  response_status  text        NOT NULL,
  brand_mentioned  boolean     NOT NULL,
  brand_rank       int,
  sentiment        text        CHECK (sentiment IN ('positive','neutral','negative')),
  competitors_found jsonb      NOT NULL DEFAULT '[]',
  evidence_quote   text,
  evidence_start   int,
  evidence_end     int,
  provenance       text        NOT NULL CHECK (provenance IN ('judge','fallback','abstain')),
  judge_model      text,
  judge_raw        jsonb,
  guardrail_status text        NOT NULL DEFAULT 'pass' CHECK (guardrail_status IN ('pass','downgraded_abstain')),
  PRIMARY KEY (captured_at, id),
  -- evidence required when brand is claimed as mentioned (same-table, no cross-table ref)
  CONSTRAINT mention_evidence_chk CHECK (brand_mentioned = false OR evidence_quote IS NOT NULL)
);

SELECT create_hypertable(
  'mention_judgment',
  'captured_at',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS ix_mj_response ON mention_judgment (response_raw_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS ix_mj_run      ON mention_judgment (run_id);
CREATE INDEX IF NOT EXISTS ix_mj_decomp   ON mention_judgment (customer_id, model_id, language, question_id, captured_at DESC);

-- ---------------------------------------------------------------------------
-- llm_call  (cost ledger — one row per generation call AND one per judge call)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_call (
  ts               timestamptz NOT NULL DEFAULT now(),
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  customer_id      uuid        NOT NULL,
  run_id           uuid        NOT NULL,
  purpose          text        NOT NULL CHECK (purpose IN ('generation','judge')),
  provider         text        NOT NULL,
  model_id         text        NOT NULL,
  input_tokens     int         NOT NULL DEFAULT 0,
  output_tokens    int         NOT NULL DEFAULT 0,
  usd              numeric     NOT NULL DEFAULT 0,
  cache_hit        boolean     NOT NULL DEFAULT false,
  response_raw_id  uuid,
  PRIMARY KEY (ts, id)
);

SELECT create_hypertable(
  'llm_call',
  'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS ix_cost_customer_time ON llm_call (customer_id, ts DESC);
