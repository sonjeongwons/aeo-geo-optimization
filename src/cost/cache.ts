/**
 * Request-hash dedup cache — DESIGN.md §11 cost design (CACHING section).
 *
 * PURPOSE:
 *   Cross-cycle accidental duplicate detection ONLY.
 *   Deduplicates accidental re-runs of the same (model, lang, question) within
 *   a short TTL window if the SAME run is somehow enqueued twice.
 *
 * CRITICAL INVARIANTS (DESIGN.md, §5.3, §11):
 *   1. Intra-cycle N samples NEVER collapsed.
 *      The N work-units for the same (question, model, lang) within ONE cycle
 *      share the same request_hash (sample_idx excluded from hash), but they
 *      must all produce real LLM calls.  The cache.check() function MUST
 *      return a miss for any second call within the SAME run.
 *
 *   2. Cross-cycle dedup (short TTL).
 *      If a work-unit from a PREVIOUS run has the exact same request_hash AND
 *      that result is still within TTL, we may return a cache hit to avoid
 *      an unnecessary API call (idempotency for accidental re-triggers).
 *
 *   3. Cache hit writes llm_call with usd=0, cache_hit=true (ledger concern;
 *      this module just returns the cached answer_text).
 *
 * IMPLEMENTATION:
 *   Backed by the `response_cache` PLAIN table (not a hypertable — unique index
 *   on request_hash is legal in a plain table).  The cache stores the result of
 *   cross-cycle lookups only.  Intra-cycle run isolation is enforced by the
 *   `seen` Set tracked PER CALL to check() within a run context.
 *
 * This module exports pure functions + a factory that takes a DB query function,
 * so it is testable without a real database connection.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by cache.check(). */
export type CacheCheckResult =
  | { hit: true; answerText: string; createdAt: Date }
  | { hit: false };

/**
 * DB query interface — injected by the caller (repo.ts in production).
 * Keeps this module independent of pg/Kysely.
 */
export interface CacheQueryFns {
  /**
   * Look up a cached response by request_hash.
   * Returns null when not found or TTL expired (caller should filter by age).
   *
   * @param requestHash   The hash to look up.
   * @param runStartedAt  When provided, only rows created BEFORE this timestamp
   *                      are eligible.  Used on the async pg-boss path to ensure
   *                      intra-cycle siblings (created after run.started_at) never
   *                      collapse N samples via the cross-cycle cache.
   */
  findByHash: (
    requestHash: string,
    runStartedAt?: Date
  ) => Promise<{ answerText: string; createdAt: Date } | null>;

