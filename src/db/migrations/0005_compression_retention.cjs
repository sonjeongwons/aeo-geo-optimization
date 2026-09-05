/**
 * 0005_compression_retention.cjs — NO-OP (was TimescaleDB compression +
 * retention policies for response_raw/mention_judgment).
 *
 * Migrated (2026-09) off TimescaleDB Cloud to vanilla PostgreSQL (Neon).
 * Compression/retention policies have no plain-Postgres equivalent and buy
 * nothing at this project's data volume (thousands of rows, not the
 * millions+ these policies are meant for) — dropped rather than replaced.
 * If retention is ever needed again, do it as an explicit DELETE cron once
 * volume actually warrants it.
 *
 * Kept as a migration file (rather than deleted) only to preserve the
 * numbering/history of the migrations directory.
 */

'use strict';

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = function (_pgm) {};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = function (_pgm) {};
