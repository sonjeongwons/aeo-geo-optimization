/**
 * src/auth/password.ts
 *
 * Engine-side password hashing and verification using Node.js built-in
 * `node:crypto` scrypt KDF.  No external dependencies.
 *
 * Format: `scrypt$N$r$p$<salt_hex>$<hash_hex>`
 *   N = CPU/memory cost parameter (2^17 = 131072)
 *   r = block size (8)
 *   p = parallelisation (1)
 *   salt = 32 random bytes (hex)
 *   hash = 64-byte derived key (hex)
 *
 * Timing safety: comparison uses crypto.timingSafeEqual to prevent
 * timing-based side-channel attacks.
 *
 * Pure of Next.js; imported by the web session layer via engine.server.ts.
 */

import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/** Promise wrapper for node:crypto scrypt that preserves the options overload. */
function scrypt(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err != null) reject(err);
      else resolve(derived);
    });
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SALT_BYTES = 32;
const KEY_LEN = 64;     // 512-bit derived key
const N = 16384;        // 2^14 — memory-hard, within Node's default maxmem
const R = 8;
const P = 1;
/** maxmem = 128 * N * r * p * 2 (factor-of-2 headroom) */
const MAX_MEM = 128 * N * R * P * 2;

const PREFIX = 'scrypt';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password using scrypt.
 *
 * Returns an opaque hash string that encodes the parameters and salt so that
 * `verifyPassword` can verify it later without any additional context.
 *
 * @param plaintext - The raw password to hash (UTF-8).
 * @returns A self-describing hash string (never throws for well-formed input).
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(plaintext, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM }) as Buffer;
  return `${PREFIX}$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored hash string.
 *
 * Returns `true` if the password matches, `false` otherwise.  Uses
 * `timingSafeEqual` to prevent timing side-channels.
 *
 * Throws `InvalidHashFormatError` if the stored hash does not match the
 * expected format (defensive fail-closed: treat corrupted hashes as invalid).
 *
 * @param plaintext - The raw password to check (UTF-8).
 * @param stored    - The hash string previously returned by `hashPassword`.
 */
export async function verifyPassword(
  plaintext: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) {
    throw new InvalidHashFormatError(
      `Unexpected password hash format — expected "${PREFIX}$N$r$p$salt$hash"`,
    );
  }

  const [, nStr, rStr, pStr, saltHex, hashHex] = parts as [
    string, string, string, string, string, string,
  ];

  const saltN = parseInt(nStr, 10);
  const saltR = parseInt(rStr, 10);
  const saltP = parseInt(pStr, 10);

  if (
    !Number.isFinite(saltN) ||
    !Number.isFinite(saltR) ||
    !Number.isFinite(saltP)
  ) {
    throw new InvalidHashFormatError('Non-numeric scrypt parameters in stored hash');
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');

  const maxmem = 128 * saltN * saltR * saltP * 2;
  const derived = await scrypt(plaintext, salt, expected.length, {
    N: saltN,
    r: saltR,
    p: saltP,
    maxmem,
  }) as Buffer;

  if (derived.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class InvalidHashFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHashFormatError';
  }
}
