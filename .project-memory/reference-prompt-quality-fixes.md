---
name: reference-prompt-quality-fixes
description: "2026-09-06 content-generation prompt fixes — missing brand-lead BLUF instruction, comparison-table filler-repetition cap, and Google's per-model daily quota discovery"
metadata: 
  node_type: memory
  type: reference
  originSessionId: b289ea83-61ef-4d5d-9831-12cbbdc22c47
  modified: 2026-09-07T00:05:17.145Z
---

Found while debugging why sharejoa (a new customer) had zero §7-passed content
despite the claim/numeral binding gate bugs (see
[[reference-verifiable-numbers-gate-fix]]) being fixed. A subagent traced the exact
production prompt path (`genContent.ts` → `generateContentForLanguage.ts` →
`buildContentPromptForFormat` in `src/content/generationPromptContent.ts`).

**Fix 1 — missing brand-lead instruction (generic template gap, commit `7cde765`).**
`selfContainednessGate` requires `definition_sentence`/`case_study`/`answer_block`
leads to name the brand in the first 200 chars. Only `answer_block`'s entry in
`FORMAT_INSTRUCTIONS` (generationPromptContent.ts) actually told Gemini to do that
("LEAD WITH THE ANSWER (BLUF)..."); `definition_sentence` and `case_study` had no
such instruction at all. This affects EVERY customer generating those two formats,
not just sharejoa — it just showed up as sharejoa's problem because sharejoa had
zero passing content from anything else to offset it. Added the same BLUF
instruction to both entries.

**Fix 2 — comparison-table filler repetition (commit `7cde765`).** When a customer
has zero ingested `comparative` claim_source facts (the common case for a
newly-onboarded customer), the comparison_table prompt branch
(`generationPromptContent.ts` ~line 408) forces Gemini to write the literal string
"정보 없음"/"Not disclosed" for every competitor cell. `keywordStuffingGate`
(CJK-bigram tokenizer, blocks at >=8 occurrences AND >=5% density) trips on this once
a customer has enough competitors — sharejoa has 15 seedCompetitors (capped to 8 for
display), producing enough repeated cells to cross the threshold; unsanpartners hits
the same code path but only has 3 competitors, staying under it; emora mostly avoids
it by having real ingested comparative facts (`ingest-competitor-facts.mts`). Fixed
by capping placeholder rows to at most 3 and instructing the model to OMIT a
competitor as a row entirely rather than repeat the same filler phrase for every one.
**Verified live**: the very next real sharejoa batch showed zero
keywordStuffingGate/selfContainednessGate failures.

**The actual final blocker — Google's free-tier quota is PER MODEL PER PROJECT PER
DAY, not per-minute (commit `4809c3f`).** After fixes 1-2, sharejoa's content still
failed almost 100% at `claimVerificationGate` with "Extraction failed... fail
closed". Assumed transient rate-limiting at first (RPM-style) — WRONG. A local
`gen-content` repro surfaced the real 429 body:
`quotaId=GenerateRequestsPerDayPerProjectPerModel-FreeTier, quotaValue=20,
model=gemini-2.5-flash`. This is a **daily** cap of 20 requests, tracked separately
per model per Google Cloud project. `claimExtract.ts`'s `DEFAULT_EXTRACT_MODEL` was
the SAME `gemini-2.5-flash` used for content generation, so a day of generation
testing across 4 customers silently zeroed out extraction's shared bucket too — the
fail-closed backstop then (correctly, but unhelpfully) routed nearly everything to
needs_human. Fixed by moving extraction to `gemini-flash-lite-latest` — a different
model gets an independent daily bucket. By the time this landed, BOTH rotation
keys' `gemini-2.5-flash` daily quota was ALSO exhausted (from the day's generation
testing itself), so a final verification dispatch that day produced zero generation
attempts — expected consequence of the same 20/day-per-model reality, not a new bug.

**Big-picture implication for future sessions:** 20 requests/day/model/project is a
VERY tight budget. A single day of manual testing (repeated `gh workflow run`
dispatches with high `attempts`) can and did exhaust it across multiple models and
both rotation keys. Before concluding something is "still broken" after a fix,
check whether it's actually just today's quota exhausted (`gemini-2.5-flash` and
`gemini-flash-lite-latest` now split across generation/judge/extraction — check ALL
of them) rather than re-diagnosing. Real week-to-week throughput will be governed by
this same daily ceiling — heavier manual testing on any given day directly reduces
that day's (and possibly the next day's, if a key gets used right at the reset
boundary) real automated throughput. More distinct-project keys in
`GEMINI_API_KEYS` each carry their OWN 20/day-per-model bucket, so is the most
direct lever for real capacity (see [[reference-gemini-multikey]]).
