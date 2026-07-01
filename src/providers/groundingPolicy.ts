/**
 * src/providers/groundingPolicy.ts — cost-controlled grounding SUBSAMPLE policy.
 *
 * Grounding (the Gemini Google-Search tool) is billed PER grounded call and that
 * cost is NOT governed by the token weekly_usd_cap (§11 budget ledgers tokens,
 * not the Search tool). Grounding the whole plan is therefore uncapped spend
 * (a live emora baseline is ~6192 work-units). This policy grounds only a
 * DETERMINISTIC SUBSAMPLE of work-units so the earned-source corpus fills with
 * real data at a predictable, controlled cost.
 *
 * Config (read from the environment, mirroring how the Gemini adapter reads
 * GEMINI_GROUNDING):
 *   - GEMINI_GROUNDING="on"          → ground EVERYTHING (validation/override; expensive).
 *   - GEMINI_GROUNDING_SAMPLE_PCT=N  → ground ~N% of work-units (N in 1..100),
 *                                      chosen deterministically by a stable hash of
 *                                      the work-unit key so the SAME prompts ground
 *                                      across models (apples-to-apples cross-engine)
 *                                      and re-runs are reproducible.
 *   - neither set                    → ground nothing (default; ungrounded measurement).
 *
 * The decision is STATELESS (a pure hash), so it is safe under parallel execution
 * — no shared counter, no race. PURE (except reading process.env by default).
 */

/** FNV-1a → a stable value in [0,1) for a string key. Deterministic, no deps. */
export function stableHash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keep in uint32).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h / 4294967296; // [0,1)
}

export interface GroundingEnv {
  GEMINI_GROUNDING?: string | undefined;
  GEMINI_GROUNDING_SAMPLE_PCT?: string | undefined;
}

/**
 * Decide whether a single work-unit should be grounded.
 *
 * @param key  a stable per-work-unit key (e.g. `${questionId}:${language}:${sampleIdx}`);
 *             deliberately EXCLUDES modelId so every engine grounds the same subset.
 * @param env  environment source (defaults to process.env).
 */
export function shouldGround(
  key: string,
  env: GroundingEnv = process.env as GroundingEnv,
): boolean {
  if ((env.GEMINI_GROUNDING ?? "").toLowerCase() === "on") return true; // ground everything
  const raw = (env.GEMINI_GROUNDING_SAMPLE_PCT ?? "").trim();
  // STRICT plain-integer parse (v11 Z2): reject exponent/hex/decimal forms so
  // "1e2"/"0x10"/"50.5" don't silently coerce to a surprising percentage that
  // could ground far MORE than intended (uncapped Search billing). Only "0".."100".
  if (!/^\d{1,3}$/.test(raw)) return false;
  const pct = Number(raw);
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  return stableHash01(key) < pct / 100;
}
