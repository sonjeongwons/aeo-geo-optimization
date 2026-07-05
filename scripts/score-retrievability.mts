/**
 * scripts/score-retrievability.mts — pre/post-publish RETRIEVABILITY diagnostic.
 *
 * The leading indicator (deep-exploration top lever): before spending weeks
 * waiting on Share-of-Model-Recall, measure whether our published passages are
 * even RETRIEVABLE for the target queries we optimize for. For each active
 * question (target query) we score cosine(query, best-passage); a query with no
 * strong/moderate passage is a CONTENT GAP — the hub can't be cited for it
 * because the retriever won't surface anything.
 *
 * Uses Gemini text-embedding-004 via GeminiEmbeddingAdapter — OFF (graceful
 * no-op) without GEMINI_API_KEY or on a quota error. §7: internal advisory
 * signal, uncalibrated bands — never a customer-facing guarantee.
 *
 * Usage: npx tsx scripts/score-retrievability.mts --customer emora [--lang en]
 */
import "../src/config/env.js";
import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";
import { findCustomerBySlug, findActiveQuestions } from "../src/db/repo.js";
import { makeGeminiEmbeddingAdapter } from "../src/providers/geminiEmbed.js";
import { retrievabilityScore } from "../src/metrics/retrievability.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Owned-net hub per customer (published assets are owned-net GENERIC —
// customer_id is NULL — so passages are loaded by hub URL, not customer_id).
const HUBS: Record<string, string> = {
  emora: "https://sonjeongwons.github.io/aeo-owned-net-hub",
  smimdate: "https://sonjeongwons.github.io/aeo-smim-hub",
};

/** Flatten one asset body into its retrievable passage strings. */
function passagesOf(body: any): string[] {
  switch (body?.content_type) {
    case "definition":
    case "answer_block":
      return [String(body.text ?? "")].filter((s) => s.trim().length > 0);
    case "faq":
      return (body.rows ?? []).map((r: any) => `${r.q} ${r.a}`).filter((s: string) => s.trim().length > 0);
    case "comparison":
      return (body.rows ?? []).map((r: any) => `${r.entity}: ${(r.cells ?? []).map((c: any) => c.value).join(", ")}`);
    case "case_study":
      return [[body.situation, body.action, body.result].filter(Boolean).join(" ")].filter((s) => s.trim().length > 0);
    default:
      return [];
  }
}

async function main(): Promise<void> {
  const slug = arg("--customer");
  const langFilter = arg("--lang");
  if (!slug) { console.error("usage: score-retrievability --customer <slug> [--lang <code>]"); process.exit(1); }

  const customer = await findCustomerBySlug(slug);
  if (!customer) { console.error(`customer '${slug}' not found`); process.exit(1); }

  // Target queries = the active measured questions (per language).
  const questions = await findActiveQuestions(customer.id);

  // Passages = published owned_net asset bodies on this customer's hub (assets are
  // owned-net generic → customer_id NULL → filter by hub URL, not customer_id).
  const hub = arg("--hub") ?? HUBS[slug];
  if (!hub) { console.error(`no hub mapping for '${slug}' — pass --hub <baseUrl>`); process.exit(1); }
  const rows = await getDb()
    .selectFrom("url_registry as u")
    .innerJoin("content_asset as a", "a.id", "u.asset_id")
    .select(["a.language", "a.body"] as never)
    .where("u.published_url", "like", `${hub}%`)
    .where("u.publish_status", "=", "published")
    .where("u.channel_class", "=", "owned_net")
    .execute();

  const langs = [...new Set([...questions.map((q) => q.language), ...(rows as any[]).map((r) => r.language)])]
    .filter((l) => !langFilter || l === langFilter);

  const adapter = makeGeminiEmbeddingAdapter(process.env["GEMINI_API_KEY"]);
  if (adapter.status() !== "ready") {
    console.log(JSON.stringify({ customer: slug, skipped: "GEMINI_API_KEY not set — embeddings off" }, null, 2));
    return;
  }

  const report: Record<string, unknown> = { customer: slug, byLanguage: {} };
  for (const lang of langs) {
    const qs = questions.filter((q) => q.language === lang).map((q) => q.text);
    const passages = (rows as any[]).filter((r) => r.language === lang).flatMap((r) => passagesOf(r.body));
    if (qs.length === 0 || passages.length === 0) {
      (report.byLanguage as any)[lang] = { skipped: `${qs.length} queries / ${passages.length} passages` };
      continue;
    }
    let passEmb: number[][], qEmb: number[][];
    try {
      [passEmb, qEmb] = await Promise.all([adapter.embed(passages), adapter.embed(qs)]);
    } catch (e) {
      (report.byLanguage as any)[lang] = { skipped: `embedding error (likely quota): ${String(e).slice(0, 80)}` };
      continue;
    }
    if (passEmb.length === 0 || qEmb.length === 0) {
      (report.byLanguage as any)[lang] = { skipped: "no embeddings returned" };
      continue;
    }
    const perQ = qEmb.map((qe, i) => ({ query: qs[i]!, ...retrievabilityScore(qe, passEmb) }));
    const covered = perQ.filter((p) => p.band !== "weak").length;
    const gaps = perQ.filter((p) => p.band === "weak").sort((a, b) => a.maxCosine - b.maxCosine).slice(0, 8)
      .map((p) => ({ query: p.query.slice(0, 80), maxCosine: Number(p.maxCosine.toFixed(3)) }));
    (report.byLanguage as any)[lang] = {
      nQueries: qs.length, nPassages: passages.length,
      coverage: Number((covered / qs.length).toFixed(3)),
      meanMax: Number((perQ.reduce((s, p) => s + p.maxCosine, 0) / perQ.length).toFixed(3)),
      contentGaps: gaps,
    };
  }
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((e) => { console.error("score-retrievability failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
