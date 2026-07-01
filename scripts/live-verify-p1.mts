/**
 * scripts/live-verify-p1.mts — live verification of the Phase 1 template lifecycle
 * against the real Postgres (no Gemini key needed). Proves:
 *   TLI-02 — nextTemplateVersion avoids the uq_industry_template_version collision
 *   partial unique index uq_industry_template_active blocks TWO active per industry
 *   TLI-01 — atomic demote+activate inside ONE transaction (executor injection)
 *
 * Run (DB up + migrated): npx tsx scripts/live-verify-p1.mts
 */
import { getDb, closeDb } from '../src/db/kysely.js';
import { closePool } from '../src/db/pool.js';
import {
  nextTemplateVersion, insertIndustryTemplate, updateTemplateStatus,
  demoteActiveTemplate, getLatestActiveTemplate,
} from '../src/db/repo.js';

const IND = 'live-test-industry';
let failures = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

async function activeCount(): Promise<number> {
  const rows = await getDb().selectFrom('industry_template')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('industry', '=', IND).where('status', '=', 'active').execute();
  return parseInt(rows[0]!.n as unknown as string, 10);
}

try {
  // clean any prior run
  await getDb().deleteFrom('industry_template').where('industry', '=', IND).execute();

  // TLI-02: version computed, no collision on the (industry, version) unique index
  const v1 = await nextTemplateVersion(IND);
  ok(v1 === 1, `nextTemplateVersion on empty industry -> 1 (got ${v1})`);
  const t1 = await insertIndustryTemplate({ industry: IND, version: v1, status: 'draft', questions: [{ text: 'q1', language: 'en' }], competitors: [{ name: 'C1' }] });
  const v2 = await nextTemplateVersion(IND);
  ok(v2 === 2, `nextTemplateVersion after v1 exists -> 2 (got ${v2})`);
  let collided = false;
  try {
    const t2 = await insertIndustryTemplate({ industry: IND, version: v2, status: 'draft', questions: [{ text: 'q2', language: 'ja' }], competitors: [{ name: 'C2' }] });
    ok(!!t2.id, `insert second draft v2 WITHOUT version collision -> ${t2.id}`);
    var id2 = t2.id;
  } catch (e) {
    collided = true;
    ok(false, `second draft insert collided (TLI-02 not fixed): ${String(e).slice(0, 80)}`);
  }
  const id1 = t1.id;

  // activate v1
  await updateTemplateStatus(id1, 'active');
  ok((await activeCount()) === 1, `after activating v1, active count = 1`);

  // partial unique index must block a SECOND active for the same industry
  let blocked = false;
  try {
    await updateTemplateStatus(id2!, 'active');
  } catch {
    blocked = true;
  }
  ok(blocked, `uq_industry_template_active BLOCKS a second active for the industry`);
  ok((await activeCount()) === 1, `still exactly 1 active after the blocked attempt`);

  // TLI-01: atomic demote-then-activate inside ONE transaction
  await getDb().transaction().execute(async (trx) => {
    await demoteActiveTemplate(IND, trx);
    await updateTemplateStatus(id2!, 'active', undefined, trx);
  });
  ok((await activeCount()) === 1, `after atomic demote+activate, exactly 1 active`);
  const latest = await getLatestActiveTemplate(IND);
  ok(!!latest && latest.id === id2, `the active template is now v2 (atomic swap succeeded)`);

  // cleanup
  await getDb().deleteFrom('industry_template').where('industry', '=', IND).execute();

  console.log(`\n${failures === 0 ? 'ALL PHASE 1 LIVE CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
} catch (e) {
  console.error('P1 LIVE VERIFY THREW:', e);
  failures++;
} finally {
  await closeDb().catch(() => {});
  await closePool().catch(() => {});
}
process.exit(failures === 0 ? 0 : 1);
