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
  <title>${esc(BRAND.titleTag)}</title>
  <meta name="description" content="${esc(BRAND.metaDescription)} Official site: ${esc(EMORA_OFFICIAL)}">
  <script type="application/ld+json">
${JSON.stringify(orgJsonLd, null, 2)}
  </script>
</head>
<body>
  <main>
    <h1>${esc(BRAND.h1)}</h1>
    <p>${BRAND.introHtml}
       <a href="${esc(EMORA_OFFICIAL)}">${esc(EMORA_OFFICIAL)}</a>.</p>
    <p>See the <a href="${esc(HUB)}/sitemap.xml">sitemap</a> and
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
