/**
 * test/auth.test.ts
 *
 * Unit tests for the engine-side auth primitives:
 *   - src/auth/password.ts (hashPassword / verifyPassword)
 *   - src/auth/session.ts  (createSessionToken / hashToken)
 *
 * No real Postgres needed — all functions are pure (no IO).
 *
 * Acceptance criteria from P5-T05:
 *   ✓ hash/verify round-trips; wrong password fails
 *   ✓ token hash is stable sha256; raw token never stored
 *   ✓ unit tests cover hash verify + token hashing
 */

import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  InvalidHashFormatError,
} from '../src/auth/password.js';
import { createSessionToken, hashToken } from '../src/auth/session.js';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// password.ts tests
// ---------------------------------------------------------------------------

describe('hashPassword / verifyPassword — round-trip', () => {
  it('verifies the correct password after hashing', async () => {
    const plain = 'correct-horse-battery-staple';
    const hash = await hashPassword(plain);
    const ok = await verifyPassword(plain, hash);
    expect(ok).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const plain = 'correct-horse-battery-staple';
    const hash = await hashPassword(plain);
    const ok = await verifyPassword('wrong-password', hash);
    expect(ok).toBe(false);
  });

  it('produces a different hash each call (unique salts)', async () => {
    const plain = 'same-password';
    const hash1 = await hashPassword(plain);
    const hash2 = await hashPassword(plain);
    expect(hash1).not.toBe(hash2);
    // Both still verify correctly
    expect(await verifyPassword(plain, hash1)).toBe(true);
    expect(await verifyPassword(plain, hash2)).toBe(true);
  });

  it('hash string starts with the scrypt prefix', async () => {
    const hash = await hashPassword('any');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('hash string encodes N, r, p, salt, and derived key as 6 $-separated parts', async () => {
    const hash = await hashPassword('any');
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    // N, r, p are numeric
    expect(Number.isFinite(parseInt(parts[1]!, 10))).toBe(true);
    expect(Number.isFinite(parseInt(parts[2]!, 10))).toBe(true);
    expect(Number.isFinite(parseInt(parts[3]!, 10))).toBe(true);
    // salt and hash are non-empty hex strings
    expect(parts[4]).toMatch(/^[0-9a-f]+$/);
    expect(parts[5]).toMatch(/^[0-9a-f]+$/);
  });

  it('verifyPassword with a corrupted hash throws InvalidHashFormatError', async () => {
    await expect(verifyPassword('any', 'not-a-valid-hash')).rejects.toThrow(
      InvalidHashFormatError,
    );
  });

  it('verifyPassword with truncated parts throws InvalidHashFormatError', async () => {
    await expect(verifyPassword('any', 'scrypt$N$r')).rejects.toThrow(
      InvalidHashFormatError,
    );
  });

  it('rejects empty password against a hash of a non-empty password', async () => {
    const hash = await hashPassword('non-empty');
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('handles unicode passwords correctly', async () => {
    const plain = '한국어_패스워드_🔑';
    const hash = await hashPassword(plain);
    expect(await verifyPassword(plain, hash)).toBe(true);
    expect(await verifyPassword('다른_패스워드', hash)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// session.ts tests
// ---------------------------------------------------------------------------

describe('createSessionToken', () => {
  it('returns an object with raw and hash fields', () => {
    const token = createSessionToken();
    expect(token).toHaveProperty('raw');
    expect(token).toHaveProperty('hash');
    expect(typeof token.raw).toBe('string');
    expect(typeof token.hash).toBe('string');
  });

  it('raw token is a non-empty base64url string (URL-safe, no padding)', () => {
    const { raw } = createSessionToken();
    // base64url charset: A-Z a-z 0-9 - _  (no + / or =)
    expect(raw).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(raw.length).toBeGreaterThan(0);
  });

  it('hash is a 64-character hex string (SHA-256)', () => {
    const { hash } = createSessionToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash is the SHA-256 digest of raw — stable and deterministic', () => {
    const { raw, hash } = createSessionToken();
    const expected = createHash('sha256').update(raw, 'utf8').digest('hex');
    expect(hash).toBe(expected);
  });

  it('different calls produce different raw tokens', () => {
    const a = createSessionToken();
    const b = createSessionToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('hashToken', () => {
  it('returns the stable SHA-256 hex of a known token', () => {
    const raw = 'test-token-value';
    const expected = createHash('sha256').update(raw, 'utf8').digest('hex');
    expect(hashToken(raw)).toBe(expected);
  });

  it('is deterministic — same input always produces same hash', () => {
    const raw = 'some-opaque-token';
    expect(hashToken(raw)).toBe(hashToken(raw));
  });

  it('produces different hashes for different tokens', () => {
    expect(hashToken('tokenA')).not.toBe(hashToken('tokenB'));
  });

  it('hash length is always 64 hex characters', () => {
    expect(hashToken('').length).toBe(64);
    expect(hashToken('x'.repeat(1000)).length).toBe(64);
  });

  it('raw token round-trips: hashToken(raw) === token.hash from createSessionToken', () => {
    const { raw, hash } = createSessionToken();
    expect(hashToken(raw)).toBe(hash);
  });
});
