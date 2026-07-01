-- =============================================================================
-- 0001_dimensions.sql — plain relational (dimension) tables
-- PostgreSQL 16 + TimescaleDB
-- NOTE: TimescaleDB and pgcrypto extensions are created here so they are
--       available for all subsequent migrations.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- customer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text        UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- brand
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand (
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid  NOT NULL REFERENCES customer(id),
  name        text  NOT NULL,
  aliases     text[] NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- competitor
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS competitor (
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid  NOT NULL REFERENCES customer(id),
  name        text  NOT NULL,
  aliases     text[] NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- question
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid    NOT NULL REFERENCES customer(id),
  text          text    NOT NULL,
  language      text    NOT NULL,
  funnel_stage  text,
  density_tier  text    NOT NULL CHECK (density_tier IN ('core','secondary','longtail')),
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (customer_id, text, language)
);

-- ---------------------------------------------------------------------------
-- model
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model (
  id                  text    PRIMARY KEY,
  provider            text    NOT NULL,
  is_cheap_monitor    boolean NOT NULL DEFAULT false,
  is_judge            boolean NOT NULL DEFAULT false,
  input_usd_per_mtok  numeric NOT NULL DEFAULT 0,
  output_usd_per_mtok numeric NOT NULL DEFAULT 0,
  enabled             boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- budget
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget (
  customer_id     uuid    PRIMARY KEY REFERENCES customer(id),
  max_models      int     NOT NULL DEFAULT 1,
  max_samples     int     NOT NULL DEFAULT 5,
  max_languages   int     NOT NULL DEFAULT 14,
  weekly_usd_cap  numeric NOT NULL DEFAULT 50,
  monthly_usd_cap numeric NOT NULL DEFAULT 150
);

-- ---------------------------------------------------------------------------
-- customer_language
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_language (
  customer_id uuid    NOT NULL REFERENCES customer(id),
  language    text    NOT NULL,
  weight      numeric NOT NULL DEFAULT 1.0,
  PRIMARY KEY (customer_id, language)
);

-- ---------------------------------------------------------------------------
-- industry_template
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS industry_template (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  industry    text        NOT NULL,
  version     int         NOT NULL DEFAULT 1,
  status      text        NOT NULL CHECK (status IN ('draft','reviewed','active')) DEFAULT 'draft',
  questions   jsonb       NOT NULL,
  competitors jsonb       NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- run
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid        NOT NULL REFERENCES customer(id),
  kind        text        NOT NULL CHECK (kind IN ('baseline','operating')),
  status      text        NOT NULL CHECK (status IN ('planned','running','completed','failed','over_budget')) DEFAULT 'planned',
  n_samples   int         NOT NULL,
  temperature numeric     NOT NULL DEFAULT 0.7,
  n_total     int,
  planned_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);

-- ---------------------------------------------------------------------------
-- rotation_state  (persisted cursor for density-tier rotation)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rotation_state (
  customer_id      uuid NOT NULL REFERENCES customer(id),
  density_tier     text NOT NULL,
  last_cycle_index int  NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, density_tier)
);

-- ---------------------------------------------------------------------------
-- work_unit  (plain table — idempotency key; NOT a hypertable so the composite
--             PK can omit any partition column)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_unit (
  run_id          uuid NOT NULL REFERENCES run(id),
  question_id     uuid NOT NULL,
  model_id        text NOT NULL,
  language        text NOT NULL,
  sample_idx      int  NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','done','skipped','error')) DEFAULT 'pending',
  response_raw_id uuid,
  PRIMARY KEY (run_id, question_id, model_id, language, sample_idx)
);

-- ---------------------------------------------------------------------------
-- response_cache  (plain table — cross-cycle accidental-dup guard only;
--                  NOT a hypertable so the PK can be on request_hash alone)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS response_cache (
  request_hash text        PRIMARY KEY,
  answer_text  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
