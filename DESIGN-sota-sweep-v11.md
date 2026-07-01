# SOTA Sweep v11 — self-audit over cost-controlled grounding (subsample policy + cache + exclusion)

Source: dynamic workflow `aeo-geo-sota-sweep-v11` (**10 agents**). 3 lenses (cost-correctness / integration / exclusion-honesty) over the grounding cost-control shipped this turn: `groundingPolicy.ts` (subsample), the `runResponse` wiring, and the search-engine self-reference earned-source exclusion.

**6 raw → 5 deduped → 3 CONFIRMED bugs** — two P1 CACHE×GROUNDING interactions I did not consider, one P2 env-validation gap. The subsample math + the exclusion honesty came back clean.

---

## BUG FIXES (self-audit found + critic-verified; ✅ ALL 3 APPLIED + regression-tested)

Regression lock: extended `test/groundingPolicy.test.ts` (Z2 strict-parse); Z3/Z4 are runResponse behavior covered by the full suite (grounded default-off → existing cache tests unaffected).

| Bug | Sev | What was wrong | Fix |
|-----|-----|----------------|-----|
| **Z3** | **P1** | `computeRequestHash` omits the `grounded` flag, but `grounded` VARIES by sampleIdx under a subsample. So a prompt's N samples are a grounded/ungrounded MIX sharing ONE cache slot → cross-cycle a grounded work-unit could be served a prior UNGROUNDED cached answer (or vice versa), corrupting the grounded subsample. | **Grounded units are excluded from the cross-cycle cache** (decided before the cache check): a grounded unit never reads/writes `response_cache` and always makes a fresh real call. No shared slot → no collision. |
| **Z4** | **P1** | `response_cache` stores only `(requestHash, answerText)` — no `provider_meta`. So every cross-cycle cache HIT returns `provider_meta=null` → `aggregate.ts` skips traceless rows → the earned-source corpus silently depended on cache warmth (even under `GEMINI_GROUNDING=on`, a warm cache yielded a different corpus). | Same exclusion (a grounded response is never cached), so a grounded response always carries its fresh grounding trace into `response_raw.provider_meta`. Solves Z3 + Z4 with one change. |
| **Z2** | P2 | `GEMINI_GROUNDING_SAMPLE_PCT` (the cost dial) bypassed the env schema and was read with raw `Number()` — `Number('1e2')===100` grounds EVERYTHING, `Number('0x10')===16`; a misspelled var silently grounds nothing. Clamped in effect but unvalidated/unobservable. | `groundingPolicy` now STRICT-parses `/^\d{1,3}$/` (rejects exponent/hex/decimal → off, never a surprise 100%). Added `GEMINI_GROUNDING_SAMPLE_PCT` to `envSchema` (regex + ≤100) so a bad value fails fast at startup. |

---

## The subsample knob (shipped this turn, the reason v11 ran)
`GEMINI_GROUNDING_SAMPLE_PCT=N` grounds a deterministic ~N% of work-units (stable FNV-1a hash of `${questionId}:${language}:${sampleIdx}`, keyed WITHOUT modelId so every engine grounds the SAME subset). Simulated on the emora plan (36 q × 5 samples = 180 units): PCT 3→4, 5→10, 10→17, 25→62, 100→180 grounded — linear + deterministic, so the un-ledgered Search-tool cost is now BOUNDED (the full 6192-unit plan no longer grounds wholesale). `GEMINI_GROUNDING=on` remains the "ground everything" validation override.

## Lesson (8th sweep)
The two P1s were an INTERACTION bug — the new grounded flag was correct in isolation, but it collided with a pre-existing subsystem (the cross-cycle cache) that keys on a hash which predates grounding and stores a lossy projection (answerText only). Lesson: a new per-work-unit dimension (grounded) must be reconciled with EVERY identity/dedup/cache key it now varies against — the cache was invisible from the grounding code's vantage. The clean resolution wasn't to thread `grounded` through the hash + cache schema (a migration), but to recognize that a grounded response is a fresh MEASUREMENT that shouldn't be cached at all.
