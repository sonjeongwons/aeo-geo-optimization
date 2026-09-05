---
name: reference-prod-timescale-ids
description: Live Neon customer ids (emora/unsanpartners/sharejoa) — DB migrated off TimescaleDB Cloud 2026-09-05
metadata:
  node_type: memory
  type: reference
  originSessionId: ff4bc712-38f1-4212-abc7-824793702d20
  modified: 2026-09-05T16:33:25.119Z
---

**⚠ SUPERSEDED 2026-09-05: the DB is no longer TimescaleDB Cloud.** That service's
free trial ended and the instance was torn down (confirmed via DNS NXDOMAIN on
`x2j5468p66.afbymbdhap.tsdb.cloud.timescale.com`, not just idle-suspended — every
scheduled `measure.yml`/`db-keepalive.yml` run had been silently failing since
2026-07-20). Migrated to **Neon** (serverless Postgres, auto-suspend/auto-resume,
no card required) the same day. All pre-2026-09-05 customer ids below (old Timescale
ids for emora/smimdate) are GONE — that data no longer exists anywhere; don't try to
look it up. See [[project-unsanpartners-onboarding]] and [[project-neon-migration]].

**LIVE Neon customer ids** (verified 2026-09-05/06 by slug lookup on the new DB):
- `emora` = **768167a5-6c1f-4d0a-8cf8-33a0e6f4eb41** — canonical. industry `ai-character-chat`.
  Re-onboarded from scratch (13 facts re-ingested); its 19 pre-existing LIVE hub pages
  (github.io/aeo-owned-net-hub, which never went offline — only the DB forgot them)
  were reconnected via `backfill-legacy-hub-urls.mts`.
- `unsanpartners` = **41b57266-1796-4ac5-92a9-395420d891de** — industry `auto-repair-matchmaking`.
  3rd customer (운산파트너스), hub https://sonjeongwons.github.io/aeo-unsanpartners-hub/.
- `sharejoa` = **2264f4a3-0aa5-4054-a6c8-e16313326be1** — industry `subscription-sharing`.
  4th customer (쉐어조아), hub repo `sonjeongwons/aeo-sharejoa-hub` created but Pages NOT
  yet enabled (first publish produced 0 passed pages — see [[project-sharejoa-onboarding]]).
- `smimdate` — **REMOVED from the active roster** 2026-09-05 (owner directive, "smim은
  제거해도될것같아"). Not re-onboarded on Neon — its old Timescale data is gone, config
  yaml/facts/hub repo (`sonjeongwons/aeo-smim-hub`) left dormant. To resume: re-run
  diagnose/ingest-facts/setup-smim-template on Neon + re-add to the 3 roster files
  (measure.yml, publish.yml, email-report.mts).

⚠ TRAP (still applies): the LOCAL dev Postgres has DIFFERENT customer ids than prod
Neon. **Resolve customers by SLUG on the target DB; never copy an id between
local/prod, or between the old Timescale ids and new Neon ids.**

Related: [[project-aeo-geo-quality-overhaul]], [[feedback-multipc-git-sync]],
[[project-neon-migration]], [[reference-gemini-multikey]].
Email/measurement resolves by slug (correct); publish.yml uses hardcoded ids (keep in sync).

## Cron / config gotchas (still true post-migration)
- **Customer config source of truth = `config/customers/<slug>.yaml`**, NOT the DB.
  `loadTemplate` runs on EVERY `diagnose` and UPSERTS languages/questions/budget (never
  deletes). To REMOVE a question, also set `active=false` in the DB (loadTemplate won't
  deactivate; FK from work_unit blocks delete). emora is en+ko (6 questions); unsanpartners
  and sharejoa are ko-only.
- **`DATABASE_URL` GitHub Actions secret** must match whatever `.env` currently has —
  re-set with `gh secret set DATABASE_URL` after any DB migration/password rotation.
- **measure.yml measures customers SEQUENTIALLY under one 75-min budget** → order smallest
  first (`unsanpartners sharejoa emora`) or a big customer starves the rest.
- Budget guard: getRollingSpendUsd falls back to raw llm_call sum (repo.sumLlmCostSinceRaw)
  when the `cost_daily` view is empty, so an idle->7-days customer isn't fail-closed-blocked.
