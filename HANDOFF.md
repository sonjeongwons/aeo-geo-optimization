# HANDOFF — current state (read this first when resuming on any PC)

_Update this file at the end of every session, then commit + push. See CLAUDE.md for the sync protocol._

**Last updated:** 2026-09-07 (session 4, truly final round). Latest commit:
`1cfef92` (signed-source-preference fix) + this handoff commit.

## ✅ SESSION 4 (truly final) — 6th sharejoa fix, then hit the real open-ended limit

After the daily quota reset, re-verified sharejoa and found a 6th real bug:
`genContent.ts`'s `seedClaimSourcesFromBrief` auto-creates UNSIGNED claim_source
duplicates from `brief.productAttributes` on every run, alongside the properly
SIGNED facts from `*-facts.json`. `findMatchingSource` had no signed-vs-unsigned
preference, so claims sometimes bound to the unsigned duplicate ("not yet signed
off") instead of an available signed equivalent. Fixed (commit `1cfef92`): search
signed sources first, fall back to unsigned only if nothing signed matches. 2478
tests pass (2 new) + tsc clean.

**This helped, but sharejoa still hasn't passed a page.** The deeper reason,
confirmed via live gate_report inspection: signed facts are precise ATOMIC
single-number rows (9900원, 14900원, 34%, 60000원, each separate), but Gemini's
generated prose often mentions multiple numbers in one sentence/claim. The
unit-compatibility precondition in `findMatchingSourceAmong` correctly filters out
every atomic signed source for a multi-number claim (none matches on canonical
unit alone), while the untyped (numeric_value=null) unsigned duplicate slips past
that filter and matches on plain text overlap instead.

**Decision: stop chasing this tonight.** This is no longer a discrete bug — it's
the long-standing, open-ended claim-matching precision/recall limitation already
documented in `reference-korean-claim-binding.md` months ago (smim's own yield was
always "~1-2/set, steady weekly accumulation, not bulk"). Six real,
independently-verified fixes shipped this session total (numeral binding, 유튜브
프리미엄 exception, prompt BLUF, comparison-table filler cap, extraction-model
quota split, signed-source preference) — each measurably reduced hard blocks and
shifted failures toward more nuanced needs_human reasons. What's left (e.g.
splitting extracted claims per-number, or restructuring the unit-compatibility
gate for multi-number sentences) is a genuine NLP-matching quality project, not a
quick fix.

### ON REOPEN
- Do NOT re-chase any of the six fixed classes for sharejoa — all closed,
  individually verified live.
- Expect sharejoa's pass rate to accumulate gradually over multiple weekly cycles
  (like smim's history), not resolve in one sitting.
- If someone wants to meaningfully move this forward later, the real next lever is
  the claim-extraction/matching precision problem above — a bigger, more
  open-ended piece of work than anything fixed today. See
  [[reference-verifiable-numbers-gate-fix]] / `project-sharejoa-onboarding.md` for
  full detail.

## ✅ SESSION 4 (final round) — content-quality prompt fixes + the real quota ceiling discovered

Continued chasing sharejoa's 0-passed-pages after the numeral/프리미엄 gate fixes.
Found and fixed two MORE real bugs, then hit the actual hard resource ceiling:

1. **Prompt template gap (generic, not sharejoa-specific), commit `7cde765`:**
   `selfContainednessGate` requires `definition_sentence`/`case_study` leads to name
   the brand — but `buildContentPromptForFormat`'s `FORMAT_INSTRUCTIONS` only had
   that rule for `answer_block`. Added it to the other two. This affects every
   customer generating those formats, just fully exposed for sharejoa since it had
   nothing else passing to offset it.
2. **keywordStuffingGate, commit `7cde765`:** sharejoa's 15 seedCompetitors + zero
   ingested comparative facts meant the "no facts" comparison-table prompt branch
   forced literal "정보 없음" for every competitor cell — enough repetition to trip
   the gate's CJK-bigram density check (>=8 occurrences/>=5%). unsanpartners hits the
   same branch but only has 3 competitors (under threshold); emora avoids it via real
   ingested facts. Capped placeholder rows to 3 + told the model to omit competitors
   it can't say anything about. **Verified live: both gates stopped firing entirely
   for sharejoa's very next batch.**
3. **The actual remaining blocker — Google free-tier quota is 20 requests/DAY PER
   MODEL PER PROJECT, commit `4809c3f`.** After 1-2, sharejoa still failed ~100% at
   `claimVerificationGate` ("Extraction failed... fail closed"). Assumed transient
   rate-limiting — wrong. Local repro surfaced the real 429:
   `quotaId=GenerateRequestsPerDayPerProjectPerModel-FreeTier, quotaValue=20,
   model=gemini-2.5-flash`. `claimExtract.ts` shared `gemini-2.5-flash` with content
   generation, so a day of generation testing (4 customers) silently zeroed out
   extraction's bucket too. Fixed: extraction now uses `gemini-flash-lite-latest` (a
   separate daily bucket). **By the time this landed, BOTH rotation keys'
   `gemini-2.5-flash` daily quota was ALSO exhausted from the day's own testing** — a
   final verification dispatch produced 0 generation attempts, which is the expected
   consequence of the same 20/day ceiling, not a new bug.

