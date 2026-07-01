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
import { promises as fs } from "node:fs";
import path from "node:path";

const OUT = env.OWNED_NET_OUT_DIR;
const HUB = (env.OWNED_NET_HUB_BASE_URL ?? "").replace(/\/+$/, "");

// EMORA real public entity URLs for sameAs (entity disambiguation). Only the
// official site is asserted here (verified reachable). Add app-store / Wikidata
// / Crunchbase URLs when confirmed.
const EMORA_OFFICIAL = "https://tryemora.com";
const EMORA_SAME_AS = [EMORA_OFFICIAL];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

async function main(): Promise<void> {
  const rows = await getDb()
    .selectFrom("url_registry as u")
    .innerJoin("content_asset as a", "a.id", "u.asset_id")
    .select(["u.published_url", "a.language", "a.body", "u.published_at"])
    .where("u.publish_status", "=", "published")
    .where("u.channel_class", "=", "owned_net")
    .where("u.published_url", "like", `${HUB}%`)
    .execute();

  // Group by language
  const byLang = new Map<string, Array<{ url: string; title: string }>>();
  for (const r of rows) {
    const lang = (r.language as string) || "en";
    const title = bodyTitle(r.body).slice(0, 110);
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang)!.push({ url: r.published_url as string, title });
  }

  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "EMORA",
    url: EMORA_OFFICIAL,
    sameAs: EMORA_SAME_AS,
    description: "AI character chat platform with memory, image generation, and a creator economy.",
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
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="${esc(HUB)}/">
  <title>EMORA — AI character chat platform: answers & guides</title>
  <meta name="description" content="Answer pages about EMORA, an AI character chat platform with memory, image generation, and a creator economy. Official site: ${esc(EMORA_OFFICIAL)}">
  <script type="application/ld+json">
${JSON.stringify(orgJsonLd, null, 2)}
  </script>
</head>
<body>
  <main>
    <h1>EMORA — AI character chat platform</h1>
    <p>EMORA is an AI character chat platform offering memory-rich conversations, in-chat image
       generation, group chats, and a creator economy. Official site:
       <a href="${esc(EMORA_OFFICIAL)}">${esc(EMORA_OFFICIAL)}</a>.</p>
    <p>This hub collects answer pages about EMORA's features and how it compares for common needs.
       See the <a href="${esc(HUB)}/sitemap.xml">sitemap</a> and
       <a href="${esc(HUB)}/llms.txt">llms.txt</a>.</p>
${sections}
  </main>
  <footer>
    <p>${rows.length} answer page(s). Auto-generated, §7-gated.</p>
  </footer>
</body>
</html>`;

  await fs.writeFile(path.join(OUT, "index.html"), html, "utf8");
  console.log(`[hub-index] wrote linking index.html: ${rows.length} pages across ${byLang.size} language(s) + Organization JSON-LD`);
}

main()
  .catch((e) => { console.error("gen-hub-index failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
