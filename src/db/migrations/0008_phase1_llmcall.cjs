/**
 * 0008_phase1_llmcall.cjs — Relax llm_call.run_id and llm_call.customer_id NOT NULL
 *
 * WHY A .cjs MIGRATION (not .sql):
 *   llm_call is a TimescaleDB hypertable. Although these are metadata-only
 *   ALTER COLUMN … DROP NOT NULL statements (no data movement), the established
 *   Phase 0 convention is to run any DDL touching a hypertable via a .cjs file
 *   with pgm.noTransaction() as a precaution (mirroring 0004_cagg_policy.cjs and
 *   0005_compression_retention.cjs).
 *
 * WHY RELAX NOT NULL:
 *   Phase 1 URL-first onboarding fires a Gemini diagnosis call BEFORE a customer
 *   row or a run row exist.  The existing llm_call constraints
 *     customer_id NOT NULL  — has NO FK to customer (verified: 0002_hypertables.sql)
 *     run_id      NOT NULL  — has NO FK to run     (verified: 0002_hypertables.sql)
 *   would prevent ledgering that pre-customer, pre-run spend via insertLlmCall.
 *   Dropping NOT NULL allows NULL values for onboarding-time calls while leaving
 *   operational (customer+run scoped) calls unaffected.
 *
 * COMPRESSION SAFETY:
 *   llm_call has NO compression policy (0005_compression_retention.cjs only
 *   compresses response_raw and mention_judgment — verified). There are therefore
 *   no compressed chunks to decompress before this ALTER; it is metadata-only.
 *
 * COST-DAILY CAGG IMPACT:
 *   cost_daily aggregates SUM(usd)/COUNT(*) GROUP BY day, customer_id.
 *   Rows with NULL customer_id group into a NULL-customer bucket and are excluded
 *   from per-customer budget reads (sumCostSince filters by customer_id = ?).
 *   Pre-customer diagnosis spend is intentionally gated by the global cap only
 *   (GLOBAL_WEEKLY_USD_CAP / GLOBAL_MONTHLY_USD_CAP in config/env.ts).
 *
 * IDEMPOTENCY:
 *   DROP NOT NULL is idempotent — safe to re-run if the column is already nullable.
 *   The down migration restores NOT NULL; it will fail if any NULLs have been
 *   inserted, which is the correct fail-closed behavior for a rollback.
 */

'use strict';

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = function (pgm) {
  // Run outside a transaction block (TimescaleDB hypertable DDL convention).
  pgm.noTransaction();

  // Relax run_id: onboarding-time diagnosis calls have no associated run.
  // run_id has NO FK constraint to run (verified in 0002_hypertables.sql).
  pgm.sql(`
    ALTER TABLE llm_call ALTER COLUMN run_id DROP NOT NULL;
  `);

  // Relax customer_id: URL-first diagnosis precedes any customer row.
  // customer_id has NO FK constraint to customer (verified in 0002_hypertables.sql).
  pgm.sql(`
    ALTER TABLE llm_call ALTER COLUMN customer_id DROP NOT NULL;
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = function (pgm) {
  pgm.noTransaction();

  // NOTE: restoring NOT NULL will fail if any NULL rows have been inserted.
  // This is intentional fail-closed behavior for a rollback.
  pgm.sql(`
    ALTER TABLE llm_call ALTER COLUMN customer_id SET NOT NULL;
  `);

  pgm.sql(`
    ALTER TABLE llm_call ALTER COLUMN run_id SET NOT NULL;
  `);
};
