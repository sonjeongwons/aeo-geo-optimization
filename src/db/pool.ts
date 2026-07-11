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
 * Resolve DATABASE_URL into a node-postgres connection config with correct TLS.
 *
 * Cloud Postgres (Timescale Cloud, sslmode=require) presents a cert chain that
 * Node may not trust ("self-signed certificate in certificate chain"). For
 * non-localhost hosts we enable TLS with relaxed CA verification (still encrypted
 * in transit) and STRIP `sslmode` from the connection string so the ssl object —
 * not the connstring keyword — controls TLS. Localhost dev stays plain.
 *
 * Shared by getPool() AND src/db/migrate.ts (node-pg-migrate) so BOTH honour the
 * same TLS handling — otherwise migrations fail against Timescale even when the
 * app pool connects fine.
 */
export function resolveDbConnection(): { connectionString: string; ssl?: pg.PoolConfig["ssl"] } {
  let ssl: pg.PoolConfig["ssl"];
  let connectionString = env.DATABASE_URL;
  try {
    const u = new URL(env.DATABASE_URL);
    const host = u.hostname;
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLocal || /sslmode=require/i.test(env.DATABASE_URL)) {
      ssl = { rejectUnauthorized: false };
      u.searchParams.delete("sslmode");
      connectionString = u.toString();
    }
  } catch { /* leave connectionString/ssl as-is */ }
  return ssl ? { connectionString, ssl } : { connectionString };
}

/**
 * Returns the singleton pg.Pool, creating it on first call.
 * Max connections: 10 (safe for a single-service Phase 0 deployment).
 */
export function getPool(): pg.Pool {
  if (_pool === null) {
    const { connectionString: connStr, ssl } = resolveDbConnection();

    _pool = new pg.Pool({
      connectionString: connStr,
      max: 10,
      ...(ssl ? { ssl } : {}),
      idleTimeoutMillis: 30_000,
      // Timescale Cloud (dev tier) SUSPENDS on idle and takes tens of seconds to
      // wake — a 5s timeout failed the daily email. Give a single attempt room to
      // land on an awake DB; waitForDb() handles the wake-from-suspend case.
      connectionTimeoutMillis: 20_000,
    });

    // Surface pool-level errors to stderr — never swallow them silently.
    _pool.on('error', (err: Error) => {
      process.stderr.write(`[pool] Unexpected pool error: ${err.message}\n`);
    });
  }

  return _pool;
}

/**
 * Wait for the DB to be reachable, retrying with backoff — wakes a suspended
 * Timescale Cloud instance (its first connection after idle times out while it
 * spins up). Call at the START of any cron/CLI entrypoint before real queries.
 * Throws only after all retries are exhausted.
 */
export async function waitForDb(retries = 8, baseDelayMs = 2_500): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await getPool().query('SELECT 1');
      if (attempt > 1) process.stderr.write(`[db] ready after ${attempt} attempt(s)\n`);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const wait = Math.min(20_000, baseDelayMs * Math.pow(1.6, attempt - 1));
      process.stderr.write(
        `[db] not ready (attempt ${attempt}/${retries}: ${err instanceof Error ? err.message : String(err)}) — waking, retry in ${Math.round(wait)}ms\n`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(
    `waitForDb: DB unreachable after ${retries} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
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
