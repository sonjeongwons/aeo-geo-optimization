/** scripts/seed-emora-claims.mts
 *
 * Seed claim_source rows for EMORA from a LIVE diagnosis of tryemora.com.
 *
 * §7#7 honesty: every capability claim a content asset makes must be backed by
 * a signed claim_source row. The productAttributes come from EMORA's OWN site
 * (a GET-only, SSRF-guarded diagnose), so the claims are grounded in EMORA's
 * own published statements — not fabricated. A human still signs each one
 * (review-claims) before any content can pass the gate.
 *
 * Usage: npx tsx scripts/seed-emora-claims.mts [--sign <email>]
 *   --sign <email>  also sign every seeded claim_source row (owner attestation).
 *
 * Prints the diagnosed productAttributes + the seeded/ signed claim ids.
 */
import "../src/config/env.js";
import { env } from "../src/config/env.js";
import { makeGeminiAdapter } from "../src/providers/gemini.js";
import { diagnose } from "../src/generate/diagnose.js";
import {
  findCustomerBySlug,
  seedClaimSourcesFromBrief,
  findClaimSources,
  signClaimSource,
  insertLlmCall,
} from "../src/db/repo.js";
import { closeDb } from "../src/db/kysely.js";
import { closePool } from "../src/db/pool.js";

const URL = "https://tryemora.com";
const SLUG = "emora";
const INDUSTRY = "ai-companion";

function parseSign(): string | null {
  const i = process.argv.indexOf("--sign");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

async function main(): Promise<void> {
  const signBy = parseSign();
  const customer = await findCustomerBySlug(SLUG);
  if (!customer) throw new Error(`customer slug=${SLUG} not found`);

  const adapter = makeGeminiAdapter(env.GEMINI_API_KEY);
  const ledger = { insertLlmCall: (c: Parameters<typeof insertLlmCall>[0]) => insertLlmCall(c) };

  console.log(`[seed-emora-claims] diagnosing ${URL} ...`);
  const result = await diagnose({ url: URL, industry: INDUSTRY, customerId: customer.id, adapter, ledger });
  if (!result.ok) throw new Error(`diagnose failed [${result.code}]: ${result.message}`);

  const brief = result.brief;
  console.log(`[seed-emora-claims] brand="${brief.brandName}" mode=${result.mode} conf=${brief.confidence}`);
  console.log(`[seed-emora-claims] productAttributes (${brief.productAttributes.length}):`);
  for (const a of brief.productAttributes) console.log(`   - ${a}`);

  const seeded = await seedClaimSourcesFromBrief(customer.id, brief);
  console.log(`[seed-emora-claims] seeded ${seeded.length} new claim_source rows.`);

  // Report the full current registry (incl. previously seeded).
  const all = await findClaimSources(customer.id);
  console.log(`[seed-emora-claims] total claim_source rows for EMORA: ${all.length}`);

  if (signBy) {
    let signedCount = 0;
    for (const cs of all) {
      if (cs.verified_by) continue;
      await signClaimSource(cs.id, signBy);
      signedCount++;
    }
    console.log(`[seed-emora-claims] signed ${signedCount} claim_source rows as ${signBy}.`);
  }

  console.log(JSON.stringify({
    customerId: customer.id,
    diagnosedAttributes: brief.productAttributes.length,
    seededNow: seeded.length,
    totalClaims: all.length,
    signed: signBy ?? null,
  }, null, 2));
}

main()
  .catch((e) => { console.error("seed-emora-claims failed:", e); process.exitCode = 1; })
  .finally(async () => { await closeDb().catch(() => {}); await closePool().catch(() => {}); });
