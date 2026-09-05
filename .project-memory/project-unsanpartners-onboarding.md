---
name: project-unsanpartners-onboarding
description: "3rd AEO/GEO customer (운산파트너스, unsanpartners.kr) — onboarding decisions + status"
metadata: 
  node_type: memory
  type: project
  originSessionId: b289ea83-61ef-4d5d-9831-12cbbdc22c47
  modified: 2026-09-05T16:34:34.496Z
---

Owner directed onboarding of **unsanpartners.kr** (㈜운산네트웍스, Korean auto-repair-shop
matchmaking platform — 차주/영업파트너/정비소 3-sided marketplace: automates vehicle intake,
quoting, repair, and settlement) as a 3rd AEO/GEO customer, same pattern as
[[project-smim-hub]]. Requested 2026-09-05.

**Owner decisions (confirmed, don't re-ask):**
- Owner owns/operates this domain (also has a separate private repo
  `sonjeongwons/unsan-partners-solution` for the underlying PWA+Django app).
- Official brand/JSON-LD name = **"운산파트너스"** (the service/domain name), not the legal
  entity name "㈜운산네트웍스" that appears in on-page copy.
- Site's own published numbers — 28yr repair experience, 5%-of-labor-fee partner
  settlement, 0-won partner signup, 24h intake — are **owner-attested as-is** (owner said
  "그대로 써주세요"), no additional undisclosed numbers to add.
- Competitors were NOT specified by the owner — owner said to pick them via web research
  (no scraping). Chose 카닥(Cardoc), 차봇(Chabot), 마이클 as the tracked comparison set.
- Owner approved creating a new public GitHub repo `sonjeongwons/aeo-unsanpartners-hub`
  (separate from the other two hubs — same §7 entity-hygiene reasoning as smim's dedicated hub).

**Status: ✅ COMPLETED 2026-09-05.** The prod DB outage ([[reference-prod-timescale-ids]])
turned out to be permanent (Timescale free trial ended, instance deleted) — see
[[project-neon-migration]] for the DB migration this triggered. After migrating to
Neon, unsanpartners was onboarded fully: customer `41b57266-1796-4ac5-92a9-395420d891de`,
facts ingested, industry template created, first publish succeeded (1 §7-passed Korean
page live), GitHub Pages enabled at https://sonjeongwons.github.io/aeo-unsanpartners-hub/,
wired into all 3 roster files (measure.yml/publish.yml/email-report.mts). No remaining
work for this customer specifically.

How to apply: this customer is live and steady-state now — no special handling needed
beyond normal weekly measure/publish cycles.
