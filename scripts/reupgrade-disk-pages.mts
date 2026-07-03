/** scripts/reupgrade-disk-pages.mts
 *
 * Upgrade LEGACY owned-net pages that are NOT in this DB's url_registry (so
 * rerender-hub can't touch them) to the CURRENT render.ts template — adding
 * inline JSON-LD, the brand entity blurb, semantic <h1>, meta description, and
 * the hub-graph related-links — WITHOUT losing content.
 *
 * Content is reconstructed from the page's own index.md twin (clean source of
 * truth): a "### " heading marks an FAQ (Q + following paragraph = A); otherwise
 * the body becomes a single answer_block. datePublished is preserved from the old
 * index.html <meta name="date"> so freshness stays honest.
 *
 * Brand identity from HUB_BRAND env (same map as ownedNet.ts). Run per hub with
 * OWNED_NET_OUT_DIR + OWNED_NET_HUB_BASE_URL + HUB_BRAND set, then sync.
 *
 * Usage: OWNED_NET_OUT_DIR=./.owned-net-hub HUB_BRAND=emora npx tsx scripts/reupgrade-disk-pages.mts
 */
import "../src/config/env.js";
import { env } from "../src/config/env.js";
import { renderPage } from "../src/deploy/connectors/render.js";
import type { ContentBody } from "../src/content/types.js";
import { promises as fs } from "node:fs";
import path from "node:path";

const OUT = env.OWNED_NET_OUT_DIR;
const HUB = (env.OWNED_NET_HUB_BASE_URL ?? "").replace(/\/+$/, "");

const HUB_BRANDS: Record<string, { name: string; url: string; sameAs: string[]; description: string }> = {
  emora: { name: "EMORA", url: "https://tryemora.com", sameAs: ["https://tryemora.com"], description: "AI character chat platform for meaningful interactions — infinite memory, image generation, and a creator economy." },
  smim: { name: "스밈 (SMIM)", url: "https://smimdate.com", sameAs: ["https://smimdate.com"], description: "검증된 회원만 참여하는 로테이션 소개팅 서비스. 매주 금·토·일 서울에서 진행되며, 매니저가 직장·소득·신원·외모를 직접 검수합니다." },
};
const BRAND = HUB_BRANDS[(process.env["HUB_BRAND"] ?? "").toLowerCase()];

interface Page { lang: string; slug: string; dir: string; body: ContentBody; title: string; date: string; }

/** Parse an index.md twin into a ContentBody (faq when it has ### headings). */
function parseMd(md: string): { body: ContentBody; title: string } | null {
  // Strip the trailing "---\nSource: ..." footer.
  const cut = md.replace(/\n---\nSource:[\s\S]*$/m, "").trim();
  const lines = cut.split(/\r?\n/);
  if (lines.length === 0) return null;
  const title = (lines[0] ?? "").replace(/^#\s*/, "").trim();
  const rest = lines.slice(1).join("\n").trim();
  if (!rest) return null;

  if (/^###\s/m.test(rest)) {
    // FAQ: split on ### headings.
    const rows: Array<{ q: string; a: string; answer_claim_ids: string[] }> = [];
    const blocks = rest.split(/\n(?=###\s)/);
    for (const b of blocks) {
      const m = b.match(/^###\s*(.+?)\n([\s\S]*)$/);
      if (!m) continue;
      const q = m[1]!.trim();
      const a = m[2]!.trim().replace(/\s+/g, " ");
      if (q && a) rows.push({ q, a, answer_claim_ids: [] });
    }
    if (rows.length === 0) return null;
    return { body: { content_type: "faq", rows } as ContentBody, title: title || "FAQ" };
  }

  // Everything else → a single answer_block (renders as Article + JSON-LD).
  const text = rest.replace(/\s+/g, " ").trim();
  return {
    body: { content_type: "answer_block", text, length_units: Math.ceil(text.length / 5), numeric_claim_ids: [], source_ids: [] } as ContentBody,
    title: title || text.slice(0, 60),
  };
}

async function main(): Promise<void> {
  let langDirs: string[];
  try { langDirs = await fs.readdir(OUT); } catch { console.log("[reupgrade] no OUT dir"); return; }

  const pages: Page[] = [];
  for (const lang of langDirs) {
    if (!/^[a-z]{2}(-[A-Za-z]+)?$/.test(lang)) continue;
    const langPath = path.join(OUT, lang);
    let slugs: string[];
    try { if (!(await fs.stat(langPath)).isDirectory()) continue; slugs = await fs.readdir(langPath); } catch { continue; }
    for (const slug of slugs) {
      const dir = path.join(langPath, slug);
      let md: string;
      try { md = await fs.readFile(path.join(dir, "index.md"), "utf8"); } catch { continue; }
      const parsed = parseMd(md);
      if (!parsed) continue;
      let date = "2026-07-01T00:00:00.000Z";
      try {
        const oldHtml = await fs.readFile(path.join(dir, "index.html"), "utf8");
        date = oldHtml.match(/<meta name="date" content="([^"]+)">/)?.[1] ?? date;
      } catch { /* keep fallback */ }
      pages.push({ lang, slug, dir, body: parsed.body, title: parsed.title.slice(0, 80), date });
    }
  }

  const MAX_RELATED = 6;
  let n = 0;
  for (const p of pages) {
    const url = `${HUB}/${p.lang}/${p.slug}/`;
    const related = pages
      .filter((q) => q.lang === p.lang && q.slug !== p.slug)
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .slice(0, MAX_RELATED)
      .map((q) => ({ url: `${HUB}/${q.lang}/${q.slug}/`, title: q.title }));
    const html = renderPage({
      body: p.body,
      disclosureTag: null,
      canonicalUrl: url,
      language: p.lang,
      datePublished: p.date,
      ...(BRAND ? { brand: BRAND } : {}),
      ...(related.length > 0 ? { relatedLinks: related } : {}),
    });
    await fs.writeFile(path.join(p.dir, "index.html"), html, "utf8");
    n++;
  }
  console.log(`[reupgrade] upgraded ${n} legacy page(s) to the current template into ${OUT}`);
}

main().catch((e) => { console.error("reupgrade failed:", e); process.exitCode = 1; });
