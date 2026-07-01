/**
 * scripts/live-verify.mts — live ground-truth verification against the real
 * TimescaleDB (no Gemini key needed). Proves the two biggest critical fixes:
 *   (1) jsonb-array insert (competitors_found / provider_meta / judge_raw)
 *   (2) latest-judgment-wins (current_judgment DISTINCT ON), evidence CHECK
 * plus the full config->DB seed path (loadTemplate).
 *
 * Run: npx tsx scripts/live-verify.mts
 */
import { loadTemplate } from '../src/config/loadTemplate.js';
import { findCustomerBySlug, findActiveQuestions, createRun, insertResponseRaw, insertJudgment, findCurrentJudgmentsForRun } from '../src/db/repo.js';
import { closeDb } from '../src/db/kysely.js';
import { closePool } from '../src/db/pool.js';

let failures = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

try {
  // 1) config -> DB seed (idempotent upsert against live DB)
  await loadTemplate('config/customers/emora.yaml');
  await loadTemplate('config/customers/emora.yaml'); // twice => idempotent
  const customer = await findCustomerBySlug('emora');
  ok(!!customer, `loadTemplate(emora) upserted customer (idempotent x2) -> ${customer?.id}`);
  if (!customer) throw new Error('no customer');

  const questions = await findActiveQuestions(customer.id);
  ok(questions.length > 0, `findActiveQuestions -> ${questions.length} questions`);
  const q = questions[0];

  // 2) run -> response_raw (with provider_meta jsonb object) -> judgment (with competitors_found array incl rank:null)
  const run = await createRun({ customerId: customer.id, kind: 'baseline', nSamples: 3, temperature: 0.7 });
  ok(!!run.id, `createRun -> ${run.id}`);

  const raw = await insertResponseRaw({
    runId: run.id, customerId: customer.id, questionId: q.id, modelId: 'gemini-2.5-flash',
    language: q.language, sampleIdx: 0, temperature: 0.7, requestHash: 'live-verify-hash-0',
    promptVersion: 'v1', answerText: 'EMORA is a great SFW alternative. Character.AI is also popular.',
    providerMeta: { finishReason: 'STOP', live: true }, status: 'ok',
  });
  ok(!!raw.id, `insertResponseRaw (provider_meta jsonb object) -> ${raw.id}`);

  // THE CRITICAL FIX: competitors_found is a JS array (with a rank:null entry) bound to a jsonb column
  const judged = await insertJudgment({
    responseRawId: raw.id, runId: run.id, customerId: customer.id, questionId: q.id,
    modelId: 'gemini-2.5-flash', language: q.language, responseStatus: 'ok',
    brandMentioned: true, brandRank: 1, sentiment: 'positive',
    competitorsFound: [{ name: 'Character.AI', rank: 2 }, { name: 'Replika', rank: null }],
    evidenceQuote: 'EMORA is a great SFW alternative', evidenceStart: 0, evidenceEnd: 33,
    provenance: 'judge', judgeModel: 'gemini-2.5-flash', judgeRaw: { brand_mentioned: true },
    guardrailStatus: 'pass',
  });
  ok(!!judged.id, `insertJudgment with non-empty competitors_found ARRAY (jsonb) -> ${judged.id}`);

  // read back via current_judgment view
  let cur = await findCurrentJudgmentsForRun(run.id);
  ok(cur.length === 1, `current_judgment returns 1 row for run`);
  const cf = cur[0]?.competitors_found as unknown;
  ok(Array.isArray(cf), `competitors_found round-trips as a JSON ARRAY (not {}) -> ${JSON.stringify(cf)}`);
  ok(Array.isArray(cf) && (cf as any[]).length === 2, `competitors_found has 2 entries incl rank:null`);

  // 3) latest-judgment-wins: append a SECOND judgment for the same response, expect view to show only the newest
  await insertJudgment({
    responseRawId: raw.id, runId: run.id, customerId: customer.id, questionId: q.id,
    modelId: 'gemini-2.5-flash', language: q.language, responseStatus: 'ok',
    brandMentioned: false, brandRank: null, sentiment: 'neutral',
    competitorsFound: [], evidenceQuote: null, evidenceStart: null, evidenceEnd: null,
    provenance: 'abstain', judgeModel: 'gemini-2.5-flash', judgeRaw: null, guardrailStatus: 'pass',
    capturedAt: new Date(Date.now() + 1000),
  });
  cur = await findCurrentJudgmentsForRun(run.id);
  ok(cur.length === 1, `after re-judge, current_judgment STILL 1 row (latest-wins, no double-count)`);
  ok(cur[0]?.brand_mentioned === false, `current_judgment shows the LATEST judgment (brand_mentioned=false)`);
  ok(Array.isArray(cur[0]?.competitors_found) && (cur[0]!.competitors_found as any[]).length === 0,
     `empty competitors_found round-trips as [] (not {})`);

  console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : failures + ' LIVE CHECK(S) FAILED'}`);
} catch (e) {
  console.error('LIVE VERIFY THREW:', e);
  failures++;
} finally {
  await closeDb().catch(() => {});
  await closePool().catch(() => {});
}
process.exit(failures === 0 ? 0 : 1);
