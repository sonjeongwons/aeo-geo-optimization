---
name: project-neon-migration
description: Migrated prod DB from TimescaleDB Cloud to Neon (2026-09-05) after the free trial ended and the instance was deleted
metadata: 
  node_type: memory
  type: project
  originSessionId: b289ea83-61ef-4d5d-9831-12cbbdc22c47
  modified: 2026-09-05T16:33:45.147Z
---

TimescaleDB Cloud's free trial ended and the instance was torn down (owner confirmed
in the console: "무료사용 끝났다고 합니다") — matches the DNS NXDOMAIN found earlier
that day (see [[reference-prod-timescale-ids]]). Owner asked for a no-payment
alternative: another free platform, or self-hosting.

**Decision: Neon** (chosen over Supabase and local Docker Postgres). Why: Neon
auto-suspends on idle and auto-RESUMES on the next connection with zero manual
action — Supabase's free tier also auto-suspends but needs a manual/API wake, which
is structurally the same failure mode that killed Timescale (a paused instance
someone forgot to resume). Local Docker was ruled out because GitHub Actions
(the whole point of the "PC-independent cron" design, see [[project-aeo-geo-phase0]])
can't reach a home DB without exposing it to the internet or losing the
PC-independence.

**Why the migration was low-risk:** an Explore-agent audit found the schema barely
used TimescaleDB-specific features at this data volume (thousands of rows, not
millions) — 4 `create_hypertable()` calls (dropped, now plain tables), one
continuous aggregate `cost_daily` (replaced with a plain always-live `VIEW` using
`date_trunc` instead of `time_bucket` — strictly better, no staleness, no refresh
policy to maintain), and a compression/retention-policy migration (no-op'd, no
plain-Postgres equivalent needed at this scale). Zero app code touched Timescale
functions directly. All 2466 tests + tsc pass unmodified.

**Consequence: old Timescale data is gone forever** (the instance was deleted, not
just paused — no export was possible). Re-onboarded emora from scratch on Neon
(new customer row, facts re-ingested from the JSON files already in git, industry
template recreated) and reconnected its 19 already-live hub pages via
`backfill-legacy-hub-urls.mts` (the hub pages themselves were never lost — they're
a separate GitHub Pages repo — only the DB's record of them was). smim was NOT
re-onboarded (owner directive to drop it, separate decision, see
[[project-unsanpartners-onboarding]]).

**Verified end-to-end on Neon same day:** `npm run migrate` (23 migrations clean),
`diagnose`, `ingest-facts`, `setup-*-template`, a live `gh workflow run publish.yml`
(real pages generated+gated+pushed), and a live `gh workflow run measure.yml` (real
SMR computed, email sent).

How to apply: if a future DB migration is ever needed again, this audit-first
approach (check what's ACTUALLY using vendor-specific features before assuming a
hard migration) is the right pattern — don't assume "uses TimescaleDB" means "hard
to move," check the real dependency depth first.
