---
name: project-unsanpartners-onboarding
description: "3rd AEO/GEO customer (운산파트너스, unsanpartners.kr) — onboarding decisions + status"
metadata: 
  node_type: memory
  type: project
  originSessionId: b289ea83-61ef-4d5d-9831-12cbbdc22c47
  modified: 2026-09-05T02:46:01.609Z
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

**Status as of 2026-09-05 (session 4):** code-side onboarding done (yaml, facts.json,
setup-unsanpartners-template.mts, 4 hub brand-map edits, measure.yml + email-report.mts
customer-list edits, new GitHub Pages repo created but empty). **Blocked on a prod DB
outage** — see [[reference-prod-timescale-ids]] 2026-09-05 entry — so the actual DB rows
(customer/brand/facts/industry_template), the publish.yml CONFIGS entry (needs the
customer UUID, which only exists after the first DB write), and enabling GitHub Pages
(needs a `main` branch, which only exists after the first hub push) are all still pending.
Full remaining checklist is in HANDOFF.md under "Session 4 — unsanpartners onboarding".

How to apply: when resuming this work, do NOT re-collect the decisions above — just check
whether the DB outage is fixed yet, then run the blocked steps in HANDOFF.md in order.
