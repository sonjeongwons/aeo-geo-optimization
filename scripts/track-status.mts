/** scripts/track-status.mts
 *
 * Append a timestamped status snapshot to tracking/status-log.jsonl so we have a
 * persistent TIME SERIES of the off-site program over days/weeks/months:
 *   - live owned-net pages + indexing_status breakdown (our liveness signal)
 *   - latest measured SMR (brand-mention rate) per completed run (the outcome signal)
 *
 * Run this on a schedule (pg-boss cron, OS cron, or manual). It is the cheap,
 * $0 heartbeat; a full SMR RE-MEASUREMENT (npm run diagnose, real Gemini cost) is
 * separate and run on a slower cadence.
 *
 * NOTE on indexing: the authoritative 24/7 indexing tracker is Google Search
 * Console (property already verified). This script records OUR liveness, not
 * Google's index state (which needs the Search Console API / a key to read).
 *
 * Usage: npx tsx scripts/track-status.mts
 */
import "../src/config/env.js";
import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";
import { promises as fs } from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  const db = getDb();

  // Liveness: owned-net pages by indexing_status
  const idx = await db
    .selectFrom("url_registry")
    .select(["indexing_status", (eb) => eb.fn.countAll<string>().as("n")])
    .where("publish_status", "=", "published")
    .where("channel_class", "=", "owned_net")
    .groupBy("indexing_status")
    .execute();
  const indexing: Record<string, number> = {};
  for (const r of idx) indexing[r.indexing_status as string] = Number(r.n);

  // Latest completed run SMR per customer (brand mention rate)
  const runs = await db
    .selectFrom("run")
    .innerJoin("customer", "customer.id", "run.customer_id")
    .select(["run.id as run_id", "customer.slug", "run.kind", "run.n_total", "run.finished_at"])
    .where("run.status", "=", "completed")
    .orderBy("run.finished_at", "desc")
    .limit(5)
    .execute();

  const smr: Array<{ slug: string; run_id: string; kind: string; brand_hits: number; n_judged: number; smr_pct: number }> = [];
  for (const r of runs) {
    const agg = await db
      .selectFrom("run_smr_overall")
      .select(["brand_hits", "judged_ok"])
      .where("run_id", "=", r.run_id)
      .executeTakeFirst();
    if (agg) {
      const hits = Number(agg.brand_hits ?? 0);
      const judged = Number(agg.judged_ok ?? 0);
      smr.push({
        slug: r.slug as string,
        run_id: r.run_id as string,
        kind: r.kind as string,
        brand_hits: hits,
        n_judged: judged,
        smr_pct: judged > 0 ? Math.round((hits / judged) * 10000) / 100 : 0,
      });
    }
  }

  const snapshot = {
    ts: new Date().toISOString(),
    hub_live_pages: Object.values(indexing).reduce((a, b) => a + b, 0),
    indexing_status: indexing,
    latest_smr: smr,
  };

  const dir = path.join(process.cwd(), "tracking");
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, "status-log.jsonl"), JSON.stringify(snapshot) + "\n", "utf8");
  console.log(JSON.stringify(snapshot, null, 2));
}

main()
  .catch((e) => { console.error("track-status failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