**All four sharejoa blocker classes (numeral binding, 유튜브 프리미엄 exception,
BLUF/keyword-stuffing prompt fixes, extraction-model quota split) are now fixed and
individually verified live.** Nothing more to chase in code — sharejoa's first
passed page is blocked purely on today's exhausted daily quota resetting. 2476 tests
pass throughout, tsc clean at every step.

**Big-picture lesson for future sessions:** 20/day/model/project is a genuinely tiny
budget. A single day of manual `gh workflow run` dispatches with high `attempts` can
(and did) exhaust it across every model in use, for both rotation keys. Before
concluding "still broken" after a fix, check whether it's just the day's quota gone
(check `gemini-2.5-flash`, `gemini-flash-lite-latest`, AND `gemini-2.5-pro`
separately) rather than re-diagnosing from scratch. See
[[reference-prompt-quality-fixes]] / `reference-prompt-quality-fixes.md` in
`.project-memory/` for full detail.

### ON REOPEN
- Once the daily quota resets, dispatch `gh workflow run publish.yml -f
  customer=sharejoa` — this SHOULD produce sharejoa's first live page now.
- If the owner sends corrected Gemini keys (the other 6 pasted values were not valid
  `AIzaSy...` keys), each additional distinct-project key adds a full extra 20/day
  to EVERY model's ceiling (generation, extraction, judge, escalation) — this is now
  the clearest lever for real throughput, more so than raising ATTEMPTS/TOTAL.

## ✅ SESSION 4 (cont. once more) — repo made PUBLIC (billing), Hangul-multiplier numeral fix, sharejoa's remaining gap identified

**GitHub Actions billing block, resolved by making the repo public.** A `gh workflow
run` dispatch failed INSTANTLY (~4s, before any step) with "recent account payments
have failed or your spending limit needs to be increased." Root cause: this repo was
PRIVATE, so a day of long manual dispatches (`attempts=5` × 3 customers, 1-3h each)
almost certainly exhausted the account's free Actions-minutes allowance. Couldn't get
exact usage via `gh api` (needs a `user` OAuth scope requiring interactive browser
consent). Gave the owner options; **owner chose to make the repo public** (public repos
get unlimited free Actions minutes). Before flipping visibility, scanned the FULL git
history + tree for leaked secrets (Gemini/GitHub token patterns, embedded DB passwords)
— found none (`.env` was never committed, matches the encrypted-env-sync design).
Repo is now public; confirmed a dispatch right after started running normally.

**Fixed the remaining Korean numeral gap: digit + Hangul multiplier (6만원, 7천만원).**
`scanBodyForNumerics`'s CJK_NUMERAL_REGEX matches CJK ideographs (一二三...万億), NOT
Hangul syllables (만/억/천/백 written in 한글) — so "6만원" was only ever detected as
bare "6", which could never match a claim_source's numeric_value=60000. Fixed in
`isNumericCoveredBySource` (verifiableNumbers.ts): peeks at the text immediately after
a digit hit for a Hangul multiplier suffix (만/억/천/백, plus compounds 천만/백만,
longest-first) and multiplies before comparing. This is the exact gap documented in
`reference-korean-claim-binding.md` ("7천만 partial detection") — now closed, and it
helps every Korean-pricing customer, not just sharejoa. Also added a missing
"14,900원" (list price) fact for sharejoa — only the discounted 9,900원 had been
recorded. 2476 tests pass (3 new) + tsc clean.

