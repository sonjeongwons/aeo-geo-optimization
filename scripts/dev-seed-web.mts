/**
 * scripts/dev-seed-web.mts — create a DEV login user for the dashboard, linked to
 * the emora customer (which already has run/report data). Idempotent.
 *
 * Run: npx tsx scripts/dev-seed-web.mts
 * Then log in at http://localhost:3000/login with the printed credentials.
 */
import '../src/config/env.js';
import { findCustomerBySlug, findAppUserByEmail, createAppUser } from '../src/db/repo.js';
import { hashPassword } from '../src/auth/password.js';
import { closeDb } from '../src/db/kysely.js';
import { closePool } from '../src/db/pool.js';

const EMAIL = 'demo@aeo.test';
const PASSWORD = 'demo1234';
const SLUG = 'emora';

try {
  const customer = await findCustomerBySlug(SLUG);
  if (!customer) throw new Error(`customer "${SLUG}" not found — run: npm run diagnose -- --customer ${SLUG} (or loadTemplate) first`);

  const existing = await findAppUserByEmail(EMAIL);
  if (existing) {
    console.log(`app_user ${EMAIL} already exists (id=${existing.id}). No change.`);
  } else {
    const passwordHash = await hashPassword(PASSWORD);
    const u = await createAppUser({ email: EMAIL, passwordHash, customerId: customer.id, role: 'owner' });
    console.log(`Created app_user ${EMAIL} (id=${u.id}) -> customer ${SLUG} (${customer.id}), role=owner`);
  }
  console.log('\n=== DEV LOGIN ===');
  console.log('  URL:      http://localhost:3000/login');
  console.log(`  email:    ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log('  -> after login you land on /overview (dashboard for the emora customer)');
} catch (e) {
  console.error('dev-seed-web failed:', e);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => {});
  await closePool().catch(() => {});
}
