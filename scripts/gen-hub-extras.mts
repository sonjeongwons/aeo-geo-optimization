/** scripts/gen-hub-extras.mts
 *
 * Research rank-9 (discovery hygiene): generate, for the live owned-net hub,
 *   (a) a Markdown TWIN of every published page (index.md next to index.html) —
 *       the SAME content re-rendered as clean markdown, served to EVERYONE
 *       (no user-agent switching → NOT cloaking), better for LLM extraction.
 *   (b) /llms.txt  — the AnswerDotAI manifest (curated list of citable pages).
 *   (c) /llms-full.txt — full markdown of every page concatenated.
 *
 * Source of truth = DB (url_registry published owned_net rows + content_asset
 * bodies), NOT HTML parsing. Writes into OWNED_NET_OUT_DIR (the hub repo dir).
 * Run scripts/sync-owned-net-github.sh afterwards to publish.
 *
 * Usage: npx tsx scripts/gen-hub-extras.mts
 */
import "../src/config/env.js";
import { env } from "../src/config/env.js";
import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";
import { promises as fs } from "node:fs";
import path from "node:path";

const OUT = env.OWNED_NET_OUT_DIR;
const HUB = (env.OWNED_NET_HUB_BASE_URL ?? "").replace(/\/+$/, "");

interface PageRow { published_url: string; language: string; content_type: string; body: unknown; }

function bodyToMarkdown(b: any): { title: string; md: string } {
  switch (b?.content_type) {
    case "definition":
      return { title: String(b.text).slice(0, 70), md: String(b.text) };
    case "answer_block":
      return { title: String(b.text).split(/[.。!?]/)[0].slice(0, 70), md: String(b.text) };
    case "faq":
      return {
        title: "FAQ",
        md: (b.rows || []).map((r: any) => `### ${r.q}\n\n${r.a}`).join("\n\n"),
      };
    case "comparison":
      return {
        title: "Comparison",
        md: [
          `| ${["", ...(b.columns || [])].join(" | ")} |`,
          `| ${["---", ...(b.columns || []).map(() => "---")].join(" | ")} |`,
          ...(b.rows || []).map((r: any) => `| ${[r.entity, ...(r.cells || []).map((c: any) => c.value)].join(" | ")} |`),
        ].join("\n"),
      };
    case "case_study":
      return { title: "Case study", md: [b.situation, b.action, b.result].filter(Boolean).join("\n\n") };
    default:
      return { title: "Page", md: "" };
  }
}

/** Local dir for a published_url like https://host/aeo-owned-net-hub/en/ab12cd34/ */
function localDirOf(url: string): string | null {
  try {
    const u = new URL(url);
    // strip the repo-base path prefix so we land inside OUT
    const parts = u.pathname.split("/").filter(Boolean); // [repo, lang, id8]
    const tail = parts.slice(-2); // [lang, id8]
    if (tail.length !== 2) return null;
    return path.join(OUT, tail[0]!, tail[1]!);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const rows = (await getDb()
    .selectFrom("url_registry as u")
    .innerJoin("content_asset as a", "a.id", "u.asset_id")
    .select(["u.published_url", "a.language", "a.content_type", "a.body"])
    .where("u.publish_status", "=", "published")
    .where("u.channel_class", "=", "owned_net")
    .where("u.published_url", "like", `${HUB}%`)
    .execute()) as PageRow[];

  console.log(`[hub-extras] ${rows.length} live pages → markdown twins + llms.txt`);

  const manifest: string[] = [
    "# AEO/GEO Owned-Net Hub",
    "",
    "> Auto-generated, §7-gated brand answer pages. Each page answers one question and is",
    "> available as HTML and as a Markdown twin (append index.md).",
    "",
    "## Pages",
    "",
  ];
  const fullParts: string[] = ["# AEO/GEO Owned-Net Hub — full content\n"];

  for (const r of rows) {
    const dir = localDirOf(r.published_url);
    if (!dir) continue;
    const { title, md } = bodyToMarkdown(r.body);
    const pageMd = `# ${title}\n\n${md}\n\n---\nSource: ${r.published_url}\n`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "index.md"), pageMd, "utf8");
    } catch (e) {
      console.error(`  failed ${dir}:`, e);
      continue;
    }
    manifest.push(`- [${title}](${r.published_url}) (${r.language}) — [markdown](${r.published_url}index.md)`);
    fullParts.push(`\n## ${title} (${r.language})\n${r.published_url}\n\n${md}\n`);
  }

  await fs.writeFile(path.join(OUT, "llms.txt"), manifest.join("\n") + "\n", "utf8");
  await fs.writeFile(path.join(OUT, "llms-full.txt"), fullParts.join("\n") + "\n", "utf8");
  console.log(`[hub-extras] wrote ${rows.length} index.md + llms.txt + llms-full.txt into ${OUT}`);
  console.log(`[hub-extras] llms.txt: ${HUB}/llms.txt`);
}

main()
  .catch((e) => { console.error("gen-hub-extras failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
