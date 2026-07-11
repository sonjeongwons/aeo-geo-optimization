/**
 * scripts/db-ping.mts — keep-alive ping so Timescale Cloud doesn't idle-suspend.
 *
 * A trivial `SELECT now()` (wakes a sleeping instance via waitForDb, then keeps
 * it warm). Run on a short cron (db-keepalive.yml) so the DB never sits idle long
 * enough to auto-pause. No Gemini, no writes.
 */
import "../src/config/env.js";
import { getPool, closePool, waitForDb } from "../src/db/pool.js";

async function main(): Promise<void> {
  await waitForDb();
  const r = await getPool().query("SELECT now() AS t");
  console.log(`[db-ping] ok — db time ${String(r.rows[0]?.t)}`);
}

main()
  .catch((e) => { console.error("db-ping failed:", e instanceof Error ? e.message : String(e)); process.exitCode = 1; })
  .finally(async () => { await closePool().catch(() => {}); });
