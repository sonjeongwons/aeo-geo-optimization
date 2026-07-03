/** scripts/leased-queue-ids.mts
 *
 * Print the space-separated content_deploy_queue ids that are currently
 * status='leased' on channel owned_net for a given customer. Used by
 * scripts/auto-publish.sh to hand leased rows to publish-owned-net.mts.
 *
 * Usage: npx tsx scripts/leased-queue-ids.mts <customerId>
 */
import "../src/config/env.js";
import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";

async function main(): Promise<void> {
  const customerId = process.argv[2];
  if (!customerId) {
    process.stderr.write("usage: leased-queue-ids <customerId>\n");
    process.exit(1);
  }
  const db = getDb();
  const rows = await db
    .selectFrom("content_deploy_queue as q")
    .innerJoin("content_asset as a", "a.id", "q.asset_id")
    .innerJoin("content_set as s", "s.id", "a.content_set_id")
    .select("q.id")
    .where("s.customer_id", "=", customerId)
    .where("q.channel_class", "=", "owned_net")
    .where("q.status", "=", "leased")
    .execute();
  process.stdout.write(rows.map((r) => r.id).join(" ") + "\n");
}

main()
  .catch((e) => {
    process.stderr.write(`leased-queue-ids failed: ${String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => {});
    await closePool().catch(() => {});
  });
