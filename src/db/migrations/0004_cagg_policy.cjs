/**
 * 0004_cagg_policy.cjs — cost_daily view
 *
 * Originally a TimescaleDB continuous aggregate (CAGG) with a background
 * refresh policy. Migrated (2026-09) to a plain PostgreSQL VIEW: at this
 * project's data volume (thousands of rows, not millions) a live view over
 * llm_call costs nothing meaningful to compute and is always up to date —
 * strictly better than a CAGG's refresh-lag staleness, with no background
 * policy to maintain. All read call sites (src/db/repo.ts, src/cost/*) already
 * treat cost_daily as an opaque read-only relation, so this is a drop-in swap.
 *
 * date_trunc('day', ts) replaces TimescaleDB's time_bucket('1 day', ts) —
 * identical semantics for a 1-day bucket.
 */

'use strict';

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  pgm.sql(`
    CREATE OR REPLACE VIEW cost_daily AS
      SELECT
        date_trunc('day', ts) AS day,
        customer_id,
        sum(usd)                          AS usd,
        count(*)                          AS calls,
        count(*) FILTER (WHERE cache_hit) AS cache_hits
      FROM llm_call
      GROUP BY day, customer_id;
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = function (pgm) {
  pgm.sql(`DROP VIEW IF EXISTS cost_daily;`);
};
