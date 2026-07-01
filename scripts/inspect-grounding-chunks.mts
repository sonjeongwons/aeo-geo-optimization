/**
 * scripts/inspect-grounding-chunks.mts — dump the RAW grounding chunks stored for
 * a run so we can see exactly which chunk uri/title resolves to a given domain
 * (targeted self-audit of domainForChunk on real data). Read-only.
 *
 * Run: npx tsx scripts/inspect-grounding-chunks.mts <runId>
 */
import "../src/config/env.js";
import { getDb } from "../src/db/kysely.js";
import { domainForChunk, type GroundingTrace } from "../src/judge/groundingGap.js";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: npx tsx scripts/inspect-grounding-chunks.mts <runId>");
  process.exit(1);
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

async function main() {
  const db = getDb();
  const rows = await db
    .selectFrom("response_raw")
    .select(["id", "model_id", "provider_meta"])
    .where("run_id", "=", runId)
    .execute();

  console.log(`run ${runId}: ${rows.length} response_raw rows\n`);
  let idx = 0;
  for (const row of rows) {
    const meta = (typeof row.provider_meta === "string" ? safeJson(row.provider_meta) : row.provider_meta) as { grounding?: GroundingTrace } | null;
    const g = meta?.grounding;
    if (!g) { console.log(`[${idx++}] ${row.model_id}: no grounding`); continue; }
    console.log(`[${idx++}] ${row.model_id}: ${g.chunks.length} chunks`);
    for (const c of g.chunks) {
      const resolved = domainForChunk(c.uri, c.title);
      const flag = resolved === "google.com" ? "  <<< google.com" : "";
      console.log(`     uri=${(c.uri || "").slice(0, 70)}`);
      console.log(`     title=${JSON.stringify(c.title)} → ${resolved}${flag}`);
    }
    console.log("");
  }
  await db.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
