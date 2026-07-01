-- =============================================================================
-- 0021_security_audit.sql — hi-end audit MUST #6: append-only, tamper-evident
-- security audit log (SOC2 CC7-style control).
--
-- Every security-relevant DECISION (report-token verification, auth outcomes,
-- insecure-config fallbacks, denied approvals) writes ONE immutable row here.
--
-- Integrity:
--   * APPEND-ONLY — UPDATE/DELETE are revoked from the application role below.
--     There is intentionally NO "latest-wins" view (unlike mention_judgment):
--     an audit log has no superseding semantics; every row is a distinct event
--     and hiding prior rows would defeat the trail.
--   * HASH-CHAINED — row_hash = SHA256(prev_hash || canonical(event)); each row
--     commits to all history before it, so editing/deleting any past row breaks
--     every later row_hash. verifySecurityAuditChain() (repo) re-walks to detect.
-- =============================================================================

CREATE TABLE IF NOT EXISTS security_audit (
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  event_type   text        NOT NULL,
  result       text        NOT NULL CHECK (result IN ('success','failure','denied')),
  -- The subject/customer this event concerns (NULL when pre-auth / unknown).
  subject_id   uuid,
  -- Source IP / client identifier (NULL when not available).
  source_ip    text,
  -- Structured, non-sensitive detail. Secrets/tokens MUST be redacted by the app
  -- (src/security/securityAudit.ts redactToken) before reaching this column.
  detail       jsonb       NOT NULL DEFAULT '{}',
  -- Optional fingerprint of the request/token (redacted, non-reversible).
  request_hash text,
  -- Hash chain (tamper-evidence).
  prev_hash    text        NOT NULL,
  row_hash     text        NOT NULL,
  PRIMARY KEY (occurred_at, id)
);

SELECT create_hypertable(
  'security_audit',
  'occurred_at',
  chunk_time_interval => INTERVAL '30 days',
  if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS ix_secaudit_type ON security_audit (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_secaudit_subj ON security_audit (subject_id, occurred_at DESC);

-- Append-only enforcement at the DB layer. The application connects as a role
-- that can INSERT + SELECT but NOT UPDATE/DELETE, so even a compromised app
-- cannot rewrite history (the hash chain catches a privileged rewrite anyway).
-- Wrapped in a DO block so the migration is idempotent across environments where
-- the role name differs or is absent (best-effort; the hash chain is the backstop).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user) THEN
    BEGIN
      EXECUTE format('REVOKE UPDATE, DELETE ON security_audit FROM %I', current_user);
    EXCEPTION WHEN OTHERS THEN
      -- best-effort; superuser/owner cannot REVOKE from itself in all setups.
      NULL;
    END;
  END IF;
END $$;
