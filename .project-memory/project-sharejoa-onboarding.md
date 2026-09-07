---
name: project-sharejoa-onboarding
description: "4th AEO/GEO customer (쉐어조아, sharejoa.kr, YouTube Premium discount broker) — onboarding decisions + status"
metadata: 
  node_type: memory
  type: project
  originSessionId: b289ea83-61ef-4d5d-9831-12cbbdc22c47
  modified: 2026-09-07T00:04:51.449Z
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

**2026-09-06 later same day: also fixed the digit+Hangul-multiplier numeral gap**
("6만원", "7천만원" — scanBodyForNumerics only ever detected the bare digit "6",
never multiplied by the Hangul 만/억/천/백 suffix, so it could never match a
claim_source's numeric_value=60000). Also added a missing fact for the 14,900원
LIST price (only the discounted 9,900원 had been recorded). See
[[reference-verifiable-numbers-gate-fix]] for the full technical detail — this fix
benefits every Korean-pricing customer, not just sharejoa.

**Confirmed: the earlier "0 generation attempts" run WAS just a transient blip** —
turned out to be caused by a SEPARATE issue: the GitHub account's Actions billing
failed that same window (private-repo Actions minutes exhausted from a day of long
manual dispatches), which made `gh workflow run` fail INSTANTLY with a billing error
for one dispatch. Owner had Claude flip the repo to public (public repos get
unlimited free Actions minutes) to unblock this permanently — see
[[project-neon-migration]] sibling note or `HANDOFF.md` session 4 for the billing
incident. Not a sharejoa-specific problem.

**Current status (after the numeral fix, re-verified live):** `verifiableNumbersGate`
now shows only ONE legitimate block ("최대" — a genuine unbounded superlative with no
source, correctly blocked) — the numeric/premium bug class is FULLY resolved for this
customer.

**2026-09-06, same day, round 3 — content-quality prompt fixes (see
[[reference-prompt-quality-fixes]] for full technical detail):**
1. Fixed the generic prompt-template gap: `definition_sentence`/`case_study` formats
   never told Gemini to lead with the brand name (only `answer_block` had that rule),
   so `selfContainednessGate` failed on those two formats for every customer, not just
   sharejoa. Added the same BLUF instruction.
2. Fixed `keywordStuffingGate`: sharejoa has 15 seedCompetitors + zero ingested
   comparative facts, so the "no facts" prompt branch forced literal "정보 없음" for
   every competitor cell — enough repetition (up to 8 competitors × several columns)
   to trip the gate. unsanpartners hits the same branch but only has 3 competitors,
   under the threshold. Capped placeholder rows to 3 max and told the model to OMIT
   competitors it can't say anything about rather than repeat the same filler phrase.
   Verified live: keywordStuffingGate and selfContainednessGate stopped firing
   entirely for sharejoa after this fix — confirmed clean in the next real batch.

**The actual remaining/final blocker, found after the above: Google's free-tier
daily quota is 20 requests/day PER MODEL PER PROJECT** (not per-minute — a much
harder ceiling than expected). Content generation and claim extraction
(`claimExtract.ts`) both defaulted to `gemini-2.5-flash`, so a day of heavy testing
across 4 customers exhausted BOTH keys' 20/day allowance for that one model,
making `claimVerificationGate`'s extraction step fail almost 100% of the time
("Extraction failed and backstop detected N unverified spans — fail closed") — this
looked like a sharejoa-specific content problem but was actually quota exhaustion
from the SAME day's testing volume, confirmed via a local repro showing the literal
429 `GenerateRequestsPerDayPerProjectPerModel-FreeTier` error. Fixed: moved claim
extraction to `gemini-flash-lite-latest` (a different model = a separate quota
bucket) — see [[reference-gemini-multikey]] for the model-id history. By the time
this fix landed, BOTH keys' `gemini-2.5-flash` daily quota (used for generation
itself) was already exhausted for the day too, so a final same-day verification
dispatch produced 0 generation attempts — expected, not a new bug.

GitHub Pages still NOT enabled for this hub (needs ≥1 ever-passed page).

How to apply: don't re-chase the numeric/premium or keyword-stuffing/self-
containedness gate classes for sharejoa — both closed and verified. When resuming
(after the daily quota resets), dispatch `gh workflow run publish.yml -f
customer=sharejoa` fresh — with all four fixes now in place (numeral binding,
프리미엄 exception, prompt BLUF + comparison cap, separate extraction model) this
SHOULD produce sharejoa's first passed page. If it still doesn't, that would be a
genuinely new, worth-investigating signal — check the actual current gate_report
reasons rather than assuming it's one of the four already-fixed classes.
