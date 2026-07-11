/**
 * src/db/migrate.ts
 *
 * Runs node-pg-migrate migrations against DATABASE_URL.
 *
 * Usage:
 *   npm run migrate              — apply all pending migrations (up)
 *   npm run migrate -- --down 1  — roll back one migration
 *
 * Migration file types
 * --------------------
 * • .sql files  — node-pg-migrate wraps each file in its own BEGIN/COMMIT.
 *   This is fine for regular DDL (CREATE TABLE, CREATE VIEW, CREATE INDEX).
 *
 * • .cjs files  — CommonJS JS migrations loaded via require().  These call
 *   pgm.noTransaction() at the top of their up/down functions, which signals
 *   node-pg-migrate to omit the BEGIN/COMMIT wrapper entirely, letting each
 *   SQL statement auto-commit individually.
 *
 * TimescaleDB transaction restrictions
 * -------------------------------------
 * The following TimescaleDB operations MUST run outside an explicit transaction:
 *   • CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)
 *   • add_continuous_aggregate_policy()
 *   • add_compression_policy()
 *   • add_retention_policy()
 *
 * Because node-pg-migrate wraps .sql files in BEGIN/COMMIT even when
 * singleTransaction:false is set (singleTransaction:false only prevents
 * wrapping ALL migrations in ONE outer transaction — each .sql file still
 * gets its own individual BEGIN/COMMIT), the statements above live in .cjs
 * migrations (0004_cagg_policy.cjs, 0005_compression_retention.cjs) that
 * call pgm.noTransaction().
 *
 * To verify after Docker is available:
 *   docker compose up -d timescaledb && npm run migrate
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runner } from 'node-pg-migrate';
import { resolveDbConnection } from './pool.js';

// ---------------------------------------------------------------------------
// Resolve the migrations directory relative to this file's location so the
// script works regardless of cwd (important for `npm run migrate`).
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const downIdx = args.indexOf('--down');
const direction = downIdx !== -1 ? 'down' : 'up';
const count     = downIdx !== -1 ? parseInt(args[downIdx + 1] ?? '1', 10) : undefined;

// ---------------------------------------------------------------------------
// Run migrations
// ---------------------------------------------------------------------------
async function migrate(): Promise<void> {
  console.log(`[migrate] direction=${direction} dir=${MIGRATIONS_DIR}`);

  // Resolve DATABASE_URL with the SAME TLS handling as the app pool so migrations
  // connect to Timescale Cloud (self-signed chain) instead of failing. node-pg-migrate
  // accepts a ClientConfig object (connectionString + ssl) as `databaseUrl`.
  const dbConn = resolveDbConnection();

  const applied = await runner({
    databaseUrl: dbConn,
    dir: MIGRATIONS_DIR,
    direction,
    // count is only passed when rolling back; exactOptionalPropertyTypes
    // requires we not include the key at all when it is undefined.
    ...(count !== undefined ? { count } : {}),
    migrationsTable: 'pgmigrations',
    // singleTransaction:false means node-pg-migrate does NOT wrap all migrations
    // in one outer BEGIN/COMMIT.  Each .sql file still gets its own individual
    // BEGIN/COMMIT.  TimescaleDB-incompatible DDL (CAGG, compression/retention
    // policies) lives in .cjs migrations that call pgm.noTransaction() to also
    // skip the per-migration transaction wrapper.
    singleTransaction: false,
    // Verbose output surfaces any TimescaleDB NOTICE/WARNING messages.
    verbose: true,
    log: (msg: string) => console.log(`[migrate] ${msg}`),
  });

  if (applied.length === 0) {
    console.log('[migrate] No pending migrations — database is up to date.');
  } else {
    console.log(`[migrate] Applied ${applied.length} migration(s):`);
    for (const m of applied) {
      console.log(`  ✓ ${m.name}`);
    }
  }
}

migrate().catch((err: unknown) => {
  console.error('[migrate] FATAL:', err);
  process.exit(1);
});
