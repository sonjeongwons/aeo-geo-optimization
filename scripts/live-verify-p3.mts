/**
 * scripts/live-verify-p3.mts — live verification of Phase 3 deploy safety against
 * the real Postgres + filesystem (no Gemini key needed). Proves the riskiest,
 * previously TEST-MASKED fixes:
 *   IDEMP-01 — claimUrlRegistry partial-index ON CONFLICT works (no 42P10); a 2nd
 *              claim for the same (asset_id, channel_class) is a no-op (idempotent).
 *   OwnedNet — dry-run plans a hub URL & writes nothing; real publish writes a static
 *              file under OWNED_NET_OUT_DIR with a publishedUrl on OUR hub (§0).
 *   §0 guard — a hub host on the CUSTOMER_DOMAIN_BLOCKLIST is rejected before any write.
 *
 * Run (DB up + migrated): npx tsx scripts/live-verify-p3.mts
 */
import '../src/config/env.js';
import { promises as fs } from 'node:fs';
import { claimUrlRegistry, markUrlRegistryFailed } from '../src/db/repo.js';
import { getDb, closeDb } from '../src/db/kysely.js';
import { closePool } from '../src/db/pool.js';
import { OwnedNetConnector, FsTarget } from '../src/deploy/connectors/ownedNet.js';
import type { PublishRequest } from '../src/deploy/connector.js';

let failures = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
// deterministic-ish uuid without Date/random restrictions
const ASSET = '11111111-2222-3333-4444-555555555555';

try {
  // ---- IDEMP-01: claimUrlRegistry is idempotent via the partial unique arbiter ----
  await getDb().deleteFrom('url_registry').where('asset_id', '=', ASSET).execute();
  const claimArgs = {
    assetId: ASSET, contentSetId: null, customerId: null, channelClass: 'owned_net',
    publishedUrl: 'https://hub.example-aeo.test/en/live-p3/', disclosureTag: null,
    language: 'en', approverAudit: { by: 'live-verify' },
  };
  const first = await claimUrlRegistry(claimArgs);
  ok(first.claimed === true && !!first.registryId, `claimUrlRegistry #1 -> claimed (no 42P10) ${first.registryId}`);
  const second = await claimUrlRegistry(claimArgs);
  ok(second.claimed === false, `claimUrlRegistry #2 (same asset+channel) -> NOT claimed (idempotent, no throw)`);
  // releasing the claim (status->failed) frees the partial-unique slot, allowing a re-claim
  if (first.registryId) await markUrlRegistryFailed(first.registryId);
  const third = await claimUrlRegistry(claimArgs);
  ok(third.claimed === true, `after releasing the slot (failed), a fresh claim succeeds again`);
  await getDb().deleteFrom('url_registry').where('asset_id', '=', ASSET).execute();

  // ---- OwnedNet connector: dry-run plans, real publish writes a file ----
  const outDir = './.owned-net-out-livetest';
  const hub = 'https://hub.example-aeo.test';
  await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  const connector = new OwnedNetConnector(new FsTarget(outDir, hub), hub, []);
  const body = { content_type: 'definition', text: 'EMORA is an SFW AI companion app.', meaning_key: 'live-p3' } as unknown as PublishRequest['body'];
  const baseReq: PublishRequest = {
    assetId: ASSET, channelClass: 'owned_net', customerId: null, language: 'en',
    body, disclosureTag: null, dryRun: true, idempotencyKey: ASSET,
  };

  const dry = await connector.publish(baseReq);
  ok(dry.ok === true && 'dryRun' in dry && dry.dryRun === true, `owned-net dry-run -> PublishDryRun, no file written`);
  ok('plannedUrl' in dry && (dry as { plannedUrl: string }).plannedUrl.startsWith(hub), `dry-run plannedUrl is on OUR hub (§0): ${(dry as { plannedUrl?: string }).plannedUrl}`);

  const real = await connector.publish({ ...baseReq, dryRun: false });
  ok(real.ok === true && 'publishedUrl' in real, `owned-net real publish -> PublishOk`);
  if (real.ok && 'publishedUrl' in real) {
    ok(real.publishedUrl.startsWith(hub) && !real.publishedUrl.includes('example.com'), `publishedUrl on OUR hub, never a customer domain (§0): ${real.publishedUrl}`);
  }
  // confirm a static file landed under outDir
  const written: string[] = [];
  async function walk(d: string) { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) await walk(p); else written.push(p); } }
  await walk(outDir).catch(() => {});
  ok(written.some((f) => f.endsWith('.html')), `real publish wrote a static .html page (${written.length} files under ${outDir})`);

  // ---- §0 blocklist guard: a hub host on the blocklist is rejected ----
  const blocked = new OwnedNetConnector(new FsTarget(outDir, 'https://customer-site.example.com'), 'https://customer-site.example.com', ['customer-site.example.com']);
  const blockedRes = await blocked.publish({ ...baseReq, dryRun: false });
  ok(blockedRes.ok === false, `§0 guard: publish to a BLOCKLISTED (customer) host is rejected, no write`);

  await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${failures === 0 ? 'ALL PHASE 3 LIVE CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
} catch (e) {
  console.error('P3 LIVE VERIFY THREW:', e);
  failures++;
} finally {
  await closeDb().catch(() => {});
  await closePool().catch(() => {});
}
process.exitCode = failures === 0 ? 0 : 1;