**sharejoa's numeric/premium gate-blocking is now FULLY resolved** (re-verified live:
only ONE `verifiableNumbersGate` block remained, "최대" — a genuine unbounded
superlative with no source, correctly blocked). Still 0 passed pages, but for a
DIFFERENT reason now: **LLM generation-quality issues**, not gate bugs —
`keywordStuffingGate` (한 단어가 24~33% 반복되는 부자연스러운 텍스트, e.g. "정보"/"없음"),
`selfContainednessGate` (lead doesn't name the brand), `claimVerificationGate`
extraction failures → needs_human. This is prompt/generation-quality tuning for the
`subscription-sharing` industry brief — a different, larger scope of work than
today's gate-correctness fixes. Don't re-chase the numeric/premium gate class here;
it's closed.

### ON REOPEN
- Confirm the repo is still public and Actions runs are not billing-blocked.
- sharejoa: if still 0 passed pages after several more weekly cycles, the next lever
  is generation prompt quality (why Gemini produces keyword-stuffed text / weak leads
  for this specific brief), not the gates.
- Everything else from earlier in session 4 (Neon migration, unsanpartners/emora live,
  smim dormant, Gemini multi-key rotation) is steady-state — see the sections below.

## ✅ SESSION 4 (cont. further) — root-caused + fixed the real gate-blocking bug, publish volume up
Owner asked to increase publish volume and pushed back on "sharejoa/unsanpartners have 0
pages" — correctly: that referred to the NEW off-site AEO hubs (aeo-unsanpartners-hub,
aeo-sharejoa-hub), not their real business sites (unsanpartners.kr, sharejoa.kr — untouched,
§0). Investigating why yield was so low found the REAL root cause, not just symptoms:

