/** scripts/gen-hub-index.mts
 *
 * Build a real LINKING hub index.html (research critique gap: internal linking /
 * hub-graph is a first-class discovery lever — low-authority pages only get
 * crawled if something links to them; the homepage should link every answer page)
 * + Organization JSON-LD with sameAs (rank-5 entity disambiguation hygiene; NOT
 * claimed as a citation lever, §7/rank-11).
 *
 * Source of truth = DB (published owned_net pages). Writes .owned-net-hub/index.html.
 * Run scripts/sync-owned-net-github.sh afterwards. Pure code — no LLM / Gemini cost.
 *
 * Usage: npx tsx scripts/gen-hub-index.mts
 */
import "../src/config/env.js";
import { env } from "../src/config/env.js";
import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";
import { PAGE_STYLE, renderRobots, renderRss, type RssItem } from "../src/deploy/connectors/render.js";
import { promises as fs } from "node:fs";
import path from "node:path";

const OUT = env.OWNED_NET_OUT_DIR;
const HUB = (env.OWNED_NET_HUB_BASE_URL ?? "").replace(/\/+$/, "");

// Per-brand hub identity (multi-tenant). The hub is single-brand PER repo so the
// Organization JSON-LD / homepage never cross-associate two customers' entities
// (§7 entity hygiene). Select via HUB_BRAND env (default 'emora'). Description +
// intro carry ONLY owner-verifiable facts — no superlatives (§7).
interface HubBrand {
  htmlLang: string;
  orgName: string;
  official: string;
  sameAs: string[];
  orgDescription: string;
  h1: string;
  introHtml: string;
  titleTag: string;
  metaDescription: string;
}
const BRANDS: Record<string, HubBrand> = {
  emora: {
    htmlLang: "en",
    orgName: "EMORA",
    official: "https://tryemora.com",
    sameAs: ["https://tryemora.com"],
    orgDescription:
      "AI character chat platform with memory, image generation, and a creator economy.",
    h1: "EMORA — AI character chat platform",
    introHtml:
      "EMORA is an AI character chat platform offering memory-rich conversations, in-chat image\n       generation, group chats, and a creator economy. Official site:",
    titleTag: "EMORA — AI character chat platform: answers & guides",
    metaDescription:
      "Answer pages about EMORA, an AI character chat platform with memory, image generation, and a creator economy.",
  },
  smim: {
    htmlLang: "ko",
    orgName: "스밈 (SMIM)",
    official: "https://smimdate.com",
    sameAs: ["https://smimdate.com"],
    orgDescription:
      "검증된 회원만 참여하는 로테이션 소개팅 서비스. 매주 금·토·일 서울에서 진행되며, 매니저가 신청자의 직장·소득·신원·외모를 직접 검수합니다.",
    h1: "스밈 (SMIM) — 검증된 회원 로테이션 소개팅",
    introHtml:
      "스밈은 검증된 회원만 참여하는 로테이션 소개팅 서비스입니다. 매주 금·토·일 서울에서 진행되며,\n       매니저가 신청자의 직장·소득·신원·외모를 직접 검수합니다. 공식 사이트:",
    titleTag: "스밈 (SMIM) — 검증된 회원 로테이션 소개팅: 안내",
    metaDescription:
      "스밈에 대한 안내 페이지 — 검증된 회원만 참여하는 로테이션 소개팅 서비스. 매주 금·토·일 서울, 매니저 직접 검수.",
  },
};
const BRAND: HubBrand = BRANDS[(process.env.HUB_BRAND ?? "emora").toLowerCase()] ?? BRANDS.emora!;
const EMORA_OFFICIAL = BRAND.official;
const EMORA_SAME_AS = BRAND.sameAs;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Reverse esc() for titles SCANNED from already-escaped on-disk <title> tags, so
 * the single esc() at emit time does not double-escape (W5.3: "EMORA&#39;s" was
 * displayed literally). DB-derived titles are raw and skip this.
 */
