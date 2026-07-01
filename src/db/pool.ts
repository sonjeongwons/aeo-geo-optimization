/**
 * src/db/pool.ts
 *
 * Singleton pg.Pool instance backed by DATABASE_URL.
 * All DB access (Kysely + raw queries) flows through this pool.
 *
 * The pool is exported as a lazy singleton — imported modules do NOT open
 * connections at module-load time; connections are only acquired when the
 * first query runs.
 */

import pg from 'pg';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Pool singleton
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

/**
 * Returns the singleton pg.Pool, creating it on first call.
 * Max connections: 10 (safe for a single-service Phase 0 deployment).
 */
export function getPool(): pg.Pool {
  if (_pool === null) {
    _pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // Surface pool-level errors to stderr — never swallow them silently.
    _pool.on('error', (err: Error) => {
      process.stderr.write(`[pool] Unexpected pool error: ${err.message}\n`);
    });
  }

  return _pool;
}

/**
 * Closes the pool — call only during graceful shutdown.
 */
export async function closePool(): Promise<void> {
  if (_pool !== null) {
    await _pool.end();
    _pool = null;
  }
}
