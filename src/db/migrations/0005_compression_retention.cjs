/**
 * 0005_compression_retention.cjs — TimescaleDB compression + retention policies
 *
 * WHY A JS MIGRATION (not SQL):
 *   add_compression_policy() and add_retention_policy() acquire advisory locks
 *   and register background workers internally, which Postgres forbids inside an
 *   explicit transaction block (ERROR: cannot be called from a transaction).
 *   node-pg-migrate wraps every .sql file in BEGIN/COMMIT automatically.
 *   Calling pgm.noTransaction() here tells node-pg-migrate to skip that wrapper
 *   so these statements execute at autocommit level, which TimescaleDB requires.
 *
 * IDEMPOTENCY:
 *   • ALTER TABLE ... SET (timescaledb.compress, ...) is idempotent.
 *   • add_compression_policy / add_retention_policy use if_not_exists => true.
 *
 * SCHEMA CONTEXT (from 0002_hypertables.sql):
 *   response_raw  — hypertable on captured_at
 *   mention_judgment — hypertable on captured_at
 *   (llm_call is the CAGG base hypertable, handled in 0004_cagg_policy.cjs)
 *
 * VERIFY (once Docker is available):
 *   docker compose up -d timescaledb && npm run migrate
 */

'use strict';

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // Tell node-pg-migrate NOT to wrap this migration in BEGIN/COMMIT.
  pgm.noTransaction();

  // ---------------------------------------------------------------------------
  // response_raw: compress after 30 days, retain 365 days
  // Segmented by customer_id for efficient per-customer scans.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    ALTER TABLE response_raw
      SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'customer_id'
      );
  `);

  pgm.sql(`
    SELECT add_compression_policy('response_raw', INTERVAL '30 days', if_not_exists => true);
  `);

  pgm.sql(`
    SELECT add_retention_policy('response_raw', INTERVAL '365 days', if_not_exists => true);
  `);

  // ---------------------------------------------------------------------------
  // mention_judgment: compress after 90 days (judgments kept longer for re-audit)
  // No retention policy — judgments retained indefinitely by design.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    ALTER TABLE mention_judgment
      SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'customer_id'
      );
  `);

  pgm.sql(`
    SELECT add_compression_policy('mention_judgment', INTERVAL '90 days', if_not_exists => true);
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = function (pgm) {
  pgm.noTransaction();

  pgm.sql(`SELECT remove_compression_policy('mention_judgment', if_not_exists => true);`);
  pgm.sql(`SELECT remove_compression_policy('response_raw',     if_not_exists => true);`);
  pgm.sql(`SELECT remove_retention_policy  ('response_raw',     if_not_exists => true);`);

  pgm.sql(`
    ALTER TABLE response_raw
      RESET (timescaledb.compress, timescaledb.compress_segmentby);
  `);

  pgm.sql(`
    ALTER TABLE mention_judgment
      RESET (timescaledb.compress, timescaledb.compress_segmentby);
  `);
};
