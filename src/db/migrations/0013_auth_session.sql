-- ===== 0013_auth_session.sql : auth + sessions (multi-tenant, staff-capable) =====
-- PLAIN tables — fully transactional; no Timescale objects, no RLS.
-- pgcrypto (gen_random_uuid) is already enabled by 0001_dimensions.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS app_user (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text        UNIQUE NOT NULL,
  password_hash text       NOT NULL,
  -- NULL = internal staff who act across customers (role='staff'); non-staff must be scoped
  customer_id  uuid        NULL REFERENCES customer(id),
  role         text        NOT NULL CHECK (role IN ('owner','member','staff')) DEFAULT 'owner',
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Non-staff users MUST be scoped to a customer
  CONSTRAINT app_user_scope_chk CHECK ((role = 'staff') OR (customer_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_app_user_customer ON app_user (customer_id);

CREATE TABLE IF NOT EXISTS app_session (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- SHA-256 of the opaque cookie token; raw token is never stored
  token_hash  text        UNIQUE NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_app_session_user    ON app_session (user_id);
CREATE INDEX IF NOT EXISTS ix_app_session_expires ON app_session (expires_at);

COMMIT;