function htmlUnescape(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function bodyTitle(b: any): string {
  switch (b?.content_type) {
    case "definition": return String(b.text);
    case "answer_block": return String(b.text).split(/[.。!?]/)[0];
    case "comparison": return "Comparison";
    case "faq": return "FAQ";
    case "case_study": return "Case study";
    default: return "Answer";
  }
}

/**
 * Scan the hub OUT dir for existing <lang>/<slug>/index.html pages. Used to MERGE
 * on-disk pages that predate this DB (or whose url_registry row is absent) so a
 * DB-driven rebuild never DROPS already-published pages from the index. Title is
 * read from the page's <title> tag; falls back to the slug.
 */
async function scanDiskPages(
  outDir: string,
  hub: string,
): Promise<Array<{ url: string; lang: string; title: string }>> {
  const out: Array<{ url: string; lang: string; title: string }> = [];
  let entries: string[];
  try { entries = await fs.readdir(outDir); } catch { return out; }
  for (const lang of entries) {
    if (!/^[a-z]{2}(-[A-Za-z]+)?$/.test(lang)) continue; // language dirs only
    const langPath = path.join(outDir, lang);
    let slugs: string[];
    try {
      if (!(await fs.stat(langPath)).isDirectory()) continue;
      slugs = await fs.readdir(langPath);
    } catch { continue; }
    for (const slug of slugs) {
      let html: string;
      try { html = await fs.readFile(path.join(langPath, slug, "index.html"), "utf8"); } catch { continue; }
      const m = html.match(/<title>([^<]*)<\/title>/i);
      // The scanned <title> is already HTML-escaped; unescape so the single
      // esc() at emit time doesn't double-escape (W5.3).
      out.push({ url: `${hub}/${lang}/${slug}/`, lang, title: htmlUnescape((m?.[1] ?? slug).trim()) });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const rows = await getDb()
    .selectFrom("url_registry as u")
    .innerJoin("content_asset as a", "a.id", "u.asset_id")
    .select(["u.published_url", "a.language", "a.body", "u.published_at"])
    .where("u.publish_status", "=", "published")
    .where("u.channel_class", "=", "owned_net")
    .where("u.published_url", "like", `${HUB}%`)
    .execute();

  // Group by language — DB pages first (richer titles), then MERGE any on-disk
  // pages not covered by the DB so a rebuild never drops existing pages.
  const seen = new Set<string>();
  const byLang = new Map<string, Array<{ url: string; title: string }>>();
  const add = (lang: string, url: string, title: string): void => {
    if (seen.has(url)) return;
    seen.add(url);
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang)!.push({ url, title });
  };
  for (const r of rows) {
    add((r.language as string) || "en", r.published_url as string, bodyTitle(r.body).slice(0, 110));
  }
  for (const p of await scanDiskPages(OUT, HUB)) {
    add(p.lang, p.url, p.title.slice(0, 110));
  }

  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: BRAND.orgName,
    url: EMORA_OFFICIAL,
    sameAs: EMORA_SAME_AS,
    description: BRAND.orgDescription,
  };

  const langLabel: Record<string, string> = { en: "English", ko: "한국어", ja: "日本語", zh: "中文", "zh-TW": "繁體中文", es: "Español" };

  const sections = [...byLang.entries()]
    .sort((a, b) => (a[0] === "en" ? -1 : b[0] === "en" ? 1 : a[0].localeCompare(b[0])))
    .map(([lang, items]) => {
      const lis = items
        .map((it) => `      <li><a href="${esc(it.url)}">${esc(it.title)}</a></li>`)
        .join("\n");
      return `    <section>\n      <h2>${esc(langLabel[lang] ?? lang)}</h2>\n      <ul>\n${lis}\n      </ul>\n    </section>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="${esc(BRAND.htmlLang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="${esc(HUB)}/">
  <link rel="alternate" type="application/rss+xml" title="${esc(BRAND.orgName)}" href="${esc(HUB)}/feed.xml">
  <title>${esc(BRAND.titleTag)}</title>
  <meta name="description" content="${esc(BRAND.metaDescription)} Official site: ${esc(EMORA_OFFICIAL)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(BRAND.titleTag)}">
  <meta property="og:description" content="${esc(BRAND.metaDescription)}">
  <meta property="og:url" content="${esc(HUB)}/">
  <style>${PAGE_STYLE}</style>
  <script type="application/ld+json">
${JSON.stringify(orgJsonLd, null, 2)}
  </script>
</head>
<body>
  <header class="site"><a href="${esc(EMORA_OFFICIAL)}" rel="home">${esc(BRAND.orgName)}</a></header>
  <main>
    <h1>${esc(BRAND.h1)}</h1>
    <p>${BRAND.introHtml}
       <a href="${esc(EMORA_OFFICIAL)}">${esc(EMORA_OFFICIAL)}</a>.</p>
    <p>See the <a href="${esc(HUB)}/sitemap.xml">sitemap</a> and
       <a href="${esc(HUB)}/llms.txt">llms.txt</a>.</p>
${sections}
  </main>
  <footer>
    <p>${seen.size} answer page(s) · <a href="${esc(EMORA_OFFICIAL)}" rel="home">${esc(BRAND.orgName)}</a></p>
  </footer>
</body>
</html>`;

  await fs.writeFile(path.join(OUT, "index.html"), html, "utf8");

  // Emit a citation-bot-friendly robots.txt advertising the sitemap (W9.1) — the
  // cheapest real discovery lever for ChatGPT-search / Perplexity / Gemini.
  await fs.writeFile(path.join(OUT, "robots.txt"), renderRobots({ sitemapUrl: `${HUB}/sitemap.xml` }), "utf8");

  // Emit an RSS 2.0 feed (W9.3) — a freshness discovery lever (Perplexity). Built
  // from DB rows carrying a real published_at; newest-first inside renderRss.
  const feedItems: RssItem[] = [];
  for (const r of rows) {
    const at = r.published_at as Date | string | null;
    if (at == null) continue;
    const iso = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
    const title = bodyTitle(r.body).slice(0, 110);
    feedItems.push({ url: r.published_url as string, title, description: title, isoDate: iso });
  }
  const feedXml = renderRss({
    title: BRAND.titleTag,
    homeUrl: `${HUB}/`,
    feedUrl: `${HUB}/feed.xml`,
    language: BRAND.htmlLang,
    description: BRAND.metaDescription,
    items: feedItems,
  });
  await fs.writeFile(path.join(OUT, "feed.xml"), feedXml, "utf8");

  console.log(`[hub-index] wrote linking index.html: ${seen.size} pages across ${byLang.size} language(s) + Organization JSON-LD + robots.txt + feed.xml (${feedItems.length} items)`);
}

main()
  .catch((e) => { console.error("gen-hub-index failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
