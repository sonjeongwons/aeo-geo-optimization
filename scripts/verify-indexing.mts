/** scripts/verify-indexing.mts
 *
 * Track 3b — HONEST, ToS-safe indexing verification for owned-net pages.
 *
 * Does a real HTTP GET on every published owned_net url_registry URL:
 *   - HTTP 200  → the page is publicly LIVE + crawlable → stamp 'submitted'
 *                 (honest: live on the web + in the sitemap, awaiting a search
 *                  engine to index it). We do NOT claim 'indexed'.
 *   - non-200   → 'not_indexed' (page not reachable).
 *
 * TRUE 'indexed' confirmation requires a real index API (Google Search Console
 * URL Inspection API / Bing Webmaster API) — those need OAuth/keys and are wired
 * separately when credentials arrive. We NEVER scrape search engines (§12) and
 * NEVER fabricate an 'indexed' signal (§7#3).
 *
 * Re-runnable: run this daily/weekly to track liveness over the indexing window.
 *
 * Usage: npx tsx scripts/verify-indexing.mts
 */
import "../src/config/env.js";
import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";
import { updateIndexingStatus } from "../src/db/repo.js";

async function head(url: string): Promise<number> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    // GET (some static hosts 405 on HEAD); we only need the status.
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal });
    clearTimeout(t);
    return res.status;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const rows = await getDb()
    .selectFrom("url_registry")
    .select(["id", "published_url", "channel_class", "indexing_status"])
    .where("publish_status", "=", "published")
    .where("channel_class", "=", "owned_net")
    .execute();

  console.log(`[verify-indexing] checking ${rows.length} published owned_net pages...`);
  let live = 0, dead = 0;
  for (const r of rows) {
    if (!r.published_url) continue;
    const code = await head(r.published_url);
    const next: "submitted" | "not_indexed" = code === 200 ? "submitted" : "not_indexed";
    if (code === 200) live++; else dead++;
    if (r.indexing_status !== next) await updateIndexingStatus(r.id, next);
    console.log(`  [${code === 200 ? "LIVE" : "DOWN"} ${code}] ${r.published_url}  (${r.indexing_status} -> ${next})`);
  }
  console.log(JSON.stringify({
    checked: rows.length,
    live_crawlable: live,
    not_reachable: dead,
    note: "'submitted' = live+crawlable+in sitemap, awaiting search index. 'indexed' requires Search Console/Bing Webmaster API (keys).",
  }, null, 2));
}

main()
  .catch((e) => { console.error("verify-indexing failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
