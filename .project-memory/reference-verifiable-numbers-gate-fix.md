---
name: reference-verifiable-numbers-gate-fix
description: "The 2026-09-06 fix to verifiableNumbersGate — why cheap gates were structurally blind to verified facts, and how it was fixed without weakening §7"
metadata: 
  node_type: memory
  type: reference
  originSessionId: b289ea83-61ef-4d5d-9831-12cbbdc22c47
  modified: 2026-09-07T16:50:15.561Z
---

Found while investigating why unsanpartners/sharejoa had almost no §7-passed content
despite having verified owner-attested facts covering the exact numbers/terms in the
generated text. Root cause, in `src/content/gates/verifiableNumbers.ts`:

`verifiableNumbersGate` is gate #2 in the non-short-circuit content fold
(`contentGate.ts`'s `runContentGates`), running BEFORE `claimVerificationGate` (gate
#6, the only PAID gate — it calls `claimExtract` via Gemini to populate
`asset.claims`). `contentGate.ts`'s own "COST SHORT-CIRCUIT" comment explains the
paid gate is skipped once any cheap gate already returned 'block'. So
`verifiableNumbersGate`'s "is this superlative/number covered by a claim?" checks —
which only looked at `asset.claims` — were checking an array that is ALWAYS EMPTY at
that point (`assembleContentSet.ts` sets `claims: []` at asset creation). A number or
superlative that WAS already verified in the customer's `claim_source` table got
permanently blocked with zero chance for the real verifier to ever run. This affected
EVERY customer with numeric/superlative content, not just one — it just showed up as
"프리미엄 blocked" for sharejoa and "24 blocked" for unsanpartners.

**Fix (commit `29b618f`):** `ContentGateContext` already carries the full
`claimSources: ClaimSourceRow[]` for the customer (populated from the DB at
generation time — see `assembleContentSet.ts` line ~664 — no LLM call needed). Added
two `$0` deterministic checks that consult it directly:
- `isNumericCoveredBySource(hitText, claimSources)` — parses the bare token's numeric
  value and matches it against any `claim_kind==='numeric'` + `verified_by!==null`
  claim_source row's `numeric_value`. Value-only match, no unit/context — deliberately
  simple, since `claimVerificationGate` remains the precise backstop for anything this
  misses.
- `isSuperlativeCoveredBySource(term, claimSources)` — substring match against
  verified `claim_text`, mirroring the existing per-asset-claims check.

**Why this is safe** (important if extending this further): it can only make the
cheap gate MORE PERMISSIVE — a false "covered" here still has to survive
`claimVerificationGate`, which is unaffected and remains authoritative. It does not
weaken §7 enforcement; it just stops prematurely discarding content the paid gate
would have accepted anyway. Confirmed empirically: the SAME run that started passing
"28"/"5%" for unsanpartners also correctly kept blocking LLM-fabricated numbers like
"150%"/"66%" that have no matching claim_source.

**Companion fix (commit `d1c59de`):** "프리미엄" was in `config/content-terms/ko.json`'s
superlative avoid-list (added for SMIM, genuine self-praise there), but for sharejoa
(a YouTube Premium reseller) it's an unavoidable third-party product name. Extended
the existing `isCjkSuperlativeException` pattern (already used for 최대한/최대<N>) to
also check the text immediately preceding a hit: "프리미엄" preceded by "유튜브" or
"뮤직" is exempt; any other (self-referential) use still blocks.

**Companion data-entry lesson:** always double-check that a fact containing ANY bare
number is tagged `kind:"numeric"` with `value`/`unit` set when authoring a
`*-facts.json` file — `kind:"capability"` facts with a number in the text get NO
benefit from either the numeric coverage check above or `claimVerify.ts`'s LLM-based
binding, since neither has a `numeric_value` to match against. Caught this
retroactively for unsanpartners (24시간, 3개 센터) and sharejoa (1개월, 4K, 3단계) —
see [[project-unsanpartners-onboarding]] and [[project-sharejoa-onboarding]].
`ingest-facts.mts` dedupes by exact `claim_text`, so fixing the JSON file alone does
NOT fix already-ingested rows — the DB rows need a direct UPDATE too.

**Verified impact same day:** unsanpartners hub 2→4 live pages, emora hub 22→24,
gate reports showing `blocked` counts dropping sharply in favor of `needs_human`/
`passed`. 2473 tests pass (7 new, in `test/verifiableNumbers.test.ts`) + tsc clean.

**2026-09-07 follow-on — signed-vs-unsigned source preference (commit `1cfef92`):**
a SIXTH, related bug found the next day. `genContent.ts`'s `seedClaimSourcesFromBrief`
auto-creates UNSIGNED claim_source rows from `brief.productAttributes` on every run,
duplicating facts already properly signed via `*-facts.json`. `findMatchingSource`
(claimVerify.ts) had no preference between signed/unsigned candidates, so a claim
could bind to the unsigned duplicate ("not yet signed off") even when a signed
equivalent existed. Fixed: search signed sources first, fall back to unsigned only
if nothing signed matches. This helps, but does NOT fully resolve sharejoa's
0-passed-pages — see [[project-sharejoa-onboarding]]'s 2026-09-07 entry: the deeper
issue is that ATOMIC signed facts (one number each) don't unit-match a generated
CLAIM that mentions multiple numbers in one sentence, while the untyped (numeric_
value=null) unsigned duplicate slips past the unit-compatibility filter and matches
on plain text instead. That's an open-ended claim-matching precision problem, not a
quick fix — logged as a known limitation, not chased further this session.
