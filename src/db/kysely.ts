/**
 * src/db/kysely.ts
 *
 * Singleton Kysely instance wired to the pg pool.
 *
 * Uses the built-in PostgresDialect so Kysely drives pg.Pool directly.
 * CamelCasePlugin is NOT used — we keep snake_case column names matching the
 * DDL exactly, and the repo layer maps to domain types explicitly.
 */

import { Kysely, PostgresDialect } from 'kysely';
import { getPool } from './pool.js';
import type { Database } from './schema.js';

// ---------------------------------------------------------------------------
// Kysely singleton
// ---------------------------------------------------------------------------

let _db: Kysely<Database> | null = null;

/**
 * Returns the singleton Kysely<Database> instance, creating it on first call.
 * The underlying pg.Pool is initialized lazily by getPool().
 */
export function getDb(): Kysely<Database> {
  if (_db === null) {
    _db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: getPool(),
      }),
    });
  }

  return _db;
}

/**
 * Destroys the Kysely instance — call only during graceful shutdown after
 * closePool() or as part of the same teardown sequence.
 */
export async function closeDb(): Promise<void> {
  if (_db !== null) {
    await _db.destroy();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Re-export the Database type for consumers that need it without importing schema
// ---------------------------------------------------------------------------
export type { Database } from './schema.js';
