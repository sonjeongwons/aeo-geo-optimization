/** scripts/make-session.mts — mint a dashboard session for demo@aeo.test and
 * print the raw cookie value, so authed pages can be driven via curl.
 * Run: npx tsx scripts/make-session.mts   (prints: aeo_session=<token>) */
import '../src/config/env.js';
import { findAppUserByEmail, createSession } from '../src/db/repo.js';
import { createSessionToken } from '../src/auth/session.js';
import { closeDb } from '../src/db/kysely.js';
import { closePool } from '../src/db/pool.js';

const TTL = 30 * 24 * 60 * 60 * 1000;
try {
  const user = await findAppUserByEmail('demo@aeo.test');
  if (!user) throw new Error('demo@aeo.test not found — run scripts/dev-seed-web.mts');
  const token = createSessionToken();
  await createSession({ userId: user.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + TTL) });
  console.log('aeo_session=' + token.raw);
} catch (e) {
  console.error('make-session failed:', e); process.exitCode = 1;
} finally {
  await closeDb().catch(() => {}); await closePool().catch(() => {});
}
