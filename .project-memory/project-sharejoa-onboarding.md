---
name: project-sharejoa-onboarding
description: "4th AEO/GEO customer (쉐어조아, sharejoa.kr, YouTube Premium discount broker) — onboarding decisions + status"
metadata: 
  node_type: memory
  type: project
  originSessionId: b289ea83-61ef-4d5d-9831-12cbbdc22c47
  modified: 2026-09-06T07:21:21.748Z
---

Owner directed onboarding of **sharejoa.kr** (쉐어조아 — a YouTube Premium
subscription-discount broker: resells at 9,900원 vs the 14,900원 list price,
~34% off, includes YouTube Music Premium) as a 4th AEO/GEO customer, requested
2026-09-05. Owner owns this business (private repo `sonjeongwons/sharejoa` exists
on their GitHub).

**Owner decisions (confirmed, don't re-ask):**
- The site's real-time "오늘 구매 67명" (N bought today) counter was **deliberately
  excluded** from owner-attested facts — not a stable/independently-verifiable
  claim, 표시광고법 risk, same reasoning as emora's held marketing hero-counters.
  Owner confirmed the price/discount/savings figures (9,900원, 34%, ~6만원/year) ARE
  fine to use as owner-attested facts as-is.
- Competitors: owner supplied 13 names (굿멍쉐어/구독로그/하루쉐어/골드튜브/쉐어프렌즈/
  올쉐어/바로쉐어/구독핀/프리쉐어/유패밀리/링링튜브/그레이쉐어/쉐어넘버원) + asked Claude
  to add more via web research → added 피클플러스(PicklePlus)/감스고(GamsGo).
- New public hub repo `sonjeongwons/aeo-sharejoa-hub` approved and created.

**Status as of 2026-09-06:** code-side onboarding done + DB rows on Neon (customer
`2264f4a3-0aa5-4054-a6c8-e16313326be1`, industry `subscription-sharing`, 10 facts
ingested). Wired into measure.yml/publish.yml/email-report.mts.

**The root cause of the initial 0-passed-pages was found and fixed** — see
[[reference-verifiable-numbers-gate-fix]] for the full technical writeup. Short
version: two real gate bugs (not the customer's fault) — (a) `verifiableNumbersGate`
ran on a structurally-empty `asset.claims`, so numbers/superlatives that WERE already
verified in `claim_source` got permanently blocked before the paid verifier ever ran;
(b) "유튜브 프리미엄" (a literal third-party product name sharejoa must use) was
tripping the Korean superlative lexicon meant to catch SMIM-style self-praise. Both
fixed 2026-09-06. Also found+fixed my own data-entry mistake: 5 facts (24시간/3개
센터/1개월/4K/3단계) were tagged `kind:"capability"` instead of `"numeric"`, so they
had no numeric_value to match against even after the gate fix.

**Still 0 live pages as of the last check** — but NOT the gate bug anymore (verified:
a local `gen-content` run for sharejoa generates fine and reaches gating with a normal
result shape, same as unsanpartners/emora). The one CI publish run dispatched right
after the facts fix landed produced zero generation attempts for sharejoa specifically
(0 llm_call rows) while emora's run immediately after it succeeded with the same keys
— looks like a one-off transient blip, not a reproducible bug. GitHub Pages is NOT yet
enabled for this hub (needs a `main` branch, which needs ≥1 passed page ever).

How to apply: when resuming, check whether a subsequent publish.yml cycle (scheduled
or dispatched) got ANY page through for sharejoa. If it keeps coming back with 0
generation attempts (not 0-passed-after-gating, but literally 0 attempts) across
multiple separate cycles, THAT would be worth investigating as a real bug — but a
single occurrence isn't enough signal yet.
