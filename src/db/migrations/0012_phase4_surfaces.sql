-- =============================================================================
-- 0012_phase4_surfaces.sql — Phase 4 v1-b Surface Expansion
--
-- ALL changes are PLAIN (no hypertable, no CAGG, no policy/compression DDL),
-- so this migration is fully transactional (no .cjs needed).
-- All operations are idempotent (ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT EXISTS
-- / ON CONFLICT DO NOTHING or DO UPDATE).
--
-- mention_judgment is UNTOUCHED by this migration.
--
-- Changes:
--   1. ALTER model — ADD COLUMN modality (DEFAULT 'chat'; backward-compatible)
--   2. CREATE surface_scan_queue — SERP/scrape work scheduling queue
--   3. SEED model rows — 8 v1-b surfaces with correct modality:
--        googleAio   (serp)   — Google AI Overviews, official SERP API only
--        naverAi     (serp)   — Naver AI, official SERP API only
--        copilot     (scrape) — Microsoft Copilot
--        metaAi      (scrape) — Meta AI (Llama-backed)
--        mistral     (api)    — Mistral Le Chat API
--        deepseek    (api)    — DeepSeek Chat API
--        line        (scrape) — Line (JP/TW/TH market)
--        kakao       (scrape) — Kakao (KR market)
--
-- §12 Compliance encoding:
--   googleAio + naverAi are seeded with modality='serp' and
--   scrape_allowed=false (enforced by construction in the surface_scan_queue table).
--
-- ON CONFLICT rules:
--   model.id is the PK — ON CONFLICT (id) relies on the PK unique constraint.
--   surface_scan_queue.surface_id is the PK — same rule.
--   No additional unique indexes are needed for the PK-based ON CONFLICT targets.
--
-- All CHECKs are SINGLE-TABLE (no cross-table CHECK).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. ALTER model — add modality column
--
-- Modality values (mirrors src/domain/types.ts Modality):
--   'chat'   — LLM chat API (all pre-Phase-4 models; default for backward compat)
--   'serp'   — Search Engine Results Page API (Google AI Overviews, Naver AI)
--   'scrape' — RPA/browser scrape surface (Copilot, Meta AI, Line, Kakao)
--
-- DEFAULT 'chat' ensures every existing model row gets the correct modality
-- without any UPDATE; new rows must specify modality explicitly.
-- The CHECK constraint matches the Modality union in src/domain/types.ts exactly.
-- ---------------------------------------------------------------------------
ALTER TABLE model
  ADD COLUMN IF NOT EXISTS modality text NOT NULL DEFAULT 'chat'
    CHECK (modality IN ('chat', 'serp', 'scrape'));

