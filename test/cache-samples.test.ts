/**
 * test/cache-samples.test.ts
 *
 * Vitest suite for src/cost/cache.ts:
 *   - One cycle yields N distinct physical calls per (q, model, lang):
 *     intra-cycle samples with the same request_hash must ALL be cache misses.
 *   - Cross-cycle dedup: second run CAN get a cache hit for the FIRST sample.
 *   - TTL expiry causes a miss even if the hash is in the store.
 *   - The test FAILS if the cache collapses intra-cycle samples (i.e. returns
 *     a hit on the 2nd or later sample within the same run for the same hash).
 *
 * Uses createInMemoryResponseCache() — the test-friendly factory from cache.ts.
 */

import { describe, it, expect } from "vitest";
import {
  createInMemoryResponseCache,
  createResponseCache,
  CACHE_TTL_MS,
} from "../src/cost/cache.js";
import type { CacheQueryFns } from "../src/cost/cache.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN_A = "run-aaaaaaaa-0000-0000-0000-000000000001";
const RUN_B = "run-bbbbbbbb-0000-0000-0000-000000000002";

// A single (question, model, lang) produces ONE request_hash (sample_idx excluded).
const HASH_Q1_M1_L1 = "sha256hash_q1_m1_l1";
const HASH_Q1_M1_L2 = "sha256hash_q1_m1_l2";
const HASH_Q2_M1_L1 = "sha256hash_q2_m1_l1";

// ---------------------------------------------------------------------------
// Core invariant: intra-cycle N samples NEVER collapsed
// ---------------------------------------------------------------------------

describe("cache — intra-cycle samples are never collapsed (physical calls required)", () => {
  it("N=3 samples for same (q,model,lang) in same run → 3 cache misses", async () => {
    const cache = createInMemoryResponseCache();

    // Simulate: no cross-cycle seed — purely checking intra-cycle behavior.
    const results = await Promise.all([
      cache.check(HASH_Q1_M1_L1, RUN_A),  // sample_idx=0
      cache.check(HASH_Q1_M1_L1, RUN_A),  // sample_idx=1 (same hash, same run)
      cache.check(HASH_Q1_M1_L1, RUN_A),  // sample_idx=2 (same hash, same run)
    ]);

    // All three must be misses — intra-cycle samples NEVER collapse.
    for (const result of results) {
      expect(result.hit).toBe(false);
    }
  });

  it("N=5 samples (core tier) — all misses within same run", async () => {
    const cache = createInMemoryResponseCache();
    const N = 5;

    const checks = await Promise.all(
      Array.from({ length: N }, () => cache.check(HASH_Q1_M1_L1, RUN_A))
    );

    // All 5 must be misses
    const hitCount = checks.filter((r) => r.hit).length;
    expect(hitCount).toBe(0);
  });

  it("sequential checks within same run all return miss", async () => {
    const cache = createInMemoryResponseCache();
    const misses: boolean[] = [];

    for (let i = 0; i < 5; i++) {
      const result = await cache.check(HASH_Q1_M1_L1, RUN_A);
      misses.push(!result.hit);
    }

    // Verify every check returned a miss
    expect(misses.every((m) => m)).toBe(true);
  });

  it("FAILS if cache collapses: 2nd sample hit is a bug", async () => {
    // This test documents what SHOULD NOT happen.
    // We verify the cache correctly prevents this scenario.
    const cache = createInMemoryResponseCache();

    // Seed a cross-cycle value (simulating a previous run's result).
    cache.seed(HASH_Q1_M1_L1, "cached answer from previous run");

    // First sample in NEW run — may hit the cross-cycle cache (1 hit is OK).
    const first = await cache.check(HASH_Q1_M1_L1, RUN_A);
    // Second sample in SAME run — MUST be a miss regardless of cross-cycle cache.
    const second = await cache.check(HASH_Q1_M1_L1, RUN_A);
    const third = await cache.check(HASH_Q1_M1_L1, RUN_A);

    // The 2nd and 3rd samples MUST be misses (intra-cycle invariant).
    expect(second.hit).toBe(false);
    expect(third.hit).toBe(false);

    // The first sample CAN be a hit (cross-cycle dedup is allowed for 1 sample).
    // Document current behavior: first check CAN hit the cross-cycle cache.
    // This test intentionally verifies only that 2nd+ are misses.
    void first; // result doesn't affect the invariant we're testing
  });

  it("different hashes in same run can each get one cross-cycle hit", async () => {
    const cache = createInMemoryResponseCache();

    // Seed two different hashes from a previous run.
    cache.seed(HASH_Q1_M1_L1, "answer for q1");
    cache.seed(HASH_Q1_M1_L2, "answer for q2");

    // Each hash's FIRST check in this run can be a cross-cycle hit.
    const r1 = await cache.check(HASH_Q1_M1_L1, RUN_A);
    const r2 = await cache.check(HASH_Q1_M1_L2, RUN_A);

    // Second checks must be misses.
    const r1b = await cache.check(HASH_Q1_M1_L1, RUN_A);
    const r2b = await cache.check(HASH_Q1_M1_L2, RUN_A);

    expect(r1b.hit).toBe(false);
    expect(r2b.hit).toBe(false);

    // The first checks could be hits (cross-cycle).
    if (r1.hit) expect(r1.answerText).toBe("answer for q1");
    if (r2.hit) expect(r2.answerText).toBe("answer for q2");
  });
});

