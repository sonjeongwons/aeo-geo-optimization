# SOTA Sweep v2 — net-new AEO/GEO improvements (excludes everything already shipped)

Source: multi-agent workflow `aeo-geo-sota-sweep-v2` (30 agents, 8 source modalities: arXiv-2026, HuggingFace, GitHub, Reddit/HN, patents, vendor-studies, measurement-stats, intl/Korean). **82 findings → 42 novel → 19 proposals → 19/19 guardrail-cleared** (every proposal salvageable with a §0/§7 modification; 0 outright rejected) + a completeness critic that surfaced 7 missed angles.

Each "change" below is the **guardrail-cleared** version (the panel rewrote each to strip §0/§7 risk). All exclude already-shipped capabilities (Wilson CI, citation split, Fisher significance, PAWC, judge-reliability stats, security_audit, GEO-readiness gate, comparison pages, etc.).

---

> **APPLIED this session:** R1 (recommendation tier — full vertical + migration 0022, 8 tests), R2 (Gwet AC1 + bootstrap CI in reliability.ts, 8 tests), R3 (partial-pooling `pooling.ts` + PerPromptVisibility pooled fields, tests). Also fixed a latent DB bug: migrations 0020/0021 had never actually applied to the live DB (CREATE-OR-REPLACE-VIEW column-append violation in 0020); corrected + all of 0020/0021/0022 now applied.

## Tier 1 — pure, additive, no external dependency (implement first)

| # | Proposal | Impact / Effort | Cleared change (de-risked) |
|---|----------|-----------------|-----------------------------|
| **R1** | **Recommendation tier** (mention → citation → **recommendation**) | high / M | NEW `src/judge/recommendation.ts` — conservative deterministic detector (recommendation⊆mention), mirrors `citation.ts`: only mark on UNAMBIGUOUS positive constructs (brand in a "best/top/recommended" list item, or affirmative recommend-verb with brand object) WITH a negation/hedge guard. Emit `recommendationShare` + `recommendationOfMentionRate` (≤ brandHits enforced like citation_hits). DROP the vendor ~69% number from any output. Label "conservative lower-bound, deterministic". Evidence: lilyraynyc/Substack (citation≠recommendation). |
| **R2** | **Gwet AC1/AC2 + bootstrap-CI agreement** (κ without a 2nd LLM key) | transformative / M | Add `gwetAC1()`/`gwetAC2()` + `bootstrapAgreementCI()` to `reliability.ts`; let `classifyAgreement` accept an AC1 coeff. Compute agreement between the LLM judge's `citation_present` and a deterministic citation label (SERP `citations[]` alias-match + `detectCitation` over prose) → persist `det_citation_present` (migration). Report as **"deterministic-vs-LLM citation cross-check", NOT inter-judge κ** (the two raters share the alias signal — non-independent). Keep `not_measurable` honesty for the true 2nd-LLM case. |
| **R3** | **Jeffreys per-cell intervals + hierarchical partial-pooling** | medium / M | `jeffreysInterval` in metrics.types + NEW `src/metrics/pooling.ts`; keep raw rate AND Wilson CI on every PerPrompt/CitationByModel row, add `pooledRate`/`posteriorCi95` as SEPARATE labeled fields (never overwrite); `lowPower` keeps keying off raw n; add `ci95` to Visibility/SoV (absent today) with a deterministic-seeded bootstrap. Tests: pooled∈[raw,run-mean], 1/3 cell wider than 30/90. |
| **R4** | **Per-engine citation churn / retention over run waves** | high / M | NEW `src/metrics/persistence.ts` (non-parametric): per (cited URL|brand)×model, track presence across the customer's run sequence → `wavesPresent/wavesObserved` retention + `churnAlert` (cited in run N-1, absent in run N). NO fitted half-life/λ; advisory + lowPower-gated (≥4 waves). Windowed query over existing hypertable + `RunReport.persistence`. |
| **R5** | **Changepoint/CUSUM ecosystem-shift detector** | high / M | NEW `src/metrics/changepoint.ts` (pure): flag "possible ecosystem shift" only when a delta is correlated across many prompts in one wave AND exceeds a conservative threshold. `not_measurable` when waves<4-5 / single-engine. Strictly advisory + hedged ("may be industry-wide, not your content"). |

## Tier 2 — high value, small wiring / migration