1. **verifiableNumbersGate ran on structurally-empty asset.claims.** It's gate #2 in the
   non-short-circuit content fold (contentGate.ts), running BEFORE claimVerificationGate
   (gate #6, PAID, the only place claimExtract populates asset.claims) — and the paid gate
   is SKIPPED once any cheap gate already blocked. So a number/superlative that WAS already
   in the customer's verified claim_source table got permanently blocked before the real
   verifier ever ran. Fixed (`29b618f`): both the superlative-coverage and bare-numeric-
   coverage checks now ALSO consult `ctx.claimSources` (already plumbed into
   ContentGateContext, zero new LLM calls) — a numeric token passes if its value matches a
   verified numeric claim_source row; a superlative passes if it's substring-covered by one.
   This can only make the cheap gate MORE permissive (paid gate remains the real backstop),
   so it does not weaken §7 enforcement.
2. **"유튜브 프리미엄" (YouTube Premium) was tripping the Korean superlative lexicon.**
   "프리미엄" was added to the avoid-list for SMIM (genuine self-praise there), but for
   sharejoa — a YouTube Premium reseller — it's an unavoidable third-party PRODUCT NAME.
   Fixed (`d1c59de`): extended the existing `isCjkSuperlativeException` pattern (already used
   for 최대한/최대<N>) so "프리미엄" preceded by "유튜브"/"뮤직" is exempt; any other
   (self-referential) use still blocks.
3. **My own data-entry bug**: 5 facts across unsanpartners/sharejoa's facts.json files
   contained a bare number ("24시간", "3개 센터", "1개월", "4K", "3단계") but were tagged
   `kind: "capability"` instead of `"numeric"` — so fix #1 above had no numeric_value to
   match against for these. Fixed (`ad43f37`): reclassified in both the JSON files and the
   already-ingested claim_source DB rows (ingest-facts.mts dedupes by exact claim_text, so a
   plain re-run would have skipped the field change — had to UPDATE directly).

**Verified impact (real dispatched runs, not just tests):** unsanpartners hub 2→4 pages,
emora hub 22→24 pages, in the SAME session after the fixes landed. Gate reports for both
show `blocked` counts dropping sharply with the corresponding numbers now reaching
`needs_human` (still not auto-published, but no longer permanently discarded) or `passed`.
2473 tests pass (7 new, covering both fixes) + tsc clean.

**sharejoa still shows 0 live pages** — NOT the gate bug (confirmed by a local
`gen-content` run: it generates fine, reaches gating, gets a normal 0-passed/1-blocked/
3-needs_human result, same shape as the other two customers). The CI dispatch that ran
right after the facts fix produced ZERO generation attempts for sharejoa specifically
across all 3 attempts (0 llm_call rows in that window) while emora's run immediately
after it succeeded with the same 2 keys — looks like a one-off transient blip (a
momentary rate-limit/quota hiccup at exactly sharejoa's turn), not a reproducible bug.
Recommend NOT chasing this further manually — let the next scheduled cron (or a future
manual dispatch) confirm whether it recurs before doing more investigation.

## ✅ SESSION 4 (cont.) — Neon migration verified end-to-end, 2 more customers, Gemini multi-key rotation, model-deprecation fix
Picked up from the Timescale outage below. Summary of everything since:

1. **Migrated to Neon** (see "Timescale → Neon" section below for the DB-outage
   story) — verified end-to-end: `migrate` (23 migrations, no Timescale extension),
   `diagnose`, `ingest-facts`, `setup-*-template`, `gh workflow run publish.yml`
   (real pages published + pushed), `gh workflow run measure.yml` (real SMR +
   email) all confirmed working against the live Neon DB.
2. **smim removed from the active roster** (owner directive, 2026-09-05) — pulled
   out of `measure.yml`/`publish.yml`/`email-report.mts`. Its DB rows (on the OLD
   Timescale — now unrecoverable anyway), `config/customers/smimdate.yaml`, and
   hub repo `sonjeongwons/aeo-smim-hub` are left as-is, just dormant. To resume:
   re-add the 3 roster entries + re-run diagnose/setup-template on Neon (its data
   there is gone along with the rest of pre-Neon history).
3. **unsanpartners (운산파트너스)** — full onboarding completed AND verified live:
   customer `41b57266-1796-4ac5-92a9-395420d891de`, hub
   https://sonjeongwons.github.io/aeo-unsanpartners-hub/ (Pages enabled, 1 §7-passed
   Korean page live), wired into publish.yml/measure.yml/email-report.mts.
4. **emora** — re-onboarded on Neon from scratch: customer
   `768167a5-6c1f-4d0a-8cf8-33a0e6f4eb41`, 13 facts re-ingested, industry template
   recreated, and its 19 pre-existing live hub pages (which never left GitHub
   Pages — only the DB forgot about them) reconnected via
   `backfill-legacy-hub-urls.mts` into `url_registry`. A publish.yml run added 3
   more pages (19→22) same day, proving the DB-to-hub link works again.
5. **sharejoa (쉐어조아)** — 4th customer onboarded (owner's own YouTube-Premium
   discount-subscription broker business, sharejoa.kr). customer
   `2264f4a3-0aa5-4054-a6c8-e16313326be1`, industry `subscription-sharing`, 10
   owner-attested facts (the site's live "N bought today" counter was
   *deliberately excluded* — not stable/verifiable, 표시광고법 risk — owner
   confirmed the price/discount figures are fine to use as-is). 15 tracked
   competitors (owner-supplied list + web-research additions: 피클플러스/GamsGo).
   Hub repo `sonjeongwons/aeo-sharejoa-hub` created, but **first publish attempt
   produced 0 passed pages** (2 blocked on attempt 1, likely the same Korean-
   numeral `verifiableNumbersGate` gap already logged for smim in
   `.project-memory/project-smim-hub.md` — sharejoa's facts are numeric-heavy:
   가격/할인율/절감액). GitHub Pages NOT yet enabled for this hub (needs a `main`
   branch, which needs ≥1 passed page first). Next publish.yml cycle may do
   better once daily Gemini quota resets; if it keeps blocking, the Korean-numeral
   claim-binding gap needs fixing (open item, not new).
6. **Gemini multi-key rotation (NEW capability)** — owner has multiple Gemini API
   keys from separate Google Cloud projects/accounts (free-tier quota is
   per-project, not per-key, so this only helps with keys from DISTINCT
   projects). `GeminiAdapter` (`src/providers/gemini.ts`) now takes
   `string | string[]`, round-robins across all configured keys, and on a
   429/rate-limit fails over to the NEXT key immediately (no wait) before
   falling back to backoff once every key in a round is rate-limited.
   Single-key behavior is byte-for-byte unchanged (all 2466 tests pass
   unmodified in logic). New `GEMINI_API_KEYS` env var (comma-separated, GH
   secret set) takes priority over `GEMINI_API_KEY`; `geminiApiKeys()` in
   `src/config/env.ts` resolves it; every `makeGeminiAdapter()` call site
   updated. **Currently armed with 2 confirmed-valid keys** — of 7 strings the
   owner pasted, only 1 new one + the existing key matched the real Gemini key
   format (`AIzaSy...`); the other 6 (`AQ.Ab8RN6...`) are NOT Gemini API keys
   (some other credential type) and were NOT wired in — ask the owner to
   re-verify/resend those from Google AI Studio's "Get API key" page if more
   parallelism is wanted.
7. **Found + fixed a live bug while smoke-testing the new key:** Google
   deprecated the pinned model id `gemini-2.5-flash-lite` for NEW Google Cloud
   projects (404 "no longer available to new users") — and that id was
   `DEFAULT_JUDGE_MODEL` (`src/judge/llmJudge.ts`), the model used for
   **every** judge call in production that doesn't pass an explicit
   `preferredJudgeModelId` (confirmed: `runResponse.ts`'s real call site never
   passes one). This meant every new-project rotation key would have started
   failing judge calls with a non-retryable 404 the moment it got used. Fixed
   by switching to the `gemini-flash-lite-latest` "-latest" alias everywhere
   this id is a functional value (not just a comment): `llmJudge.ts`
   `DEFAULT_JUDGE_MODEL`, `pricing.ts` price row, `loadTemplate.ts` DB model
   seed row. Confirmed `gemini-2.5-flash` and `gemini-flash-latest` both work
   fine on a fresh new-project key (only the OLD dated `-flash-lite` id 404s).
   Did NOT live-test `gemini-flash-lite-latest` itself (ran out of free-tier
   quota on the test key mid-investigation) — next real judge call will be the
   first live confirmation; watch the next `measure.yml`/`publish.yml` run for
   judge errors on this model id specifically.

### ON REOPEN
- Check the next `measure.yml`/`publish.yml` cloud run for any error mentioning
  `gemini-flash-lite-latest` (would mean the alias also needs adjusting).
- sharejoa: see if a later publish cycle gets any page passed; if still 0, the
  Korean-numeral verifiableNumbersGate gap is the likely blocker (same as smim).
- If the owner sends corrected Gemini keys (real `AIzaSy...` format) for the 6
  that didn't parse, add them to `GEMINI_API_KEYS` (`.env` → `sync-env.sh
  encrypt` → `gh secret set GEMINI_API_KEYS`) for full 7-key rotation.

## 🔴 SESSION 4 — Timescale → Neon: CRITICAL DB outage (RESOLVED by migration)
While onboarding a 3rd customer (unsanpartners, see below), `diagnose` failed locally with
`getaddrinfo ENOTFOUND x2j5468p66.afbymbdhap.tsdb.cloud.timescale.com`. Confirmed via
Google public DNS (8.8.8.8) too — **the hostname itself no longer exists** (not a local
network/ISP issue). Checked `gh run list` history: **every scheduled `measure.yml` and
`db-keepalive.yml` run has failed with this exact error since 2026-07-20** (last GREEN
measure.yml run was 2026-07-13, id `29228183893`). So the whole pipeline — measurement,
publish, keepalive, daily email — has been silently dead for ~7 weeks, not just for the
new customer. **OWNER ACTION NEEDED:** log into the Timescale Cloud console, check
whether the `db-aeo-geo` service was deleted / auto-archived / renamed after a long idle
period (past incidents: idle-auto-suspend, resumed via console — this looks like it went
further, to actual deletion or endpoint change, since the hostname is gone, not just
unreachable). Get the current connection string, update local `.env` (+ `secrets/env.enc`
via `bash scripts/sync-env.sh encrypt`) and the `DATABASE_URL` GitHub secret
(`gh secret set DATABASE_URL`). Until then, all DB-touching work below is blocked.

## Session 4 — unsanpartners (운산파트너스) 3rd customer onboarding — ✅ COMPLETED (see summary at top for final state)
Owner directed onboarding of unsanpartners.kr (㈜운산네트웍스, Korean auto-repair-shop
matchmaking platform: 차주/영업파트너/정비소 3-sided marketplace) as a 3rd AEO/GEO customer,
same pattern as smim. Owner confirmed: they own/operate this domain (owner also has a
private repo `sonjeongwons/unsan-partners-solution` for the underlying app), official
brand name for JSON-LD = "운산파트너스" (not the legal entity name), site's own published
numbers (28yr experience, 5% labor-fee-based partner settlement, 0-won signup, 24h intake)
are owner-attested as-is, and competitors were picked by Claude via web search (카닥/차봇/
마이클 — no scraping of competitor sites).

**Done (code, no DB write needed):**
- `config/customers/unsanpartners.yaml` (ko-only, 8 questions, budget mirrors smim: $5wk/$15mo) — schema-validated OK.
- `config/customers/unsanpartners-facts.json` (9 owner-attested facts, attested_by doradola38@gmail.com).
- `scripts/setup-unsanpartners-template.mts` (new, mirrors setup-smim-template.mts; industryKey `auto-repair-matchmaking`) — NOT YET RUN (needs DB).
- Brand map entries added to all 4 hardcoded locations: `src/deploy/connectors/ownedNet.ts`, `scripts/rerender-hub.mts`, `scripts/reupgrade-disk-pages.mts`, `scripts/gen-hub-index.mts` (name 운산파트너스, url https://unsanpartners.kr).
- `measure.yml`: CUSTOMERS default → `unsanpartners smimdate emora` (smallest-first).
- `scripts/email-report.mts`: added unsanpartners to the CUSTOMERS roster (hub URL set).
- New public GitHub repo created: `sonjeongwons/aeo-unsanpartners-hub` (empty — Pages CANNOT be enabled yet, GitHub requires a `main` branch to exist first; enable via `gh api repos/sonjeongwons/aeo-unsanpartners-hub/pages -f "source[branch]=main" -f "source[path]=/"` right after the first publish push creates one).
- `npx tsc --noEmit` clean after all edits.

**Blocked on the DB outage above — do these once DATABASE_URL is fixed:**
1. `npx tsx src/cli/diagnose.ts --customer unsanpartners` → creates customer/brand/question/customer_language/budget rows, note the returned customer UUID.
2. `npx tsx scripts/ingest-facts.mts config/customers/unsanpartners-facts.json` → ingests the 9 facts as claim_source rows.
3. `npx tsx scripts/setup-unsanpartners-template.mts` → creates the active `auto-repair-matchmaking` industry_template + brief_snapshot.
4. Add a `CONFIGS` line to `.github/workflows/publish.yml`'s "Auto-publish each armed customer" step: `"unsanpartners|<uuid from step 1>|auto-repair-matchmaking|sonjeongwons/aeo-unsanpartners-hub|https://sonjeongwons.github.io/aeo-unsanpartners-hub|unsanpartners"` (NOT done yet — deliberately, since the UUID isn't known until step 1 runs on the live DB).
5. First publish: `gh workflow run publish.yml -f customer=unsanpartners` (or run `scripts/auto-publish.sh` locally with the matching env vars) — this creates the hub's first commit, which is also the point to enable GitHub Pages (see above).
6. Verify: `gh workflow run measure.yml -f customer=unsanpartners` completes non-`over_budget` and the weekly/daily email shows 운산파트너스 alongside smim/emora.
7. Optional/deferred (not blocking): GSC/Bing verification for the new hub property.

## 🔴 SESSION 3 — end-to-end automation test: 5 cron-breaking bugs found + fixed
Ran a LIVE `gh workflow run measure.yml` to prove the whole PC-independent chain
(AI question → Gemini answer → mention/citation judge → SMR → email). It was silently
broken; fixed all of it (each pushed to main):
1. **`DATABASE_URL` GitHub secret had a STALE password** (owner reset Timescale) → EVERY
   cron failing auth silently. Updated the secret via `gh secret set DATABASE_URL` from
   the verified local `.env`. (If auth breaks again, the password was rotated — re-set it.)
2. **migrate.ts bypassed the Timescale TLS handling** ("self-signed certificate in chain")
   → extracted `resolveDbConnection()` in `src/db/pool.ts`, used by both pool + migrate. (`6d41de0`/`95d0ec2`)
3. **emora languages are re-seeded from `config/customers/emora.yaml` by loadTemplate on
   EVERY diagnose run** (upsert, never deletes) → a DB-only edit never sticks. THE TEMPLATE
   IS THE SOURCE OF TRUTH. emora.yaml now = en+ko, 6 questions (3 core intents × en/ko),
   max_languages 2 → ~36-unit baseline. DB: 33 old non-en/ko questions set `active=false`
   (FK from work_units blocks delete), 12 stale langs deleted. (`0093d3a`/`6d41de0`)
4. **measure.yml starved smim** (emora-first ate the 75-min window; smim unmeasured
   2026-07-02→07-11) + the `workflow_dispatch` `customer` default was `emora` (skipped smim
   on manual dispatch). Fixed to `smimdate emora` (smallest-first) in both. (`2fc6b4f`/`0093d3a`)
5. **Budget guard fail-closed blocked any customer idle >7 days**: `getRollingSpendUsd` read
   only the `cost_daily` CAGG (SUM = null when no rows in window) → treated as data problem →
   `over_budget`, 0 units. Added `repo.sumLlmCostSinceRaw` (authoritative raw llm_call sum,
   0 when idle) as the fallback in diagnose's costReader. (`6d41de0`)

**PROVEN working live:** after the fixes, smim's run went `running` (not instant over_budget)
and EXECUTED real units — `done=3, judged=3, hits=0` (honest 0% mention). The full chain is
confirmed PC-independent. The remaining `error` units are **free-tier Gemini daily-quota
exhaustion** (many test runs today), NOT a bug — the resume fix retries pending next cycle.

### ON REOPEN — verify (nothing is broken; just confirm):
- Did the email for run `29150876194` arrive? (measure step may hit the 75-min timeout on
  the quota-drained run, but the email step still builds+sends from existing data.)
- After the free-tier quota resets, the Monday `measure.yml` cron should complete smim(30)
  + emora(36) cleanly → both in the email with fresh SMR. Or manually re-dispatch:
  `gh workflow run measure.yml -f customer="smimdate emora"` when quota is fresh.
- `daily-report.yml` (17:00 KST) + `publish.yml` (Tue) now that DATABASE_URL is fixed — first
  green run confirms. `db-keepalive.yml` too (was also failing on the stale password).



## What this project is
Off-site AEO/GEO service. Generate §7-honest off-site content, publish to owned-net
GitHub Pages hubs, measure Share-of-Model-Recall across AI answer engines. Two live
customers: EMORA (AI character chat, en, tryemora.com) + SMIM/스밈 (Korean rotation
matchmaking, ko, smimdate.com). Canonical ids + hubs + constraints: see CLAUDE.md.

## Shipped recently (all pushed to main, suite 2461 passing)
- **Honesty gates:** W1.1 claim persistence (self-heal re-gate) · W1.7 CJK superlative false-positive fix (최대한) · W1.9 trilingual fake-signal + prompt-injection lexicons (ko/ja) · W1.10 generic-noun cross-bind guard · `isClaimVerified` + §7 invariant docs.
- **Render / structured data:** CJK CSS+dark+responsive · short pipe-safe h1 · JSON-LD (DefinedTerm/Article/FAQPage + author/publisher/isPartOf + case_study metrics) · W4.2 references + schema.org citation (render capability, not yet fed) · FAQ open+fragment-anchors · dateModified decouple · **ItemList JSON-LD on comparison** · OG tags · robots.txt (citation-bot allowlist) · RSS feed · full-ISO sitemap · IndexNow (env-gated).
- **Measurement email** (`scripts/email-report.mts`): Wilson 95% CIs · low-power badge · honest measured-engine label · drift disclosure · `report_only` dispatch · measurement-step timeout+continue-on-error. (Fixed two real bugs that had blocked all email delivery.)
- **Dashboard (apps/web):** evidence drawer wired · brand-vs-competitor §7 label fix · formatPct NaN guard + StatCard emphasis · mobile · nav/focus/loading/error.
- **Data/infra:** owner-directed §7-filtered facts ingested (emora 161, smimdate 17 claim_sources) · SMIM customer onboarded (was missing) · EMORA consolidated to canonical `emora` (stale publish ids fixed — the real cause of "0 generated content") · both live hubs re-rendered (fixed a live raw-markdown-table bug) · GSC/Bing verification files durably emitted to hubs.
- **Leading indicator (top lever, LIVE):** retrievability — Gemini embedding adapter (`gemini-embedding-001`) + pure scorer + `scripts/score-retrievability.mts`. Verified: EMORA en = 20 queries / 32 passages, **coverage 1.0**, 0 content gaps. Run: `npx tsx scripts/score-retrievability.mts --customer emora --lang en`.

## Production Timescale connected + consolidated (2026-07-11, session 3)
Owner provided the Timescale password (service `db-aeo-geo`) → local dev now points at
the LIVE Timescale (`.env` DATABASE_URL, re-encrypted into `secrets/env.enc`). Fixed
`src/db/pool.ts` for cloud TLS (strip `sslmode`, `ssl:{rejectUnauthorized:false}` for
non-localhost). **Verified live customer state by slug lookup** (NOT the localhost ids
that CLAUDE.md used to list):
- `emora` = **b1d999e5** — canonical (the real 1404-unit recall measurement). Had 0
  content/facts; measurement runs were stuck `running`.
- `smimdate` = **37a8f2bd** — 248 content_assets (24 passed), 1 completed measurement.
- ORPHANS: `emora-mini` **5eb8d7ef** (held emora's content+facts), dangling **f9d13b5c**
  (smim-style assets, no customer row), `demo` 97c47ce2.

**Consolidation applied to PROD (backup: scratchpad/prod-migrate-backup.json):**
1. Marked emora's 2 zombie `running` runs `completed` (they had real SMR data — a CI
   cycle was killed at the job timeout before `finishRun`; emora's n_total=1404 can't
   finish on free-tier within 75min).
2. Merged `emora-mini` → `emora`: re-pointed 14 claim_source + 5 content_asset to b1d999e5.
- **Code hardening:** `email-report.mts pointsFor` now surfaces runs that have a
  `run_smr_overall` row even if status is still `running` (finalization artifact, not a
  live run — weekly cron, not a daemon), with `started_at` date fallback. So future
  timed-out cycles won't hide measured data. `publish.yml` emora id 5eb8d7ef→b1d999e5.
- **RESULT (E2E verified):** daily email now shows BOTH — subject `… 스밈 언급률 0.0% ·
  EMORA 언급률 0.0%` (0.0% is honest: brands not yet in Gemini answers, pre-generation).

### Open gaps — BOTH ADDRESSED (2026-07-11, session 3 cont.)
- **EMORA "발행 페이지 0개" → FIXED.** Its 19 hub pages are legacy on-disk (no url_registry
  rows, no asset linkage). New `scripts/backfill-legacy-hub-urls.mts` reads the hub's live
  sitemap.xml and registers each URL as the true published fact (asset_id = deterministic
  UUIDv5 of the URL — url_registry.asset_id has NO FK, verified; `indexing_status='unknown'`
  = honest, §7; `publish_meta.backfill='legacy-disk-sitemap'`). Ran for emora → 19 rows;
  email now shows EMORA 발행 페이지 19개, SMIM 8개. Re-run after future disk-only publishes.
- **emora measurement never completes (n_total=1404) → FIXED via resume.** Root cause: a
  baseline = cartesian(36 Q × 13 langs × 3 samples) = 1404 work-units (intentional breadth);
  free-tier Gemini only attempts ~86/cycle before the 75-min CI kill (1318 pending, 59 err,
  27 done), and STEP 1 always minted a NEW run → weekly zombie pile-up. Fix: `runCycle` now
  RESUMES an incomplete baseline (`repo.findResumableRun`: status='running', n_total>0,
  started_at<now-2h, has pending) instead of creating a fresh one — coverage accumulates
  across cycles until the plan finishes, then a fresh baseline starts. Correctness (adversarial
  review found + fixed 2 P1s): on resume it executes ONLY the frozen plan's DB-pending units
  (`repo.findPendingWorkUnitKeys` filter) so the SMR numerator can't escape the frozen
  denominator (§5.2) even if the question set changed, skips re-insert/snapshot/startRun, and
  a tight-budget cycle leaves the run resumable (never flips to over_budget). Tests:
  `test/pipeline/baseline-resume.test.ts`. Operating runs never resume (rotation cursors).
  - OWNER DECIDED (2026-07-11): restrict emora to **en + ko only**. Applied to prod —
    emora `customer_language` now = {en, ko} (was 13 langs; the 12 removed incl. de/ja/fr/
    zh/es/… backed up to scratchpad/emora-langs-backup.json; `ko` was newly added). New
    baseline ≈ 36 Q × 2 langs × 3 samples = **216 units** → completes in ~2-3 weekly cycles
    with resume (vs ~16 for the full 13-lang set). smim unchanged (ko only, 30 units). To
    re-expand later, restore from the backup or re-insert customer_language rows.

## DB status (2026-07-11): RESOLVED — up + kept warm
Timescale had idle-auto-suspended (Jul 7 → Jul 11); owner RESUMED it in the console.
End-to-end verified: daily report connected + sent a REAL-data email (subject
"AEO/GEO 리포트 — 2026-07-11 — 스밈 언급률 0.0%"). To prevent recurrence, added
`db-keepalive.yml` (every 3h `SELECT now()` via `scripts/db-ping.mts`) so it never
idles into a pause. (Keep-alive won't stop a plan/billing pause — check the console
if it recurs.) `waitForDb` (pool.ts) also wakes a slow instance; email-report sends
a "⚠ DB 연결 실패" alert if the DB is ever truly unreachable.

## Automation reality (important)
- Claude (me) is NOT a daemon — runs only during an active session. The recurring
  jobs are **GitHub Actions crons** (cloud, PC-independent, survive reboot/VSCode close):
  `measure.yml` (Mon email+measure), `publish.yml` (Tue), and NEW `report-daily.yml`
  (daily 08:00 UTC / 17:00 KST email, report_only, no Gemini spend).
- Added DB-wake retry (`waitForDb` in pool.ts) + DB-down alert email so a suspended
  DB is tolerated/announced rather than failing silently.

## In progress / next (pick up here)
1. **Search Console / Bing verification** — owner is verifying the two hub properties in GSC (URL-prefix, HTML-file method; token `google871e8ec1d063f81f.html` served by both hubs). Then Bing "Import from GSC" (or give a Bing code → set `BING_SITE_AUTH` env → auto-emitted). Goal: 2nd free measurement channel (Copilot/ChatGPT citation data) → ingest CSV/API into the weekly email.
2. **Surface retrievability in the weekly email report** (embedding-gated) — coverage % + content-gap list next to Gemini recall.
3. **Faithfulness leading indicator** — approximate NLI via the existing Gemini judge (does the engine's brand claim stay entailed by the cited passage). §7 differentiator.
4. **Generation** — DEFERRED to free-key quota reset (owner OK). publish.yml now targets the correct customers/templates. After reset: smim gets questions + DB-registered passages so its retrievability populates; new facts + all improvements expand content.
5. Deeper exploration backlog (not built): passage-section generation (multi-section answer_block), semantic dedup, SMR→IntentMatrix feedback loop, per-engine readiness scorecard, fail-closed multilingual lexicons.

## Owner follow-ups pending
- Third-party profile URLs (Wikidata/Crunchbase/app-store/press) → activates W4.2 visible citations + W4.1 sameAs (currently all sources are owner-attested/own-domain, so W4.2 is capability-ready but not fed to avoid circular self-citation).
- Verifiable external source for the HELD EMORA marketing numbers (10k users / 50k convos / 2.3k characters — landing hero counters, 표시광고법 risk, excluded from facts until sourced).

## Gotchas
- Free Gemini key: daily quota exhausts fast; generation/embeddings degrade to graceful no-ops.
- Owned-net hub pages are content_asset `customer_id = NULL` (generic) — load them by hub URL, not customer_id.
- SMIM hub pages are legacy on-disk (not in url_registry) — use `reupgrade-disk-pages.mts` (not rerender-hub) for them.
