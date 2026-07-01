# SOTA Sweep v4 — emerging frontiers + adversarial SELF-AUDIT

Source: workflow `aeo-geo-sota-sweep-v4` (24 agents, 8 finders: agentic commerce, voice, multimodal, new engines, MCP/agent ecosystems, regulation, adversarial robustness, **+ a self-audit finder reviewing our own shipped code**). **83 findings → 15 proposals → 12 cleared / 3 rejected.**

The self-audit finder paid off: it found **4 real BUGS in code shipped earlier this session** — all now FIXED + regression-tested.

---

## BUG FIXES (self-audit found; ✅ APPLIED + tested this session)

| Bug | What was wrong | Fix |
|-----|----------------|-----|
| **B1** (transformative) **claim⊆source polarity inversion** | `findMatchingSource` scored by token overlap with ZERO negation handling — a claim "X does NOT support Y" could bind to source "X supports Y" and **false-verify a contradiction** (§7 violation). | Deterministic `polarityAgrees()` prefilter (en/ko/ja negation cues); a polarity DISAGREEMENT drops the match → needs_human (fail-closed). Same-polarity (both "no setup") still binds. +2 tests. |
| **B2** (high) **RECOMMENDATION over-fire** | substring alias/verb matching, no quote filter, no self-attribution filter, dormant `void CONTRAST` — inflated recommendationShare on quoted self-claims, self-promotion, and verbs-inside-words. | Bounded alias+verb matching; `stripQuoted` (recommendation inside a quote doesn't count); SELF_ATTR guard ("EMORA markets itself…"); honored CONTRAST (suppress when pivot flips brand negative). Third-party reco still fires. +5 tests. |
| **B3** (high) **CITATION substring false-positive** | `containsAlias` used `includes()` → alias "emora" matched inside "memora-health.com" / "emorandum.io", crediting a NON-brand URL as a brand citation. | Boundary-anchored `hasBoundedMatch` (alias must be delimited by non-[a-z0-9]). emora.ai / 에모라 still match. +1 test. |
| **B4** (high) **groundingGap redirect wrappers** | Gemini grounding `uri` is a `vertexaisearch…/grounding-api-redirect/…` wrapper, so every fetched/cited domain resolved to **google.com** — making the whole fan-out/earned-source measurement wrong. | `domainForChunk(uri,title)` — on a wrapper host, derive the registrable domain from the chunk `title` (Gemini puts the source site there); null (excluded) when indeterminable, never miscounted. +4 tests. |

---

## Cleared features (queued)

| # | Proposal | Impact / Effort | Cleared change |
|---|----------|-----------------|-----------------|
| **W1** ✅ SHIPPED (parser) | **Cited-source agent-accessibility index** | high / M | DONE (pure parser): `src/metrics/botAccessibility.ts` — `parseRobots`/`isAllowed` (standard group + longest-match + `*`/`$` wildcards) + `botAccessibility` (13 AE bots: GPTBot/OAI-SearchBot/ChatGPT-User/PerplexityBot/Google-Extended/ClaudeBot/CCBot/Bytespider/Amazonbot/Applebot-Extended/…) + `aggregateAccessibility` (per-bot allowedShare + per-domain crawlEligibility, over KNOWN only). §7: null robots → "unknown" NOT "allowed". §0: the fetch of 3rd-party robots.txt is DEFERRED behind an integration allowlist — the pure module NEVER fetches. 32 tests. |
| **W2** ✅ SHIPPED | **Split googleAio → AI Overviews vs AI Mode** | high / M | DONE: `googleAiMode` SurfaceId fully wired as a NOT_CONFIGURED SERP surface (consistent, no manifest↔registry gap): types.ts union + SERP_ONLY_SURFACES + COMPLIANCE_MANIFEST (scrapePermitted=false, assertSerpOnly, notes "never re-pool w/ googleAio") + surfacePricing ($0, not-metered) + worker limits + `aiModeParser` (delegates to the proven aiOverviewParser on the `ai_mode` block, re-tags surfaceId, NEVER throws) + `makeGoogleAiModeAdapter` + registry. Metrics already key on surfaceId so the two never re-pool. serpOnlyGuard test invariants updated (2→3). Arms only when an official AI Mode SERP API exists. |
| **W3** | **AI-authorship provenance on hub content** | high / M | IETF AI-Disclosure header + C2PA text-manifest on published owned-net pages (machine-readable "AI-assisted" disclosure). §7-honest, regulation-forward (FTC/EU AI Act). C2PA signing needs a cert. |
| **W4** ✅ SHIPPED | **FTC guardrail gate (anti-fabricated-persona)** | high / S | DONE: `src/content/gates/noFabricatedPersona.ts` — pure structural cheap-tier gate (runs before paid claimVerification). BLOCKs invented demographic personas ("Sarah, a 32-year-old marketer, says…"), intro personas ("Meet Sarah"), attributed testimonial quotes, first-person endorsement voice ("I've been using…", "my experience with"), self-styled endorsers ("As a longtime user"), invented spokespeople. Precision guards PASS first-person QUESTIONS ("How do I cancel?"), 2nd-person instructions, 3rd-person facts, and JSON-LD. Tri-lingual en/ko/ja. Registered in default + production registries (9→10 gates). 16 tests + registry test updated. tsc=0. Complements noFakeSignalsGate (which catches review/vote COUNTS). FTC 16 CFR Part 465. |
| **W5** | **Per-engine retrieval-backend-overlap proxy** | medium / L | Model each engine's retrieval backend (Brave for Claude, X for Grok, organic top-10 for AIO) to explain/predict citation differences. Needs Brave Search API (Claude proxy). |
| **W6** ✅ SHIPPED (verifier) | **Audit-log hardening** | medium / M | DONE (pure verifier + anchor): `src/security/auditChainVerify.ts` — `computeEntryHash` (sha256 of `seq\nprevHash\npayloadHash`, matched to the existing `securityAudit.ts` writer scheme in the doc) + `verifyChain` (seq contiguity + prevHash linkage + recomputed-hash match; INVALID on ANY inconsistency, brokenAt) + `computeHeadAnchor` (the head hash to publish to an append-only external sink) + `detectTruncation` (catches a missing/rewritten anchored seq). The external sink publishing + scheduled verifier job are DEFERRED integration. 27 tests. |
| **W7** ✅ SHIPPED (estimator) | **Never-optimized holdout query panel + drift control cohort** | medium / L | DONE (pure DiD estimator): `src/metrics/driftControl.ts` — `computeDriftControl` difference-in-differences over targeted vs holdout before/after cells: `targetedDelta`, `ecosystemDrift` (holdout delta, reported explicitly), `netEffect` (DiD), normal-approx CI (4-cell variance sum), `lowPower` flag, RangeError guards. Separates "our content worked" from "ecosystem shifted". The holdout PANEL SELECTION + per-cycle measurement wiring are DEFERRED integration. 25 tests. |
| **W8** | **Owned-vs-earned citation-mix + per-engine fabrication prior** | medium / M | Ratio of owned-net vs earned (third-party) citations per engine (over the earned-source corpus + citation channel) + condition citationFidelity on a per-engine fabrication prior (seeded from literature, labeled external). |

## Rejected (correctly)
- **"significance uses unpaired Fisher when arms share the prompt set"** — already covered by roadmap R9 (paired-difference + BH-FDR); and no per-prompt paired grid exists yet to pair over.
- **Engine-side manipulation self-check (KVR+PPL-R)** — duplicate of v3 V6 stealth gate.
- **Adopter-density/saturation covariate** — duplicate of the C-SEO competitive-decay disclosure already shipped.

## Build order
The **4 bug fixes shipped** (highest priority — they corrected live §7/measurement errors). **W4 shipped** (FTC anti-persona gate). Next: **W1** (cited-source accessibility, needs robots.txt fetch-allowlist) → **W6** (audit-log external anchor) → **W7** (holdout control cohort) → **W8/W2** (need surface/engine plumbing) → **W3/W5** (need external certs/keys).
