# SOTA Sweep — AEO/GEO state-of-the-art → EMORA engine (guardrail-filtered)

Source: multi-agent research workflow `aeo-geo-sota-sweep` (20 agents, 6 source
modalities: arXiv, Google Patents, GitHub, Reddit/HN, vendor blogs, measurement
methodology). **60 findings → 13 proposals → 12 cleared / 1 rejected** by an
adversarial §0/§7 guardrail panel (each proposal independently judged for
off-site-only + honesty violations).

Every "change" below is the **guardrail-cleared** version (the panel rewrote
several to strip §0/§7 risk). Impact/effort are the panel's.

---

## Applied this cycle

| # | Proposal | Status | Evidence |
|---|----------|--------|----------|
| **A** | **PAWC — early-position word share** (GEO KDD'24, arXiv 2311.09735). Pure scalar in [0,1]: position-weighted brand word share, mean over brand-mentioned responses. Relabeled non-causally ("early-position word share", NOT "influence"); composite Influence Score + TF-IDF corpus DROPPED (§0/§7). | ✅ `src/metrics/pawc.ts` + `computePawcShare` + `RunReport.pawc` + 7 tests | arXiv 2311.09735 (GEO-optim/GEO) |
| **B** | **`<link rel="alternate" type="text/markdown">`** in rendered hub pages → makes the existing `index.md` twin discoverable. Only the discoverability link adopted; llms.txt scoring / Accept-negotiation dropped (not actionable on static Pages). | ✅ `src/deploy/connectors/render.ts` | aeoengine.ai audit (llms.txt ignored by crawlers); Evil Martians (clean .md routes work) |
| **C** | **Per-prompt mention rate + Wilson CI** — `PerPromptVisibility[]` on RunReport, one row per (question, model, language) cell, mentionRate + Wilson CI + lowPower(n<30). Pure tally extracted to `promptVisibility.ts`; honest — strictly noisier than run-level SMR, most cells flagged. | ✅ `src/metrics/promptVisibility.ts` + `computePerPromptVisibility` + 8 tests | arXiv 2604.07585 ("Don't Measure Once") |
| **D** | **Per-engine citation share** — `CitationByModel[]` on RunReport, citation_hits(model)/work_unit(model) + Wilson CI + lowPower, "mention vs clickable-citation per engine". | ✅ `src/metrics/promptVisibility.ts` + `computeCitationShareByModel` | Otterly AI Citation Economy (per-platform mention vs citation %) |

> Note: the sweep **independently re-derived MUST #4** (baseline-vs-operating
> significance, "transformative") and **MUST #6** (append-only security_audit),
> validating the Fisher-for-small-n choice, and **praised `src/judge/citation.ts`**
> (MUST #2) for ORing the LLM self-report with a deterministic link scan and
> gating citation_hits ≤ brand_hits. Those are already shipped this session.

---

## Queued — measurement (high value, additive, no §0/§7 risk)

| # | Proposal | Impact / Effort | Cleared change (already de-risked) |
|---|----------|-----------------|-------------------------------------|
| ~~C~~ | ~~Per-prompt visibility + Wilson CI~~ | ✅ **APPLIED** (see above) | — |
| ~~D~~ | ~~citationShareByModel decomposition~~ | ✅ **APPLIED** (see above) | — |
| **E** | **Judge reliability harness** | high / L | **PARTIALLY APPLIED.** ✅ Statistical core shipped + tested: `src/judge/reliability.ts` — `cohenKappa` (inter-judge agreement on brand_mentioned), `signedBiasScore` (tie-pair brand lean), `positionSwapConsistency`, `classifyAgreement` (WARN at κ<0.5 disclosed floor; **single-engine → "not_measurable", never a fabricated κ**). ⏳ DEFERRED (gated on a 2nd `JUDGE_PROVIDER` key, same gate as multi-engine): the LIVE orchestration — dual-judge paired sampling, swap-and-rejudge calls, and budget-ledgering (§11) the extra calls. Not wired into the live pipeline today precisely to avoid an unreachable "capability" path (cf. MUST #1's dead-adapter fix). |
| **F** | **Ranking-injection robustness flag** | low / M | Pure read-only detector over stored answerText: imperative-injection tokens near a competitor mention / anomalous brand_rank → hedged `manipulationSuspected` note on `MeasurementQuality`. MUST NOT alter rank/Visibility/SoV/SMR. Never name a competitor as manipulator. Cite only arXiv 2406.03589. |

## Queued — content-gen (needs care: evidence reconciliation / new seams)

| # | Proposal | Impact / Effort | Cleared change |
|---|----------|-----------------|-----------------|
| **G** | **Intent→format ordering** (listicle-for-commercial signal) | high / M | ONLY reorder EXISTING `FULL_PROSE_FORMATS` per channel/tier using formats that already exist; reconcile the two conflicting evidence sources rather than swap citations; keep determinism + caps; update `contentMatrix.test.ts`. NO new format types / intent plumbing. |
| **H** | **GEO-readiness content gate (9th gate)** | high / M | Phase-2 advisory `geoReadiness.ts` scoring ONLY pre-deploy ContentAsset pillars (answer-block band, FAQ row count, meaning_key, claim/source density, consume jsonLdShapeGate result). Advisory `needs_human`, NOT a hard block (external G≥0.70 cutoff uncalibrated on EMORA). NO live-URL fetch; freshness/slug deferred to Phase-3 deploy linter. Dashboard: "indexing hygiene", no citation-lift number. |
| **I** | **Title↔query passage-match + natural-language slugs** | high / M | **PARTIALLY APPLIED.** ✅ (a) Natural-language slugs: `naturalLanguageSlug()` + `_deriveSlugFromRequest` now builds keyword slugs from the salient field per content_type (definition→meaning_key, faq→first question, comparison→columns, answer_block/case_study→lead text), with URL/bare-domain STRIPPING (§0/§7 — a slug can never embed a domain pulled from prose) + assetId uniqueness suffix + non-Latin fallback. 7 tests. ⏳ (b/c) Title↔query relevance objective DEFERRED — needs an embedding provider seam (or a deterministic lexical-overlap v1); must be relabeled a "title-relevance proxy", kept out of published content/reports. |
| **J** | **Quotation + statistics levers (gate-bounded)** | medium / M | Statistics lever + featureScore ride existing verifiableNumbers/claimVerification gates. Quotation MUST be a typed `{text, attribution, source_id}` forced through claimVerification (unsourced attribution → needs_human). Re-key selector to REAL IntentType axes. Frame lift figures as disclosed single-actor upper bounds (C-SEO Bench). |

## Queued — hosting

| # | Proposal | Impact / Effort | Cleared change |
|---|----------|-----------------|-----------------|
| **K** | **(MUST #6) append-only security_audit** | medium / S | ✅ Shipped this session, exceeding the spec with a tamper-evident hash chain. |
| **L** | **Off-site corroboration / per-engine citation share** | medium / L | Adopt ONLY the per-engine citation-share extension (= proposal D). DROP per-claim corroborating-domain count + earned/owned split until a SERP/scrape surface persists independent source domains AND an owned/earned classifier can run without representing the customer domain (§0). Keep vendor uplift figures OUT of reports. |

---

## Rejected (correctly, on §0)

- **Citation faithfulness/grounding check** — verifying the cited SOURCE supports
  the answer requires reading content AT the cited URL (the customer's own domain)
  → **§0 violation**. Also needs embedding infra that doesn't exist, and would
  silently suppress deterministically-detected citations from the Wilson-CI
  numerator (§7 over-certainty). The panel noted `citation.ts` already handles the
  real honesty concern conservatively.

---

## Recommended next batch

**C + D** first (transformative/high, pure, reuse `wilsonInterval` + migration
0020 citation filter, zero §0/§7 risk), then **E** (judge reliability — highest
integrity gain, but budget-ledger the extra calls), then content-gen **G/I**
(slug fix is a quick correctness win). **H/J** need evidence reconciliation and a
gate-design review before coding.
