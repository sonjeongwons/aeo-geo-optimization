/** scripts/rerender-hub.mts
 *
 * Re-render every live owned-net page's index.html with the CURRENT render.ts
 * template (so render improvements like the rank-7 visible "Last updated" footer
 * apply to already-published pages) — WITHOUT touching url_registry / re-publishing.
 *
 * datePublished is kept as the ORIGINAL publish time (url_registry.published_at),
 * so the visible date stays honest (we are not bumping freshness).
 *
 * Usage: npx tsx scripts/rerender-hub.mts   (then sync-owned-net-github.sh)
 */
import "../src/config/env.js";
import { env } from "../src/config/env.js";
import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";
import { renderPage } from "../src/deploy/connectors/render.js";
import type { ContentBody } from "../src/content/types.js";
import { promises as fs } from "node:fs";
import path from "node:path";

const OUT = env.OWNED_NET_OUT_DIR;
const HUB = (env.OWNED_NET_HUB_BASE_URL ?? "").replace(/\/+$/, "");

// Brand identity for JSON-LD Organization + entity blurb (mirrors ownedNet.ts /
// gen-hub-index). Selected by HUB_BRAND env; omitted when unset.
const HUB_BRANDS: Record<string, { name: string; url: string; sameAs: string[]; description: string }> = {
  emora: { name: "EMORA", url: "https://tryemora.com", sameAs: ["https://tryemora.com"], description: "AI character chat platform for meaningful interactions — infinite memory, image generation, and a creator economy." },
  smim: { name: "스밈 (SMIM)", url: "https://smimdate.com", sameAs: ["https://smimdate.com"], description: "검증된 회원만 참여하는 로테이션 소개팅 서비스. 매주 금·토·일 서울에서 진행되며, 매니저가 직장·소득·신원·외모를 직접 검수합니다." },
};
const BRAND = HUB_BRANDS[(process.env["HUB_BRAND"] ?? "").toLowerCase()];

function localDirOf(url: string): string | null {
  try {
    const u = new URL(url);
    const tail = u.pathname.split("/").filter(Boolean).slice(-2);
    return tail.length === 2 ? path.join(OUT, tail[0]!, tail[1]!) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const rows = await getDb()
    .selectFrom("url_registry as u")
    .innerJoin("content_asset as a", "a.id", "u.asset_id")
    .select(["u.published_url", "u.published_at", "a.language", "a.disclosure_tag", "a.body"])
    .where("u.publish_status", "=", "published")
    .where("u.channel_class", "=", "owned_net")
    .where("u.published_url", "like", `${HUB}%`)
    .execute();

  let n = 0;
  for (const r of rows) {
    const dir = localDirOf(r.published_url as string);
    if (!dir) continue;
    const datePublished = (r.published_at instanceof Date ? r.published_at : new Date()).toISOString();
    const html = renderPage({
      body: r.body as ContentBody,
      disclosureTag: (r.disclosure_tag as string | null) ?? null,
      canonicalUrl: r.published_url as string,
      language: r.language as string,
      datePublished,
      ...(BRAND ? { brand: BRAND } : {}),
    });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
    n++;
  }
  console.log(`[rerender-hub] re-rendered ${n} page(s) with the current template into ${OUT}`);
}

main()
  .catch((e) => { console.error("rerender-hub failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