| # | Proposal | Impact / Effort | Cleared change |
|---|----------|-----------------|-----------------|
| **R6** | **Cross-model agreement + retrieval-mode tagging** | high / M | `computeCrossModelAgreement()` + consideration-set Jaccard "list stability" over ≥2 engines (else not_measurable); `retrieval_mode` per engine TYPE (serp/scrape: citations[] non-empty=grounded; chat: in-prose links or not_applicable — never blanket-ungrounded). Keep Wilson+lowPower per slice. |
| **R7** | **Query fan-out coverage** (advisory authoring signal) | high / L | `facetCoverage[]` optional advisory on RunReport: trigram-overlap of hypothesized sub-queries vs the engine's OWN owned-net content_asset bodies (§0: assert owned-net only). NOT a KPI, NOT in report.metrics; coarse tiers + disclosure ("does not measure retrieval/citation; authoring prioritization only"). Cache sub-query set per question. |
| **R8** | **Intent/answer-type stratification of metrics** | medium / M | `question.intent_type` column (migration, nullable backfill); thread generateQuestions→materialize; `SMRDecomposition.byIntent[]` (SMR + citation rate per intent, Wilson CI + lowPower, work_unit denominators). DESCRIPTIVE only — no routing recommendation, no geo-bench distribution in reports. |
| **R9** | **Clustered/paired-difference significance + BH-FDR** | high / M | Add `benjaminiHochberg(pValues,alpha)` + `compareProportionsPaired(opVec,baseVec)` to significance.ts as DORMANT pure helpers (requires real per-prompt aligned outcome vectors; falls back to unpaired otherwise). Do NOT wire into the WoW test (no clustering defect there). Gate behind a future per-prompt significance grid. |

## Tier 3 — content-gen advisories (no lift claims)

| # | Proposal | Impact / Effort | Cleared change |
|---|----------|-----------------|-----------------|
| **R10** | **GEO-SFE structural / format-diversity advisories** | medium / M | Extend `geoReadinessGate` (NOT a new gate) with measurable pillars: answer-first/BLUF, table/structured presence, list shape, format-diversity across the content_set. Advisory-only (always pass, gate_report.reason). NO citation-lift multipliers (2.5x/1.9x/+17.3% forbidden in output). Keep selfContainedness binary. |
| **R11** | **Per-fact content-decay flag gate** | medium / M | NEW advisory `contentDecayGate` (always-pass): flag stale-prone facts (versioned numbers, "as of 2025"/"Q3", pricing) in gate_report for human review/regeneration scheduling. Built on `numericDetect`. MUST NOT auto-rewrite or stamp per-fact "valid-until" dates (machine-asserted freshness = unverifiable). |
| **R12** | **First-party original-data assets** | medium / M | Use EXISTING case_study/answer_block formats (no new ContentType) on owned_net; mark provenance="first-party". Numbers seeded as `customer_attested` claim_source rows with parsed numeric bound, **human-signed via reviewClaims before publish** (gates stay fully in force). One advisory geoReadiness pillar for specific-figure density. NO citation-lift number in output. |
| **R13** | **Cited-but-not-entailed in-answer support proxy** | high / M | NEW `src/judge/faithfulness.ts` — takes (answerText, brandStatementSpan, brandAliases) ONLY, **never fetches citation_url** (§0; test asserts no network). Deterministic lexical-overlap labeled an **in-answer support PROXY** (`inAnswerSupportProxy` + `cited_statement_unsupported` flag, Wilson CI) — NOT "faithfulness/NLI/precision/recall". Annotates citationShare ("N of M cited statements lack in-answer support"), never alters its denominator. Graded NLI deferred to local HHEM model / 2nd key. |
| **R14** | **Consensus answer-term vocabulary overlap** (judge-free) | medium / L | `answerVocabularyOverlap` ∈[0,1] between OWNED content_asset bodies and the collected answer-term vector — descriptive, NOT "citability predictor"/"consensus". n-gram v1; cross-engine weighting gated behind ≥2 engines ok. DROP the retrieval-proximity/top-K component (unobservable). §0 assert owned-only. |
| **R15** | **AgentGEO diagnose→minimal-repair layer** | high / L | NEW `src/content/diagnoseRepair.ts` Assess→Analyze→Act (operator/internal-facing): classes from EXISTING signals (gate verdicts / PAWC+selfContainedness / zero-mention across Wilson set). DROP all AgentGEO % priors; lift only as measured Wilson-CI delta. Repairs re-pass all 9 gates before publish. Reads competitor signal ONLY from captured `mention_judgment.competitors_found` (§0). |

