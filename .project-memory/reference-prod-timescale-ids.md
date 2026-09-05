---
name: reference-prod-timescale-ids
description: Live Timescale customer ids (emora/smim) + the localhost≠prod id trap
metadata: 
  node_type: memory
  type: reference
  originSessionId: ff4bc712-38f1-4212-abc7-824793702d20
  modified: 2026-09-05T02:45:46.920Z
---

LIVE Timescale (service `db-aeo-geo`, host x2j5468p66…tsdb.cloud.timescale.com:39532/tsdb)
customer ids, verified 2026-07-11 by slug lookup on the prod DB:
- `emora` = **b1d999e5-c8c1-4f6a-90a3-4d7dc2773ad5** (canonical; holds the real 1404-unit recall measurement). industry `ai-character-chat`.
- `smimdate` = **37a8f2bd-97e9-4428-b98a-d892c079e98a**. industry `rotation-dating`.
- ORPHANS — never target: `emora-mini` 5eb8d7ef (content+facts MERGED into emora b1d999e5 on 2026-07-11), dangling `f9d13b5c` (smim-style content_assets, NO customer row), `demo` 97c47ce2.

⚠ TRAP: the LOCAL dev Postgres (localhost:5432/aeo_geo) has DIFFERENT customer ids than
prod Timescale. A prior session mixed them up and broke publish.yml. **Resolve customers
by SLUG on the target DB; never copy an id between local and prod.** CLAUDE.md's old
"canonical ids" (3cb680d5 / f9d13b5c) were localhost ids and were WRONG for prod — fixed.

Related: [[project-aeo-geo-quality-overhaul]], [[feedback-multipc-git-sync]].
Email/measurement resolves by slug (correct); publish.yml uses hardcoded ids (keep in sync).

## Cron / config gotchas (learned 2026-07-11 E2E, all fixed)
- **Customer config source of truth = `config/customers/<slug>.yaml`**, NOT the DB.
  `loadTemplate` runs on EVERY `diagnose` and UPSERTS languages/questions/budget (never
  deletes). So a DB-only edit to customer_language/questions gets silently re-added next
  run. To change emora/smim languages or questions, edit the YAML. To REMOVE a question,
  also set `active=false` in the DB (loadTemplate won't deactivate; FK from work_unit
  blocks delete). emora is now en+ko (6 questions); smim is ko (10).
- **`DATABASE_URL` GitHub Actions secret goes stale if the Timescale password is rotated**
  → every cron fails auth ("password authentication failed"). Re-set with
  `gh secret set DATABASE_URL` from the working local `.env`. Current Timescale service =
  `db-aeo-geo`, host x2j5468p66…:39532/tsdb.
- **Both pool.ts AND migrate.ts need the Timescale TLS handling** (`resolveDbConnection()`
  in pool.ts) — else migrations fail "self-signed certificate in certificate chain".
- **measure.yml measures customers SEQUENTIALLY under one 75-min budget** → order smallest
  first (`smimdate emora`) or a big customer starves the rest.
- Budget guard: getRollingSpendUsd falls back to raw llm_call sum (repo.sumLlmCostSinceRaw)
  when the cost_daily CAGG is null, so an idle-&gt;7-days customer isn't fail-closed-blocked.

## 🔴 2026-09-05: Timescale host is GONE (NXDOMAIN), not just idle-suspended
`x2j5468p66.afbymbdhap.tsdb.cloud.timescale.com` fails DNS resolution entirely (confirmed
against 8.8.8.8 too — real NXDOMAIN, not an ISP/local issue). `gh run list` shows every
scheduled `measure.yml`/`db-keepalive.yml` run failing with this since **2026-07-20**; last
green run was 2026-07-13 (`29228183893`). This is different from the earlier idle-auto-suspend
incident (session 3, resumed via console) — a suspended instance still resolves DNS, this one
doesn't, suggesting the Timescale service was deleted/archived or given a new endpoint after
prolonged idleness. Fix requires the owner to check the Timescale Cloud console, get a fresh
connection string, and update local `.env`/`secrets/env.enc` + the `DATABASE_URL` GH secret.
Until fixed, ALL DB-touching work (diagnose, ingest-facts, setup-*-template, measure, publish)
is blocked for every customer, not just new ones. See [[project-unsanpartners-onboarding]].
