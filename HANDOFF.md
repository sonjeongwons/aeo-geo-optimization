# HANDOFF — current state (read this first when resuming on any PC)

_Update this file at the end of every session, then commit + push. See CLAUDE.md for the sync protocol._

**Last updated:** 2026-07-05 (session 2). Latest commit: `4dd593e` (+ this handoff commit).

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
