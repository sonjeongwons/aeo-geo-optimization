/**
 * scripts/backfill-legacy-hub-urls.mts
 *
 * Register LEGACY owned-net hub pages (rendered on-disk, never routed through the
 * deploy pipeline, so absent from url_registry) as the TRUE published facts they
 * are. Reads the hub's live sitemap.xml (source of truth for what is actually
 * live), and inserts one url_registry row per <loc>:
 *   - asset_id = deterministic UUIDv5(published_url)  (stable synthetic key; there
 *     is no draft content_asset for these legacy pages, and url_registry.asset_id
 *     has NO FK — verified — so this is a real publish record, not fabricated data)
 *   - publish_status = 'published'   (TRUE — the URL is live)
 *   - indexing_status = 'unknown'    (HONEST — indexing not confirmed; §7)
 *   - publish_meta.backfill = 'legacy-disk-sitemap' (audit provenance)
 * Idempotent: ON CONFLICT (asset_id, channel_class) WHERE published DO NOTHING.
 *
 * Why: the weekly email counts "발행 페이지" from url_registry; legacy hubs showed 0
 * despite live pages. This makes the count honest without touching page content.
 *
 * Usage:
 *   HUB=https://sonjeongwons.github.io/aeo-owned-net-hub \
 *   CUSTOMER_ID=b1d999e5-c8c1-4f6a-90a3-4d7dc2773ad5 \
 *   [DRY=1] npx tsx scripts/backfill-legacy-hub-urls.mts
 */
import "../src/config/env.js";
import { getPool, closePool, waitForDb } from "../src/db/pool.js";
import { createHash } from "node:crypto";

const HUB = (process.env["HUB"] ?? "").replace(/\/+$/, "");
const CUSTOMER_ID = process.env["CUSTOMER_ID"] ?? "";
const DRY = process.env["DRY"] === "1";
// Fixed project namespace for deterministic UUIDv5 (arbitrary constant UUID).
const NS = "6f1c2a90-3e5b-4d21-9f8a-0c7b1e2d4a63";

function uuidv5(name: string): string {
  const nsBytes = Buffer.from(NS.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(nsBytes).update(name, "utf8").digest();
  const b = h.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Language = first path segment after the hub base (e.g. .../aeo-…-hub/en/slug/ → "en"). */
function langOf(url: string): string {
  const rest = url.slice(HUB.length).replace(/^\/+/, "");
  const seg = rest.split("/")[0] ?? "";
  return /^[a-z]{2}(-[A-Za-z]+)?$/.test(seg) ? seg : "en";
}

async function main() {
  if (!HUB || !CUSTOMER_ID) throw new Error("HUB and CUSTOMER_ID env are required");
  await waitForDb();
  const pool = getPool();

  // Fetch the live sitemap — the authoritative list of published pages.
  const res = await fetch(`${HUB}/sitemap.xml`);
  if (!res.ok) throw new Error(`sitemap fetch ${res.status}`);
  const xml = await res.text();
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
    .map((m) => m[1]!.trim())
    .filter((u) => u.startsWith(HUB));
  const uniq = [...new Set(urls)];
  console.log(`[backfill] ${uniq.length} live URL(s) from ${HUB}/sitemap.xml`);

  if (DRY) {
    for (const u of uniq) console.log(`  [DRY] ${langOf(u)}  ${u}  asset_id=${uuidv5(u)}`);
    return;
  }

  let inserted = 0;
  for (const u of uniq) {
    const r = await pool.query(
      `INSERT INTO url_registry
         (id, asset_id, customer_id, channel_class, published_url, language,
          publish_status, indexing_status, publish_meta, published_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owned_net', $3, $4,
          'published', 'unknown',
          jsonb_build_object('backfill','legacy-disk-sitemap','hubBaseUrl',$5::text), now(), now())
       ON CONFLICT (asset_id, channel_class)
         WHERE publish_status IN ('publishing','published') DO NOTHING`,
      [uuidv5(u), CUSTOMER_ID, u, langOf(u), HUB],
    );
    inserted += r.rowCount ?? 0;
  }
  console.log(`[backfill] inserted ${inserted} new row(s) (existing skipped).`);
  const cnt = await pool.query(
    "SELECT count(*)::int n FROM url_registry WHERE published_url LIKE $1 AND publish_status='published' AND channel_class='owned_net'",
    [`${HUB}%`],
  );
  console.log(`[backfill] url_registry now has ${cnt.rows[0].n} published owned_net row(s) for this hub.`);
}

main()
  .catch((e) => { console.error("backfill failed:", e instanceof Error ? e.message : String(e)); process.exitCode = 1; })
  .finally(async () => { await closePool().catch(() => {}); });
