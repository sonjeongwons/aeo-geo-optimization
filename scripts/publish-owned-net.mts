/** scripts/publish-owned-net.mts
 *
 * Directly invoke the publishUnit handler for specific approved owned_net queue
 * rows in EXECUTE mode (dryRun=false), so the OwnedNetConnector (FsTarget) writes
 * the real static page tree to OWNED_NET_OUT_DIR + a url_registry 'published' row.
 *
 * This avoids booting the full scheduler worker (which would trigger boot
 * catch-up = expensive operating cycles for every customer).
 *
 * Usage: npx tsx scripts/publish-owned-net.mts <queueId> [<queueId> ...]
 */
import "../src/config/env.js";
import { env } from "../src/config/env.js";
import { buildConnectorRegistry } from "../src/deploy/registry.js";
import { makeOwnedNetConnector } from "../src/deploy/connectors/ownedNet.js";
import { prWireConnector } from "../src/deploy/connectors/prWire.js";
import { directoryConnector } from "../src/deploy/connectors/directory.js";
import { web2Connector } from "../src/deploy/connectors/web2.js";
import { socialConnector } from "../src/deploy/connectors/social.js";
import { entityConnector } from "../src/deploy/connectors/entity.js";
import { publishUnit } from "../src/deploy/publishUnit.js";
import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";
import type { JobQueue } from "../src/scheduler/queue.js";

// No-op queue: publishUnit only enqueues publish.verify on success — safe to drop
// here (the url_registry row is already 'published'; verify is best-effort).
const noopQueue = {
  enqueue: async () => undefined,
  schedule: async () => undefined,
  work: async () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
} as unknown as JobQueue;

async function main(): Promise<void> {
  const queueIds = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (queueIds.length === 0) throw new Error("usage: publish-owned-net <queueId> [...]");

  const registry = buildConnectorRegistry([
    makeOwnedNetConnector(env.OWNED_NET_OUT_DIR, env.OWNED_NET_HUB_BASE_URL, env.CUSTOMER_DOMAIN_BLOCKLIST),
    prWireConnector,
    directoryConnector,
    web2Connector,
    socialConnector,
    entityConnector,
  ]);

  const db = getDb();
  for (const queueId of queueIds) {
    const row = await db
      .selectFrom("content_deploy_queue")
      .select(["id", "asset_id", "channel_class"])
      .where("id", "=", queueId)
      .executeTakeFirst();
    if (!row) { console.log(`queue ${queueId}: NOT FOUND`); continue; }

    console.log(`\n[publish] queue=${queueId} asset=${row.asset_id} channel=${row.channel_class} (EXECUTE)`);
    await publishUnit(
      { queueId: row.id, assetId: row.asset_id, channelClass: row.channel_class as never, dryRun: false },
      noopQueue,
      registry,
      false, // dryRunOverride = false → REAL publish
    );

    const reg = await db
      .selectFrom("url_registry")
      .select(["publish_status", "published_url", "indexing_status"])
      .where("asset_id", "=", row.asset_id)
      .where("channel_class", "=", row.channel_class)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    console.log(`  url_registry: status=${reg?.publish_status} url=${reg?.published_url} indexing=${reg?.indexing_status}`);
  }
}

main()
  .catch((e) => { console.error("publish-owned-net failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
