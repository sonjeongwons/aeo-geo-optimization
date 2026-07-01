/**
 * 0004_cagg_policy.cjs — cost_daily continuous aggregate + refresh policy
 *
 * WHY A JS MIGRATION (not SQL):
 *   TimescaleDB forbids CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)
 *   and add_continuous_aggregate_policy() inside an explicit transaction block.
 *   node-pg-migrate wraps every .sql file in BEGIN/COMMIT automatically.
 *   Calling pgm.noTransaction() here tells node-pg-migrate to skip that wrapper
 *   so these statements execute at autocommit level, which TimescaleDB requires.
 *
 * IDEMPOTENCY:
 *   • CREATE MATERIALIZED VIEW uses IF NOT EXISTS.
 *   • add_continuous_aggregate_policy uses if_not_exists => true.
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

  // Create the continuous aggregate materialized view.
  // time_bucket('1 day', ts) partitions cost ledger rows into daily buckets per customer.
  pgm.sql(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS cost_daily
      WITH (timescaledb.continuous)
      AS
      SELECT
        time_bucket('1 day', ts) AS day,
        customer_id,
        sum(usd)                 AS usd,
        count(*)                 AS calls,
        count(*) FILTER (WHERE cache_hit) AS cache_hits
      FROM llm_call
      GROUP BY day, customer_id;
  `);

  // Register an automatic refresh policy: keep the CAGG current within 1 hour,
  // covering up to 35 days of history. if_not_exists prevents failure on re-run.
  pgm.sql(`
    SELECT add_continuous_aggregate_policy(
      'cost_daily',
      start_offset      => INTERVAL '35 days',
      end_offset        => INTERVAL '1 hour',
      schedule_interval => INTERVAL '1 hour',
      if_not_exists     => true
    );
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = function (pgm) {
  pgm.noTransaction();

  pgm.sql(`SELECT remove_continuous_aggregate_policy('cost_daily', if_not_exists => true);`);
  pgm.sql(`DROP MATERIALIZED VIEW IF EXISTS cost_daily;`);
};
