import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";
const db = getDb();
// latest content_set for emora
const latest = await db.selectFrom("content_asset")
  .select(["content_set_id"])
  .where("content_type","=","comparison")
  .orderBy("created_at","desc").limit(1).executeTakeFirst().catch(()=>null);
// fallback: most recent set overall
const recent = await db.selectFrom("content_asset").select(["content_set_id","created_at"]).orderBy("created_at","desc").limit(1).executeTakeFirst();
console.log("most recent asset set:", recent?.content_set_id, recent?.created_at);
const setId = latest?.content_set_id ?? recent?.content_set_id;
const rows = await db.selectFrom("content_asset")
  .select(["id","content_type","channel_class","gate_status","gate_report"])
  .where("content_set_id","=",setId!)
  .where("content_type","=","comparison")
  .execute();
console.log("comparison assets in", setId, ":", rows.length, "->", rows.map(r=>r.gate_status).join(","));
for (const r of rows.slice(0,4)) {
  const gr = typeof r.gate_report==="string"?JSON.parse(r.gate_report):r.gate_report;
  const fails=(gr||[]).filter((g:any)=>g.action!=="pass");
  console.log("  ", r.id.slice(0,8), r.channel_class, r.gate_status, fails.map((g:any)=>g.gate+":"+g.action).join(" | ") || "ALL PASS");
}
await closeDb().catch(()=>{}); await closePool().catch(()=>{});
