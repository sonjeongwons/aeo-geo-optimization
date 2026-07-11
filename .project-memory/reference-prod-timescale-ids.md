---
name: reference-prod-timescale-ids
description: Live Timescale customer ids (emora/smim) + the localhost≠prod id trap
metadata: 
  node_type: memory
  type: reference
  originSessionId: ff4bc712-38f1-4212-abc7-824793702d20
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
