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
  const pool = getPool();
  const r = await pool.query("SELECT now() AS t");
  console.log(`[db-ping] ok — db time ${String(r.rows[0]?.t)}`);
  // Fingerprint the live DB (confirms WHICH db + data presence).
  try {
    const cust = await pool.query("SELECT slug, id FROM customer ORDER BY slug");
    const runs = await pool.query("SELECT customer_id, count(*)::int n, coalesce(max(n_total),0)::int maxn FROM run GROUP BY customer_id");
    const runMap = new Map(runs.rows.map((x: { customer_id: string; n: number; maxn: number }) => [x.customer_id, x]));
    console.log("[db-ping] customers:");
    for (const c of cust.rows as Array<{ slug: string; id: string }>) {
      const rc = runMap.get(c.id) as { n: number; maxn: number } | undefined;
      console.log(`  ${c.slug} ${c.id} — runs=${rc?.n ?? 0} maxNTotal=${rc?.maxn ?? 0}`);
    }
  } catch (e) {
    console.log(`[db-ping] fingerprint skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main()
  .catch((e) => { console.error("db-ping failed:", e instanceof Error ? e.message : String(e)); process.exitCode = 1; })
  .finally(async () => { await closePool().catch(() => {}); });
