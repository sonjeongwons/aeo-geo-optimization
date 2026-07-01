/** scripts/ingest-competitor-facts.mts
 *
 * Ingest the EMORA team's `emora-competitor-facts.json` (produced via
 * EMORA-COMPETITOR-RESEARCH-PROMPT.md) into claim_source rows so the §7
 * claimVerificationGate can back comparison/"alternatives to X" pages with
 * VERIFIED, SOURCED facts. Without this, comparison content blocks (unsourced
 * competitor claims). §0: WE never fetch competitor URLs — the EMORA team
 * supplies the sourced facts; we only ingest them.
 *
 * Each non-"unknown" fact → one claim_source row:
 *   claim_text = the fact sentence (self-contained), source_ref = source_url,
 *   source_kind = 'external_url' (competitor) / 'customer_attested' (EMORA internal),
 *   claim_kind = 'comparison' (competitor) / 'capability' (EMORA).
 * Idempotent (skips claim_text already present). --sign <email> marks rows verified
 * (the EMORA team's sourced research IS the human attestation; required for §7 pass).
 *
 * Usage: npx tsx scripts/ingest-competitor-facts.mts <path-to.json> [--sign <email>] [--customer <slug>]
 */
import "../src/config/env.js";
import { getDb, closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";
import { findCustomerBySlug } from "../src/db/repo.js";
import { promises as fs } from "node:fs";

interface Fact { value: string; source_url?: string; source_quote?: string; date_checked?: string; confidence?: string; notes?: string; }
interface FactsFile {
  meta?: Record<string, unknown>;
  dimensions?: Array<{ key: string; group?: string; label?: string }>;
  emora?: Record<string, Fact>;
  competitors?: Array<{ name: string; key?: string; official_url?: string; facts: Record<string, Fact> }>;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function isUsable(f: Fact | undefined): f is Fact {
  return !!f && typeof f.value === "string" && f.value.trim().length > 0 && f.value.trim().toLowerCase() !== "unknown";
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith("-")) throw new Error("usage: ingest-competitor-facts <path.json> [--sign <email>] [--customer <slug>]");
  const signBy = arg("--sign") ?? null;
  const slug = arg("--customer") ?? "emora";

  const customer = await findCustomerBySlug(slug);
  if (!customer) throw new Error(`customer slug=${slug} not found`);

  const raw = await fs.readFile(file, "utf8");
  const data = JSON.parse(raw) as FactsFile;
  const db = getDb();

  const existing = new Set(
    (await db.selectFrom("claim_source").select(["claim_text"]).where("customer_id", "=", customer.id).execute())
      .map((r) => r.claim_text.toLowerCase().trim()),
  );

  const dimLabel = new Map((data.dimensions ?? []).map((d) => [d.key, d.label ?? d.key]));
  const toInsert: Array<{ claim_text: string; claim_kind: string; source_kind: string; source_ref: string }> = [];

  // EMORA's own facts
  for (const [dim, f] of Object.entries(data.emora ?? {})) {
    if (!isUsable(f)) continue;
    toInsert.push({
      claim_text: f.value.trim(),
      claim_kind: "capability",
      source_kind: f.source_url && f.source_url !== "internal" ? "public_url" : "customer_attested",
      source_ref: f.source_url ?? "internal",
    });
  }
  // Competitor facts
  for (const c of data.competitors ?? []) {
    for (const [dim, f] of Object.entries(c.facts ?? {})) {
      if (!isUsable(f)) continue;
      // Prefix the competitor name if the value doesn't already include it, so the
      // stored claim is self-contained ("Character.AI ...").
      const text = f.value.trim();
      const claim_text = text.toLowerCase().includes(c.name.toLowerCase()) ? text : `${c.name}: ${text} (re: ${dimLabel.get(dim) ?? dim})`;
      toInsert.push({
        claim_text,
        claim_kind: "comparative",
        source_kind: "public_url",
        source_ref: f.source_url ?? "",
      });
    }
  }

  let inserted = 0, skipped = 0;
  for (const row of toInsert) {
    const key = row.claim_text.toLowerCase().trim();
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key);
    await db.insertInto("claim_source").values({
      customer_id: customer.id,
      claim_text: row.claim_text,
      claim_kind: row.claim_kind,
      numeric_value: null,
      numeric_unit: null,
      numeric_bound: null,
      source_kind: row.source_kind,
      source_ref: row.source_ref || null,
      verified_by: signBy,
      verified_at: signBy ? new Date() : null,
    } as never).execute();
    inserted++;
  }

  console.log(JSON.stringify({
    customer: slug,
    facts_seen: toInsert.length,
    inserted,
    skipped_existing: skipped,
    signed: signBy,
    competitors: (data.competitors ?? []).map((c) => c.name),
  }, null, 2));
}

main()
  .catch((e) => { console.error("ingest-competitor-facts failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