  /**
   * Store a new response in the cache.
   * ON CONFLICT (request_hash) DO NOTHING — idempotent.
   */
  upsert: (requestHash: string, answerText: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Cache TTL
// ---------------------------------------------------------------------------

/**
 * Cross-cycle cache TTL in milliseconds.
 * 24 hours — short enough to avoid serving stale data across weekly cycles,
 * long enough to dedup accidental same-day re-triggers.
 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 h

// ---------------------------------------------------------------------------
// ResponseCache
// ---------------------------------------------------------------------------

/**
 * Cache instance returned by `createResponseCache()`.
 *
 * The `usedHashes` set tracks request_hashes already served AS CACHE HITS
 * within this session.  This is what prevents intra-cycle sample collapse:
 *
 *   - work-unit 0 for (q1, m1, lang1): cache miss → real call
 *   - work-unit 1 for (q1, m1, lang1): cache miss → real call
 *   - (same request_hash, but `usedHashes` not relevant for INTRA-cycle)
 *
 * Actually, intra-cycle isolation is stricter: we track PER-RUN which hashes
 * have already been SERVED from the DB cache within this run.  If the DB cache
 * has a row for this hash (cross-cycle), we return it once; but subsequent
 * same-run requests with the same hash are forced to real calls because the
 * N samples must be independent.
 *
 * This is enforced by the `seenInRun` set below.
 */
export interface ResponseCache {
  /**
   * Check if a response is cached for this request_hash.
   *
   * INTRA-CYCLE INVARIANT: if `runId` matches a previously-checked hash in
   * this run, always returns a miss (N samples must be distinct).
   *
   * @param requestHash   The hash computed by plan.ts (excludes sample_idx).
   * @param runId         The current run ID — used to enforce intra-cycle isolation.
   * @param runStartedAt  When provided, cross-cycle DB hits are only returned
   *                      for cache rows created BEFORE this timestamp.  Prevents
   *                      the async per-job path from serving intra-cycle siblings
   *                      that stored their entry after the run began.
   */
  check(requestHash: string, runId: string, runStartedAt?: Date): Promise<CacheCheckResult>;

  /**
   * Store a new answer in the cross-cycle cache.
   * Should be called after a successful real LLM call.
   *
   * @param requestHash  The request hash.
   * @param answerText   The answer to cache.
   */
  store(requestHash: string, answerText: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// createResponseCache — factory
// ---------------------------------------------------------------------------

/**
 * Create a ResponseCache instance backed by the injected DB query functions.
 *
 * The `seenInRun` map tracks per-run which request_hashes have been CHECKED
 * within the current run.  ANY check of a hash within a run marks it as seen;
 * ALL subsequent checks for the SAME hash in the SAME run are forced to real
 * calls (no cache hit).  This ensures ALL N intra-cycle samples are real calls.
 *
 * This factory is called ONCE per run (or per worker process), and the
 * returned instance is passed through the pipeline.
 */
export function createResponseCache(db: CacheQueryFns): ResponseCache {
  // Map from runId → Set of request_hashes already encountered in this run.
  // ANY encounter (hit or miss) prevents cache collapsing of intra-cycle N samples.
  const seenInRun = new Map<string, Set<string>>();

  return {
    async check(requestHash, runId, runStartedAt?: Date): Promise<CacheCheckResult> {
      // Ensure per-run set exists.
      if (!seenInRun.has(runId)) {
        seenInRun.set(runId, new Set());
      }
      const runSeen = seenInRun.get(runId)!;

      // INTRA-CYCLE INVARIANT: once a hash has been encountered within this run,
      // ALL subsequent checks return a miss — N samples NEVER collapse.
      if (runSeen.has(requestHash)) {
        return { hit: false };
      }

      // Mark encountered regardless of DB result — next sample for this
      // (question, model, lang) within the same run will be a real call.
      runSeen.add(requestHash);

      // Cross-cycle DB lookup.  Pass runStartedAt so the query can exclude
      // entries written during the current run (intra-cycle isolation on async path).
      const row = await db.findByHash(requestHash, runStartedAt);
      if (!row) return { hit: false };

      // TTL check.
      const age = Date.now() - row.createdAt.getTime();
      if (age > CACHE_TTL_MS) return { hit: false };

      return { hit: true, answerText: row.answerText, createdAt: row.createdAt };
    },

    async store(requestHash, answerText): Promise<void> {
      await db.upsert(requestHash, answerText);
    },
  };
}

// ---------------------------------------------------------------------------
// Standalone hash check (for tests without DB)
// ---------------------------------------------------------------------------

/**
 * Create an in-memory only ResponseCache for testing.
 * Intra-cycle isolation is still enforced; cross-cycle lookup uses in-memory map.
 */
export function createInMemoryResponseCache(): ResponseCache & {
  /** Inject a cross-cycle hit for testing. */
  seed: (requestHash: string, answerText: string, createdAt?: Date) => void;
} {
  const store = new Map<string, { answerText: string; createdAt: Date }>();
  const seenInRun = new Map<string, Set<string>>();

  return {
    async check(requestHash, runId, runStartedAt?: Date): Promise<CacheCheckResult> {
      if (!seenInRun.has(runId)) {
        seenInRun.set(runId, new Set());
      }
      const runSeen = seenInRun.get(runId)!;

      // Intra-cycle: already encountered this hash in this run → miss.
      if (runSeen.has(requestHash)) {
        return { hit: false };
      }

      // Mark encountered before DB check — next sample in this run is a real call.
      runSeen.add(requestHash);

      const row = store.get(requestHash);
      if (!row) return { hit: false };

      // Intra-cycle isolation on async path: skip entries created during this run.
      if (runStartedAt && row.createdAt >= runStartedAt) return { hit: false };

      // TTL check.
      const age = Date.now() - row.createdAt.getTime();
      if (age > CACHE_TTL_MS) return { hit: false };

      return { hit: true, answerText: row.answerText, createdAt: row.createdAt };
    },

    async store(requestHash, answerText): Promise<void> {
      store.set(requestHash, { answerText, createdAt: new Date() });
    },

    seed(requestHash, answerText, createdAt = new Date()): void {
      store.set(requestHash, { answerText, createdAt });
    },
  };
}