-- ---------------------------------------------------------------------------
-- 2. surface_scan_queue — scheduling queue for SERP + scrape surfaces
--
-- One row per surface.  Tracks readiness, run cadence, and §12 compliance flags.
--
-- Columns:
--   surface_id      — canonical surface identifier (e.g. 'googleAio', 'copilot')
--   modality        — 'serp' | 'scrape' (chat surfaces do not need this queue)
--   scrape_allowed  — false for SERP-API-only surfaces (§12: AIO/Naver may NOT
--                     be constructed via RPA runner; encoded here by construction)
--   enabled         — false until the relevant key/runner arrives
--   next_run_at     — scheduled wall-clock time for the next scan
--   last_run_at     — last successful scan timestamp (NULL = never run)
--   created_at      — row creation timestamp
--
-- §12 invariant: googleAio + naverAi have scrape_allowed = false.
--   The SurfaceAdapter layer reads this column before constructing an RpaRunner;
--   attempting to use RPA on scrape_allowed=false raises a compile-time error
--   (encoded structurally in src/surfaces/compliance.ts, T02).
--
-- enabled=false → surface is skipped in selectEligibleModels (T12/T16).
-- next_run_at NULL → not yet scheduled; treated as past-due by the scheduler.
--
-- surface_scan_queue.surface_id is the PK; ON CONFLICT (surface_id) targets the PK
-- unique constraint directly (no additional unique index required).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS surface_scan_queue (
  surface_id      text        PRIMARY KEY,
  modality        text        NOT NULL
    CHECK (modality IN ('serp', 'scrape')),
  scrape_allowed  boolean     NOT NULL DEFAULT true,
  enabled         boolean     NOT NULL DEFAULT false,
  next_run_at     timestamptz NULL,
  last_run_at     timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. Seed model rows for the 8 v1-b surfaces
--
-- All surfaces start with enabled=false (NOT_CONFIGURED stubs; §4 invariant:
-- stubs until keys/runner arrive).
--
-- Modality assignments (SPEC §4):
--   serp    — googleAio, naverAi  (official SERP API only)
--   scrape  — copilot, metaAi, line, kakao  (RPA/browser)
--   api/chat— mistral, deepseek   (API — same 'chat' modality as v1-a stubs,
--             already seeded as stubs in v1-a; rows updated here to confirm modality)
--
-- NOTE: mistral and deepseek were seeded by loadTemplate / prior migrations as
-- 'chat' stubs.  The ON CONFLICT DO UPDATE refreshes them in place so they get
-- an explicit modality column value even if the DEFAULT already set 'chat'.
--
-- Pricing is 0 for all stub surfaces (updated when real adapters are wired).
--
-- ON CONFLICT target = id (PK); no additional unique index needed.
-- ---------------------------------------------------------------------------

-- Google AI Overviews — SERP API only (§12: scrape_allowed=false)
INSERT INTO model
  (id, provider, modality, is_cheap_monitor, is_judge, input_usd_per_mtok, output_usd_per_mtok, enabled)
VALUES
  ('googleAio', 'googleAio', 'serp', false, false, 0, 0, false)
ON CONFLICT (id) DO UPDATE SET
  provider             = EXCLUDED.provider,
  modality             = EXCLUDED.modality,
  is_cheap_monitor     = EXCLUDED.is_cheap_monitor,
  is_judge             = EXCLUDED.is_judge,
  input_usd_per_mtok   = EXCLUDED.input_usd_per_mtok,
  output_usd_per_mtok  = EXCLUDED.output_usd_per_mtok,
  enabled              = EXCLUDED.enabled;

-- Naver AI — SERP API only (§12: scrape_allowed=false)
INSERT INTO model
  (id, provider, modality, is_cheap_monitor, is_judge, input_usd_per_mtok, output_usd_per_mtok, enabled)
VALUES
  ('naverAi', 'naverAi', 'serp', false, false, 0, 0, false)
ON CONFLICT (id) DO UPDATE SET
  provider             = EXCLUDED.provider,
  modality             = EXCLUDED.modality,
  is_cheap_monitor     = EXCLUDED.is_cheap_monitor,
  is_judge             = EXCLUDED.is_judge,
  input_usd_per_mtok   = EXCLUDED.input_usd_per_mtok,
  output_usd_per_mtok  = EXCLUDED.output_usd_per_mtok,
  enabled              = EXCLUDED.enabled;

-- Microsoft Copilot — scrape surface
INSERT INTO model
  (id, provider, modality, is_cheap_monitor, is_judge, input_usd_per_mtok, output_usd_per_mtok, enabled)
VALUES
  ('copilot', 'copilot', 'scrape', false, false, 0, 0, false)
ON CONFLICT (id) DO UPDATE SET
  provider             = EXCLUDED.provider,
  modality             = EXCLUDED.modality,
  is_cheap_monitor     = EXCLUDED.is_cheap_monitor,
  is_judge             = EXCLUDED.is_judge,
  input_usd_per_mtok   = EXCLUDED.input_usd_per_mtok,
  output_usd_per_mtok  = EXCLUDED.output_usd_per_mtok,
  enabled              = EXCLUDED.enabled;

-- Meta AI (Llama-backed) — scrape surface
INSERT INTO model
  (id, provider, modality, is_cheap_monitor, is_judge, input_usd_per_mtok, output_usd_per_mtok, enabled)
VALUES
  ('metaAi', 'metaAi', 'scrape', false, false, 0, 0, false)
ON CONFLICT (id) DO UPDATE SET
  provider             = EXCLUDED.provider,
  modality             = EXCLUDED.modality,
  is_cheap_monitor     = EXCLUDED.is_cheap_monitor,
  is_judge             = EXCLUDED.is_judge,
  input_usd_per_mtok   = EXCLUDED.input_usd_per_mtok,
  output_usd_per_mtok  = EXCLUDED.output_usd_per_mtok,
  enabled              = EXCLUDED.enabled;

-- Mistral Le Chat — API surface (chat modality; v1-a stub confirmed here)
INSERT INTO model
  (id, provider, modality, is_cheap_monitor, is_judge, input_usd_per_mtok, output_usd_per_mtok, enabled)
VALUES
  ('mistral-large-latest', 'mistral', 'chat', false, false, 0, 0, false)
ON CONFLICT (id) DO UPDATE SET
  provider             = EXCLUDED.provider,
  modality             = EXCLUDED.modality,
  is_cheap_monitor     = EXCLUDED.is_cheap_monitor,
  is_judge             = EXCLUDED.is_judge,
  input_usd_per_mtok   = EXCLUDED.input_usd_per_mtok,
  output_usd_per_mtok  = EXCLUDED.output_usd_per_mtok,
  enabled              = EXCLUDED.enabled;

-- DeepSeek Chat — API surface (chat modality; v1-a stub confirmed here)
INSERT INTO model
  (id, provider, modality, is_cheap_monitor, is_judge, input_usd_per_mtok, output_usd_per_mtok, enabled)
VALUES
  ('deepseek-chat', 'deepseek', 'chat', false, false, 0, 0, false)
ON CONFLICT (id) DO UPDATE SET
  provider             = EXCLUDED.provider,
  modality             = EXCLUDED.modality,
  is_cheap_monitor     = EXCLUDED.is_cheap_monitor,
  is_judge             = EXCLUDED.is_judge,
  input_usd_per_mtok   = EXCLUDED.input_usd_per_mtok,
  output_usd_per_mtok  = EXCLUDED.output_usd_per_mtok,
  enabled              = EXCLUDED.enabled;

-- Line — scrape surface (JP/TW/TH market)
INSERT INTO model
  (id, provider, modality, is_cheap_monitor, is_judge, input_usd_per_mtok, output_usd_per_mtok, enabled)
VALUES
  ('line', 'line', 'scrape', false, false, 0, 0, false)
ON CONFLICT (id) DO UPDATE SET
  provider             = EXCLUDED.provider,
  modality             = EXCLUDED.modality,
  is_cheap_monitor     = EXCLUDED.is_cheap_monitor,
  is_judge             = EXCLUDED.is_judge,
  input_usd_per_mtok   = EXCLUDED.input_usd_per_mtok,
  output_usd_per_mtok  = EXCLUDED.output_usd_per_mtok,
  enabled              = EXCLUDED.enabled;

-- Kakao — scrape surface (KR market)
INSERT INTO model
  (id, provider, modality, is_cheap_monitor, is_judge, input_usd_per_mtok, output_usd_per_mtok, enabled)
VALUES
  ('kakao', 'kakao', 'scrape', false, false, 0, 0, false)
ON CONFLICT (id) DO UPDATE SET
  provider             = EXCLUDED.provider,
  modality             = EXCLUDED.modality,
  is_cheap_monitor     = EXCLUDED.is_cheap_monitor,
  is_judge             = EXCLUDED.is_judge,
  input_usd_per_mtok   = EXCLUDED.input_usd_per_mtok,
  output_usd_per_mtok  = EXCLUDED.output_usd_per_mtok,
  enabled              = EXCLUDED.enabled;

-- ---------------------------------------------------------------------------
-- 4. Seed surface_scan_queue rows for the 6 non-API v1-b surfaces
--
-- Only serp + scrape surfaces need this queue.
-- mistral + deepseek are 'chat' API surfaces and do NOT use the scan queue.
--
-- §12 compliance: googleAio + naverAi have scrape_allowed=false.
-- All surfaces start disabled (enabled=false) — flip to true when key/runner arrives.
--
-- ON CONFLICT (surface_id) DO NOTHING: re-running the migration is safe; existing
-- rows (potentially with enabled=true from a live deployment) are NOT overwritten,
-- preserving operator configuration.
-- ---------------------------------------------------------------------------
INSERT INTO surface_scan_queue
  (surface_id, modality, scrape_allowed, enabled)
VALUES
  -- §12: SERP-API-only — scrape_allowed=false by construction
  ('googleAio', 'serp',   false, false),
  ('naverAi',   'serp',   false, false),
  -- Scrape surfaces — scrape_allowed=true (RPA runner)
  ('copilot',   'scrape', true,  false),
  ('metaAi',    'scrape', true,  false),
  ('line',      'scrape', true,  false),
  ('kakao',     'scrape', true,  false)
ON CONFLICT (surface_id) DO NOTHING;