## Tier 4 — external-dependency / bigger

| # | Proposal | Impact / Effort | External need |
|---|----------|-----------------|---------------|
| **R16** | **Off-site unlinked brand-mention + sentiment + review-presence index** | high / L | own-brand-only read of community/review surfaces via OFFICIAL API (allowlist + own-brand guard, NOT_CONFIGURED stub today); independent covariate on RunReport.metrics, never blended into SMR; sentiment as independent WARN flag. |
| **R17** | **AI-crawler server-log telemetry on the owned hub** | medium / L | edge/server logs (GitHub Pages lacks them → Cloudflare/self-host). Descriptive "crawl delivery/freshness" panel per AI-bot, NOT joined to SMR, no funnel/causal framing. |
| **R18** | **Per-market source-authority + Naver/HyperCLOVA KR + native twins** | high / L | HyperCLOVA X / Korean-model key for KR judging; Wikidata DRAFT generation only (human-submit, no auto-edit). KR SMR inherits Wilson/lowPower/not_measurable. Vendor %s + "creator citation pay" kept OUT of reports; paid placement excluded. |
| **R19** | **Competitive position-corrected A/B → causal per-factor odds-ratios** | high / XL | synthetic one-factor competitor variants (no scraping), position-counterbalanced logit → measured odds-ratio per content factor. Turns the 9 heuristic gates into measured lifts. Reuses positionSwapConsistency. More sampling budget. |

---

## Completeness critic — 7 missed angles (next sweeps)

> **✅ #1 APPLIED (this session):** `src/metrics/earnedSources.ts` (pure aggregator) + `computeEarnedSources(runId)` reading response_raw.provider_meta.grounding + `RunReport.earnedSources` — the "who gets cited for our prompts" domain graph (cited/fetched/co-cited counts, citationRate + Wilson CI + lowPower, ranked targeting list). §0-safe (engine-returned URLs only, never fetched). 5 tests + live-verified (empty until grounding on). Unblocked by V1.

1. **Earned-source corpus (BIGGEST miss):** every proposal measures the BRAND's own presence; nothing aggregates the FULL set of third-party domains/URLs the engines cite across the answer corpus. The engine already parses citations and throws away non-brand ones. A "who gets cited for our prompts" domain graph (freq × engine × intent, co-citation with brand) is near-zero marginal cost, §0-safe, and the highest-leverage *targeting* input the engine lacks (which reddit/listicle/wiki to earn placement on). **Strong candidate for the next build.**
2. **Agentic retrieval/fan-out traces:** capture the engine's OWN emitted search sub-queries + fetched URLs (got-fetched-but-not-cited vs never-fetched) — exposes the retrieval gap.
3. **Negative/risk & brand-safety measurement:** all metrics are positive-presence. No measurement of mis-description, competitor-feature mis-attribution, hallucinated pricing, negative sentiment, or competitor-recommended-in-head-to-head. A wrong mention is worse than none.
4. **Multi-turn/follow-up dynamics:** sampling is single-turn; whether the brand survives into turn 2-3 (recommendation persistence under pushback) is a distinct KPI.
5. **Video/non-HTML citation modalities:** engines increasingly cite YouTube/transcripts; channel_class enum + a transcript content type are missing.
6. **Embedding/retrieval-proximity instrumentation:** Gemini embeddings (on the existing key) → why a competitor passage was retrieved (embedding proximity to query) makes content levers falsifiable.
7. **Cost/ROI modality:** measurement-cost-per-confident-cell, adaptive/sequential sampling to a target CI width at min spend — directly relevant given free-tier RPM + per-token cost.

## Top picks (critic) + recommended build order
Critic top-5: R16, R7, R5(recommendation→ actually R1), R2, R18.
**My build order (pure-first, no external dep):** R1 (recommendation tier) → R2 (Gwet AC1 stats) → R3 (Jeffreys/pooling + Visibility/SoV CI) → **earned-source corpus (critic #1)** → R4/R5 (churn/changepoint) → then migration-bearing R6/R8 → content advisories R10/R11/R13.
