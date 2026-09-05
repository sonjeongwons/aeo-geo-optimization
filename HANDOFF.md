# HANDOFF — current state (read this first when resuming on any PC)

_Update this file at the end of every session, then commit + push. See CLAUDE.md for the sync protocol._

**Last updated:** 2026-09-05 (session 4).

## 🔴 SESSION 4 — CRITICAL: Timescale DB is UNREACHABLE (NXDOMAIN), has been for ~7 weeks
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

## Session 4 — unsanpartners (운산파트너스) 3rd customer onboarding — CODE DONE, DB STEPS BLOCKED
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
