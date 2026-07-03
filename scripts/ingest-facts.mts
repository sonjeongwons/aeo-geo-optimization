/**
 * scripts/ingest-facts.mts — GENERIC owner-attested fact ingester.
 *
 * Reads a customer facts JSON (same shape as smim-facts.json / emora-facts.json)
 * and upserts each fact as a claim_source row so the §7 content gates can bind
 * generated copy to verified claims. source_kind=customer_attested,
 * verified_by=<meta.attested_by>. Idempotent (skips claim_text already present).
 *
 * §0: facts are OWNER-PROVIDED — never scraped. §7: gates still run on output.
 *
 * Usage: npx tsx scripts/ingest-facts.mts config/customers/emora-facts.json
 */
import "../src/config/env.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../src/db/kysely.js";
import { findCustomerBySlug, insertClaimSource } from "../src/db/repo.js";

interface Fact {
  text: string;
  kind: "capability" | "numeric" | "comparative" | "superlative";
  value?: number;
  unit?: string;
  bound?: "exact" | "upTo" | "atLeast";
}

async function main() {
  const rel = process.argv[2];
  if (!rel) {
    console.error("usage: ingest-facts <facts.json>");
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(resolve(rel), "utf8")) as {
    meta: { customer_slug: string; source_ref: string; attested_by: string };
    facts: Fact[];
  };

  const customer = await findCustomerBySlug(doc.meta.customer_slug);
  if (!customer) {
    console.error(`customer '${doc.meta.customer_slug}' not found`);
    process.exit(1);
  }

  const existing = new Set(
    (await getDb().selectFrom("claim_source").select(["claim_text"]).where("customer_id", "=", customer.id).execute())
      .map((r) => r.claim_text.toLowerCase().trim()),
  );

  let inserted = 0;
  const now = new Date();
  for (const f of doc.facts) {
    if (existing.has(f.text.toLowerCase().trim())) continue;
    await insertClaimSource({
      customerId: customer.id,
      claimText: f.text,
      claimKind: f.kind,
      numericValue: f.value ?? null,
      numericUnit: f.unit ?? null,
      numericBound: f.bound ?? null,
      sourceKind: "customer_attested",
      sourceRef: doc.meta.source_ref,
      verifiedBy: doc.meta.attested_by,
      verifiedAt: now,
    });
    inserted++;
    console.log("  + " + f.text);
  }
  console.log(`ingested ${inserted} new claim_source rows (skipped ${doc.facts.length - inserted} existing) for '${doc.meta.customer_slug}'.`);
  await getDb().destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