// ---------------------------------------------------------------------------
// Cross-cycle dedup (short TTL)
// ---------------------------------------------------------------------------

describe("cache — cross-cycle dedup with TTL", () => {
  it("fresh cross-cycle entry is a hit for first sample in new run", async () => {
    const cache = createInMemoryResponseCache();

    // Seed fresh value (just now = within TTL).
    cache.seed(HASH_Q1_M1_L1, "cross-cycle answer", new Date());

    const result = await cache.check(HASH_Q1_M1_L1, RUN_A);
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.answerText).toBe("cross-cycle answer");
    }
  });

  it("expired cross-cycle entry returns miss", async () => {
    const cache = createInMemoryResponseCache();

    // Seed value that's older than the TTL.
    const expiredDate = new Date(Date.now() - CACHE_TTL_MS - 1000);
    cache.seed(HASH_Q1_M1_L1, "old answer", expiredDate);

    const result = await cache.check(HASH_Q1_M1_L1, RUN_A);
    expect(result.hit).toBe(false);
  });

  it("same hash in different runs: each run's FIRST sample can be a hit", async () => {
    const cache = createInMemoryResponseCache();
    cache.seed(HASH_Q1_M1_L1, "cross-cycle result");

    // Run A first check → hit
    const runA_first = await cache.check(HASH_Q1_M1_L1, RUN_A);
    // Run A second check → miss (intra-cycle)
    const runA_second = await cache.check(HASH_Q1_M1_L1, RUN_A);

    // Run B first check → also a hit (different run context)
    const runB_first = await cache.check(HASH_Q1_M1_L1, RUN_B);

    expect(runA_second.hit).toBe(false);
    // Run A and B first checks should both see the cross-cycle hit (different seenInRun sets)
    if (runA_first.hit) expect(runA_first.answerText).toBe("cross-cycle result");
    if (runB_first.hit) expect(runB_first.answerText).toBe("cross-cycle result");
  });
});

// ---------------------------------------------------------------------------
// store() and check() integration
// ---------------------------------------------------------------------------

describe("cache.store() + check()", () => {
  it("store then check in NEW run returns a hit", async () => {
    const cache = createInMemoryResponseCache();

    // Store a value (simulating completed work from a previous run).
    await cache.store(HASH_Q2_M1_L1, "stored answer text");

    // New run — first check should be a cross-cycle hit.
    const result = await cache.check(HASH_Q2_M1_L1, RUN_B);
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.answerText).toBe("stored answer text");
    }
  });

  it("store then check in SAME run returns miss after first encounter", async () => {
    const cache = createInMemoryResponseCache();
    await cache.store(HASH_Q1_M1_L1, "answer");

    // First check in run A → cross-cycle hit.
    await cache.check(HASH_Q1_M1_L1, RUN_A);
    // Second check in same run → miss (intra-cycle invariant).
    const second = await cache.check(HASH_Q1_M1_L1, RUN_A);
    expect(second.hit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createResponseCache with injected CacheQueryFns (production seam)
// ---------------------------------------------------------------------------

describe("createResponseCache — injected DB seam", () => {
  function makeDbFns(
    stored: Map<string, { answerText: string; createdAt: Date }>
  ): CacheQueryFns {
    return {
      findByHash: async (hash) => stored.get(hash) ?? null,
      upsert: async (hash, text) => {
        stored.set(hash, { answerText: text, createdAt: new Date() });
      },
    };
  }

  it("returns miss when DB has no entry", async () => {
    const db = makeDbFns(new Map());
    const cache = createResponseCache(db);

    const result = await cache.check(HASH_Q1_M1_L1, RUN_A);
    expect(result.hit).toBe(false);
  });

  it("returns hit for cross-cycle entry in DB", async () => {
    const stored = new Map([
      [HASH_Q1_M1_L1, { answerText: "db cached answer", createdAt: new Date() }],
    ]);
    const db = makeDbFns(stored);
    const cache = createResponseCache(db);

    const result = await cache.check(HASH_Q1_M1_L1, RUN_A);
    expect(result.hit).toBe(true);
    if (result.hit) expect(result.answerText).toBe("db cached answer");
  });

  it("intra-cycle invariant holds with DB-backed cache: N=3 all miss after first", async () => {
    // Even if DB has a row, the 2nd and 3rd sample within same run must be misses.
    const stored = new Map([
      [HASH_Q1_M1_L1, { answerText: "db answer", createdAt: new Date() }],
    ]);
    const db = makeDbFns(stored);
    const cache = createResponseCache(db);

    const first = await cache.check(HASH_Q1_M1_L1, RUN_A);
    const second = await cache.check(HASH_Q1_M1_L1, RUN_A);
    const third = await cache.check(HASH_Q1_M1_L1, RUN_A);

    // First may hit (cross-cycle); second and third MUST miss (intra-cycle invariant).
    void first;
    expect(second.hit).toBe(false);
    expect(third.hit).toBe(false);
  });
});
