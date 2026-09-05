---
name: project-sharejoa-onboarding
description: "4th AEO/GEO customer (쉐어조아, sharejoa.kr, YouTube Premium discount broker) — onboarding decisions + status"
metadata: 
  node_type: memory
  type: project
  originSessionId: b289ea83-61ef-4d5d-9831-12cbbdc22c47
  modified: 2026-09-05T16:34:02.541Z
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

**Status as of 2026-09-06:** code-side onboarding done + DB rows created on Neon
(customer `2264f4a3-0aa5-4054-a6c8-e16313326be1`, industry `subscription-sharing`,
10 facts ingested). Wired into measure.yml/publish.yml/email-report.mts. **First
publish attempt produced 0 passed pages** (2 blocked on attempt 1 of 2) — likely the
same open gap noted for smim in [[project-smim-hub]]: Korean numeral→claim_source
binding fails the `verifiableNumbersGate`, and sharejoa's facts are numeric-heavy
(가격/할인율/절감액 — exactly the kind of content that gate blocks). GitHub Pages is
NOT yet enabled for this hub (needs a `main` branch, which needs ≥1 passed page).

How to apply: when resuming, check whether a later publish.yml cycle got any page
through. If still 0 after a few cycles, the Korean-numeral claim-binding gap is
worth fixing for real (it's now blocking TWO customers, not just one) — see
[[reference-korean-claim-binding]] for the existing partial fix and the open gap.
