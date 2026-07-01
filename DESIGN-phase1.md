# Phase 1 — Target-Question Auto-Generator + Industry-Template Store — Canonical Design

> Source: `phase1-design` workflow (3 Opus proposals → adversarial cross-check → synthesis). Builds ON the verified Phase 0 engine.
> Authoritative: `SPEC.md` §2 module 1, §5.5 industry templates, §5.7 baseline/operating, §6 multilingual, §7 guardrails, §11 cost, §0 off-site-only.

## Overview

Phase 1 is a target-question auto-generator + industry-template store layered on the verified Phase 0 engine. Input: a customer URL (the §3 30-second diagnosis) and/or an industry; output: 50-200 questions spread over funnel_stage x phrasing-variant x language, plus a competitor set, persisted FIRST as an industry_template row (status='draft'), promoted draft->reviewed->active by a human (§5.5 mandatory), then materialized into the EXISTING per-customer question/competitor tables so the Phase 0 planner/measurement runs unchanged.

The canonical design is built from the strongest, spec-and-code-verified parts of all three proposals: P1's minimal landing path (route everything through loadTemplateFromObject -> upsertQuestion/upsertCompetitor, the same path the YAML loader uses; reuse industry_template JSONB as the draft surface, NO new staging table), P2's measurement-instrument rigor (deterministic IntentMatrix coverage contract BEFORE spend, native per-language generation seeded by intent DESCRIPTORS not English strings, deterministic non-leading brand guardrail, weight-proportional language allocation reusing the sortByWeight semantics), and P3's immutable-version lifecycle (every revision is a new draft row, never an in-place mutation of an active row) plus its explicit SSRF call-out. I REJECT P2's embedding+LLM-critic tier (no embed seam on the adapter; violates 'no new provider integration'; self-judge bias) and P3's question_candidate/url_diagnosis/candidate_cache tables (over-DDL; the human review gate already lives in industry_template).

Pipeline (8 stages, each pure or behind an existing seam): (A) URL diagnosis: off-site read-only GET with SSRF guard -> heuristic extraction -> ONE Gemini call -> BrandBrief. (B) IntentMatrix: pure cartesian plan funnel x intent_type x language with per-cell counts from language weights and a clamped total (50-200). (C) Native per-language generation: one Gemini call per language seeded by intent descriptors. (D) density_tier mapping: deterministic, with a HARD core-share cap. (E) Dedup: normalized-exact + character-n-gram near-dup (CJK-safe), per-language. (F) Guardrails: deterministic non-leading/brand-stuffing/superlative rejection. (G) Assemble + persist as industry_template draft via insertIndustryTemplate. (H) Review lifecycle + materialize-on-active into question/competitor (+ authoritative YAML emit for the diagnose proof path).

Every Gemini call reuses the Phase 0 GeminiAdapter via a NEW structured-generate adapter method (the current generate() supports neither responseMimeType nor responseSchema — verified). Cost is ledgered through the existing llm_call path after a small, justified additive migration (0006) that widens the purpose CHECK and relaxes run_id/customer_id NOT-NULL so onboarding-time spend is captured.

## URL Diagnosis (off-site, read-only)

FLOW (`npm run diagnose-url -- --url https://emora.app [--customer emora]`), strictly off-site read-only (§0):

1. FETCH (src/generate/urlFetch.ts) — a UrlFetcher seam over Node 22 built-in fetch(), GET-only by construction (no POST/PUT/PATCH verb exists in the module, so '§0 never modify the customer site' is STRUCTURAL not by-convention). Controls: AbortController 8s timeout, max-body ~1MB cap (truncate stream), descriptive User-Agent, redirect-follow limited to <=3 and same-registrable-domain, http(s)-only scheme allowlist, and an SSRF GUARD that resolves the host and REJECTS private/link-local/metadata ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7) BEFORE connecting (P3's named control, made concrete per Review 1/2 must-fix). robots.txt/noai honored best-effort with the reason recorded; a robots block does NOT hard-fail — it degrades to industry-only. Only the customer-supplied URL is ever fetched; competitors are inferred from LLM knowledge, never scraped (stays clear of §12).

2. EXTRACT (src/generate/extractPage.ts) — heuristic readability, NO new heavy dep: pull <title>, meta description, og:*/twitter:*, JSON-LD Organization/Product (name/sameAs/description for free), <h1..h3>, nav/anchor text, and lang/hreflang (a strong native-language signal). Strip script/style/nav/footer; truncate to ~6-8K chars to bound tokens. A minimal regex/cheerio extractor; LLM tolerates noisy input.

3. INFER (src/generate/diagnose.ts) — ONE Gemini call (gemini-2.5-flash) via the NEW adapter.generateStructured() (forced JSON, responseSchema from a zod BrandBrief schema). Output BrandBrief = { brandName, brandAliases[] incl. transliterations to seed §5.4 matching, category, industryKey (normalized slug), positioning/wedge, icp/useCases[], productAttributes[], seedCompetitors[{name,aliases}], detectedLanguages[{code,weight,rationale}] (from hreflang+content), confidence }. Prompt: infer ONLY from provided evidence, mark low confidence rather than hallucinate, never invent metrics/superlatives (§7#2).

4. MERGE/DEGRADE — if --industry also given, union seedCompetitors with the matched active industry_template's competitors. If fetch fails / SPA-empty / robots-blocked, degrade gracefully to industry-only with a logged note for the reviewer. The 30-second target holds: ONE fetch + ONE Gemini call. Diagnosis is advisory; the §5.5 reviewer can edit every inferred field before activation.

## Question Model & Generation

DATA MODEL (src/generate/types.ts, zod): IntentCell { intentType: 'brand'|'category'|'comparison'|'alternative'|'useCase'|'attribute'; funnelStage: 'awareness'|'consideration'|'decision'; language: string; targetCount: int; densityTier }. DraftQuestion { text; language; funnel_stage; density_tier; intentType; phrasingGroupId } — a SUPERSET of QuestionSchema (the extra intentType/phrasingGroupId live only in industry_template.questions JSONB for the reviewer; stripped to the 4 canonical columns {text,language,funnel_stage,density_tier} on promote — provenance loss at the per-customer level is ACCEPTED and documented per all three reviews' must-fix, since the question table has only those 4 columns).

GENERATION ALGORITHM:
1. Axis taxonomy (3 axes + 1 intra-cell): funnel_stage maps to the free-text question.funnel_stage column (values awareness/consideration/decision, matching emora.yaml). intent_type is a GENERATION-TIME concept folded into funnel_stage+density_tier on promote (NO new DB column). language = priority languages. phrasing_variant = multiple natural surface forms of ONE intent (§7#1 applied to questions: question/imperative/keyword-style, with/without year, head/long-tail) sharing a phrasingGroupId.

2. IntentMatrix build (src/generate/intentMatrix.ts, PURE/testable): given requestedTotal (default 120, CLAMP 50-200) and the BrandBrief, allocate per (language x funnel_stage x intent_type) cell. Language share is proportional to customer_language.weight using the SAME ordering as sampling/languageWeight.ts sortByWeight (so Phase 0 and Phase 1 agree on priority); within a language a fixed funnel mix (awareness 30 / consideration 35 / decision 35) biased toward category+comparison+alternative+useCase over pure brand. The matrix is the auditable COVERAGE CONTRACT — it states exactly how many of each kind, in which language, BEFORE any token is spent.

3. Per-cell fill (src/generate/generateQuestions.ts via multilingual.ts): per language, ONE Gemini call (batched across that language's cells) returns K phrasing variants per intent. Over-generate ~1.3x cell target to give dedup/guardrails room (cap at 1.3x, not 1.5x, to bound one-time cost). Seed = intent DESCRIPTORS + brand/category/wedge.

4. density_tier mapping (src/generate/densityMap.ts, PURE/deterministic, NOT LLM-assigned): decision-stage brand+comparison+alternative+category intents in the TOP-weighted languages -> core (the SMR battlegrounds); consideration+useCase+mid-weight -> secondary; awareness+attribute long-tail+lowest-weight + most paraphrase siblings -> secondary or longtail. CRITICAL FIX (all 3 reviews): a HARD core cap — core kept to <=20-25% of the final set AND an absolute max core-count per language — enforced deterministically at generation time, so the weekly N=5 core volume cannot trip emora.yaml's $10/wk weekly_usd_cap. Lead phrasing variant of an intent may be core/secondary; paraphrase siblings default to secondary (NOT all dumped to longtail/monthly, which would defeat the §7#1 monitoring goal flagged by Review 3).

Output: 50-200 valid QuestionConfig rows ready for industry_template.questions JSONB and (after review) the question table.

## Industry-Template Store & Lifecycle

Reuses the EXISTING industry_template table verbatim (id, industry, version, status CHECK draft/reviewed/active, questions jsonb, competitors jsonb, reviewed_by, reviewed_at, created_at) — NO new store/staging table (rejecting P3's question_candidate/url_diagnosis/candidate_cache as over-DDL; the JSONB draft surface already serves staging).

LIFECYCLE (§5.5 draft->reviewed->active, immutable-version, append-only — adopting P3's model, fixing P2's in-place-edit flaw):
- DRAFT: the generator's assembler writes status='draft' via the EXISTING repo.insertIndustryTemplate(). The generator can NEVER emit reviewed/active. The questions JSONB carries full provenance (intentType, phrasingGroupId, source=url|industry, brief snapshot, generated_total) for the reviewer.
- REVIEW EDIT = NEW VERSION (not in-place): a reviewer edit exports the JSONB, edits, and RE-IMPORTS as a brand-new row with version=max(existing for industry)+1, status='draft'. Active/reviewed rows are IMMUTABLE — only their STATUS transitions, never their questions/competitors. This preserves append-only history + rollback (re-activate a prior version). On every import AND every status transition the payload is RE-VALIDATED against QuestionSchema/CompetitorSchema so a bad density_tier/language fails at review time, not later at promote (Review 1/3 must-fix).
- STATUS TRANSITIONS (src/cli/reviewTemplate.ts): `--action reviewed --by <email>` sets status='reviewed', reviewed_by, reviewed_at=now() (only from 'draft'). `--action active` requires the row already be 'reviewed' (refuse active-directly-from-draft — STRUCTURAL §5.5 gate). Activating sets status='active'.
- AT-MOST-ONE-ACTIVE-PER-INDUSTRY: enforced by a PARTIAL UNIQUE INDEX (migration 0006) on industry_template(industry) WHERE status='active' (industry_template is a PLAIN table, so a partial unique index is legal — NOT an app-level race-prone check). Activating a new version first demotes the prior active to 'reviewed' inside the same transaction (NO 'archived' status value added — avoids the status-CHECK widen + TS-union audit risk all reviews flagged on P3).
- VERSIONING/REUSE: getLatestActiveTemplate(industry) returns the newest active version; onboarding a same-industry customer clones its questions/competitors as the BrandBrief seed (the §5.5 horizontal reuse). industryKey normalization is a controlled-vocabulary slug emitted by the BrandBrief (lowercased, hyphenated) — documented as best-effort; near-dup industries are a reviewer concern, not a correctness blocker.

New repo functions (additive, no edits to existing signatures): getIndustryTemplate(id), listIndustryTemplates(industry), updateTemplateStatus(id, status, reviewedBy), getLatestActiveTemplate(industry), nextTemplateVersion(industry), demoteActiveTemplate(industry) (txn helper).

## Multilingual Pipeline (§6)

NATIVE per-language generation, machine translation FORBIDDEN (§6). src/generate/multilingual.ts:
1. LANGUAGE SET + WEIGHTS: from BrandBrief.detectedLanguages reconciled with the customer's intended customer_language weights (or the cloned template). Reuses sampling/languageWeight.ts sortByWeight semantics so the two phases AGREE on priority order.
2. PER-LANGUAGE NATIVE CALL: for each target language, a SEPARATE Gemini call whose system prompt instructs: 'You are a native <lang> speaker; write the questions a real <lang>-speaking user would type into an AI assistant; use native script and the local category vocabulary; DO NOT translate the English.' It passes intent DESCRIPTORS (intentType, funnelStage, brand, category, wedge, competitor names kept script-appropriate) — NEVER English question strings — so output is native generation, not covert translation (every review's must-fix).
3. WEIGHT-PROPORTIONAL ALLOCATION: the IntentMatrix gives higher-weight languages MORE questions and more core-tier slots; lowest-weight languages get a thin awareness/longtail slice. Deterministic + pure so re-runs reproduce. max_languages still caps at MEASUREMENT time via Phase 0's existing trim — generation may produce up to the customer's configured language count (emora=14); we do NOT generate beyond the configured/weighted set, reconciling the spec's '18+' capability with the verified emora.yaml=14 reality (Review 1 must-fix). Per-run Gemini calls = 1 diagnosis + ~L generation (~15 for emora), well under any cap.
4. NATIVE-NESS QA = THE HUMAN GATE, not an LLM critic: low-resource languages (tl, vi, th) carry a needs_native_review flag in the JSONB so the §5.5/§6 reviewer focuses there. We do NOT claim the LLM's native generation substitutes for native human review; the reviewer IS the verified backstop. Transliteration seeding: the diagnosis proposes brand/competitor transliterations (エモーラ/에모라) that flow into aliases, closing the loop with §5.4 evidence matching.

## Guardrails & Dedup (§7)

DEDUP (src/generate/dedup.ts, PURE/testable, CJK-SAFE):
- Layer 1 exact/normalized: NFC + lowercase + diacritic-fold + collapse-whitespace + strip trailing punctuation, drop exact collisions. Pre-empts the question UNIQUE(customer_id,text,language) so promotion never throws.
- Layer 2 near-dup WITHIN a language: CHARACTER n-gram (codepoint 3-gram) Jaccard similarity — NOT token/word Jaccard — so it works for non-space-delimited ja/ko/zh/th (emora's priority markets; every review's #1 dedup must-fix). NO embeddings (the GeminiAdapter exposes only generate()/judge()/structured; an embed endpoint is a new provider integration the brief forbids — P2/P3's embedding path is REJECTED). Threshold tuned on emora ja/ko/zh fixtures. Within a near-dup cluster keep the most natural representative + bounded phrasing-variant siblings from DIFFERENT phrasingGroupIds (preserve §7#1 variety, kill accidental restatements).
- Cross-language dedup is NOT applied (an en and a ja phrasing of the same intent are legitimately both kept — that is multilingual coverage). Stable ordering => reproducible output.

GUARDRAILS (src/generate/questionGuards.ts, PURE, mirrors Phase 0's runGates fold):
- NON-LEADING (the key §7#1 guardrail): reject any question containing the brand name/alias UNLESS intent_type='brand' (where naming the brand is legitimate, e.g. 'is EMORA free'). Brand-leading/superlative forms ('why is EMORA the best...') bias SMR upward and corrupt measurement -> dropped. Enforced two ways: prompt forbids it + deterministic post-check.
- REALISTIC/NEUTRAL: reject marketing copy, yes/no closed forms, keyword-salad (unless a deliberate keyword-style variant), and superlative/unverifiable-claim language (§7#2 — questions are neutral probes, carry no claims).
- The §7#2 verifiable-numbers guarantee is inherited structurally: questions carry no claims; the Phase 0 report DTO has no free-text claims field.

§5.5 HUMAN GATE (mandatory, STRUCTURAL): generator terminal state is status='draft'; reviewTemplate refuses active-from-draft; materialize refuses any template whose status != 'active'. No generated question reaches a live measurement run without an explicit human transition. Automated guardrails raise the floor; the human sets the bar (and is the native-QA backstop).

## Cost Design (§11)

§11 bounded, one-time onboarding cost (NOT the weekly N_total driver).
- CALL BUDGET: per generation run = 1 URL-diagnosis call + ~L native generation calls (batched per language; ~15 for emora's 14 langs) = ~16 calls; up to ~21 at 18+ langs. NO embedding calls, NO LLM-critic pass (both cut). Over-generation capped at 1.3x. Models: gemini-2.5-flash for diagnosis + generation (quality matters for the instrument), gemini-2.5-flash-lite optional for low-weight languages. gemini-2.5-pro never used here. All three models are already seeded by loadTemplate.
- COST LEDGER REUSE: every Phase 1 Gemini call writes an llm_call row through the existing insertLlmCall path with purpose='generation' (a value already permitted — see migration note for the run_id/customer_id relaxation that makes onboarding-time logging possible), so Phase 1 spend flows into the SAME cost_daily CAGG/dashboards/alerts.
- BUDGET PREFLIGHT — uses the REAL global seam, not a fictional one: a brand-new URL-first customer has no customer/budget row and an empty CAGG, so the customer-scoped preflight() would either deadlock (fail-closed) or see nothing. RESOLUTION: gate onboarding generation against env GLOBAL_WEEKLY_USD_CAP/GLOBAL_MONTHLY_USD_CAP (these EXIST in config/env.ts, defaults 50/150 — Review 2's 'no seam' claim is false) PLUS an explicit per-run qgen USD ceiling (default small, ~$0.50). Because cost_daily's refresh policy has end_offset=>'1 hour' (verified), the run's own in-flight spend is invisible to the CAGG for up to an hour; the per-run ceiling is enforced by a PROCESS-LOCAL accumulator over the actual usage returned by each call (Review 3 must-fix), not by re-reading cost_daily mid-run. Once a customer exists, normal Phase 0 budget.ts applies to its operating cycles unchanged.
- CACHING: identical (url) or (industryKey+language+intentCell) requests within TTL reuse the existing response_cache by request_hash, avoiding re-billing repeated onboarding attempts.
- NO weekly amplification: generated rows feed density_tier, and the HARD core-cap keeps weekly full-sample core volume modest; the EXISTING §5.3 tiering/§11 caps bound ongoing measurement cost automatically.

## Phase 0 Integration

Generated questions land in the EXISTING question table via the EXISTING write path; NO Phase 0 read-side change to planner/sampler/judge/metrics/scheduler. (Detail repeated under phase0Integration field above — two boundaries: industry_template library for review, question/competitor live config via loadTemplateFromObject -> upsertQuestion/upsertCompetitor; single authoritative config/customers/<slug>.yaml emitted by materialize because diagnose.ts hard-requires it at lines 58-60; proof path diagnose-url -> draft -> reviewed -> active(materialize+YAML) -> npm run diagnose.)

## New Migrations (obey Phase 0 TimescaleDB rules)

ONE new migration, numbered 0006 (0005 is ALREADY taken by 0005_compression_retention.cjs — VERIFIED; every review's #1 numbering must-fix). It has TWO parts because of the hypertable rule:

PART A — 0006_phase1_templatestore.sql (plain transactional SQL; industry_template is a PLAIN table):
- CREATE UNIQUE INDEX IF NOT EXISTS uq_industry_template_version ON industry_template (industry, version);
- CREATE UNIQUE INDEX IF NOT EXISTS uq_industry_template_active ON industry_template (industry) WHERE status='active';  -- at-most-one-active-per-industry, race-free (partial unique index, legal on plain table)
- Optional advisory columns (additive, nullable): ALTER TABLE industry_template ADD COLUMN IF NOT EXISTS source_url text, ADD COLUMN IF NOT EXISTS customer_slug text, ADD COLUMN IF NOT EXISTS generated_total int.
  NO 'archived' status value is added (avoids the status-CHECK widen + TS-union audit risk on P3).

PART B — 0006_phase1_llmcall.cjs (pgm.noTransaction(), mirroring the existing 0004/0005 .cjs convention for hypertable DDL) — the llm_call changes so onboarding-time generation can be ledgered:
- ALTER TABLE llm_call ALTER COLUMN run_id DROP NOT NULL;       -- run_id has NO FK to run() (VERIFIED 0002), only a NOT NULL; generation has no run
- ALTER TABLE llm_call ALTER COLUMN customer_id DROP NOT NULL;  -- URL-first diagnosis precedes any customer row
- ALTER TABLE llm_call DROP CONSTRAINT <purpose_check>; ADD CONSTRAINT ... CHECK (purpose IN ('generation','judge'));  -- (purpose value 'generation' already suffices; only widen if a distinct 'diagnosis'/'qgen' value is wanted — default keeps 'generation' to avoid touching the TS union)
  SAFETY VERIFIED: llm_call is a hypertable BUT has NO compression policy (0005 compresses only response_raw + mention_judgment — VERIFIED), so these are metadata-only ALTERs with no compressed chunks to decompress. Run via .cjs/noTransaction() per Phase 0 convention as a precaution. The cost_daily CAGG aggregates sum(usd)/count(*) GROUP BY day,customer_id — relaxing run_id does NOT affect it; rows with NULL customer_id simply group into a NULL-customer bucket and are excluded from per-customer budget reads (intended: pre-customer diagnosis spend is global-cap-gated only).

This obeys all Phase 0 TimescaleDB rules: no CAGG over 2 hypertables, no hypertable unique index omitting the partition col (the new unique indexes are on the PLAIN industry_template), no cross-table CHECK, non-transactional policy/hypertable DDL via .cjs.

## Module Tree

NEW (Phase 1), mostly additive; one genTemplate.ts rewrite; existing modules reused unchanged.

src/generate/
  types.ts             # zod: BrandBrief, IntentCell, DraftQuestion, GenOptions
  urlFetch.ts          # UrlFetcher seam: GET-only, SSRF guard, timeout/size/redirect caps
  extractPage.ts       # title/meta/og/JSON-LD/headings/hreflang extraction, token-bounded
  diagnosePrompt.ts    # PURE prompt builder for BrandBrief inference
  diagnose.ts          # 1 Gemini structured call -> BrandBrief; graceful degrade
  intentMatrix.ts      # PURE: BrandBrief + total -> IntentMatrix (lang x stage x intent_type), weight-allocated, clamp 50-200
  densityMap.ts        # PURE: (intent_type, funnel_stage, lang weight) -> density_tier + HARD core cap
  generationPrompt.ts  # PURE per-language native prompt builder (intent descriptors, not English)
  generateQuestions.ts # per-cell Gemini fill (seed language)
  multilingual.ts      # per-language native generation + weight allocation (§6)
  dedup.ts             # PURE: normalized-exact + codepoint-n-gram near-dup (CJK-safe), per-language
  questionGuards.ts    # PURE: non-leading/brand-stuffed/superlative rejection (§7)
  assembleTemplate.ts  # combine -> {questions[], competitors[]} draft payload; re-validate vs schema
  materialize.ts       # active template + ctx -> CustomerTemplate -> emit YAML -> loadTemplate()

src/cli/
  diagnoseUrl.ts       # NEW: URL -> BrandBrief JSON (standalone 30s diagnosis)
  genTemplate.ts       # REWRITE: --url and/or --industry [--customer --total]; full pipeline -> draft
  reviewTemplate.ts    # NEW: draft->reviewed->active lifecycle; new-version-on-edit; reviewer identity
  (materialize is invoked by reviewTemplate --action active, or a thin materialize.ts CLI)

src/api/ (optional, mirrors existing Fastify server.ts)
  routes/generate.ts   # POST /diagnose-url, POST /templates(draft), PATCH /templates/:id/review, POST /templates/:id/activate

src/providers/
  gemini.ts            # EXTEND: add generateStructured(req) (forced JSON via responseMimeType+responseSchema)
  types.ts             # EXTEND: GenerateStructuredRequest/Result + 'structured' capability already declared

src/cost/
  qgenBudget.ts        # NEW: global-cap + per-run USD ceiling preflight (env GLOBAL_*_USD_CAP + process-local accumulator)

src/db/
  migrations/0006_phase1_templatestore.sql   # plain: unique indexes + advisory cols
  migrations/0006_phase1_llmcall.cjs          # noTransaction: relax llm_call run_id/customer_id NOT NULL
  repo.ts              # EXTEND (additive): getIndustryTemplate, listIndustryTemplates, updateTemplateStatus, getLatestActiveTemplate, nextTemplateVersion, demoteActiveTemplate
  schema.ts            # EXTEND: llm_call run_id/customer_id -> nullable in TS type; industry_template advisory cols

config/customers/<slug>.yaml   # EMITTED by materialize (single authoritative artifact)

test/
  intentMatrix.test.ts densityMap.test.ts dedup-cjk.test.ts questionGuards.test.ts
  extractPage.test.ts urlFetch-ssrf.test.ts multilingual-alloc.test.ts
  templateLifecycle.test.ts materialize-roundtrip.test.ts assemble-schema.test.ts
  diagnose.integration.test.ts genTemplate.integration.test.ts

REUSED UNCHANGED: sampling/* (languageWeight semantics referenced, not edited), pipeline/*, metrics/*, cli/diagnose.ts, config/template.schema.ts + loadTemplate.ts (validation+upsert landing), cost/pricing.ts + cache.ts + ledger.ts seams.

## Key Decisions

- **Add a generateStructured() method to the GeminiAdapter rather than reusing generate() or bypassing the adapter with raw GoogleGenAI.** — VERIFIED: gemini.ts generate() sends only {model,contents,temperature} — no responseMimeType/responseSchema; only judge() does forced JSON (hard-wired to JudgeVerdictSchema). All three proposals falsely claimed 'reuse the adapter for forced JSON.' The current genTemplate.ts bypasses the adapter with raw GoogleGenAI. Keeping the provider seam (one new method, parameterized by a caller-supplied zod/Gemini schema) is cleaner than scattering raw clients and respects 'reuse the Phase 0 ProviderAdapter, no new provider integration' (Gemini, not a new provider). The 'structured' capability is already declared on the adapter.
- **Reject embeddings-based and LLM-critic dedup/QA (P2/P3); use deterministic codepoint-n-gram near-dup + the human gate as the QA backstop.** — VERIFIED: the GeminiAdapter exposes only generate()/judge()/structured — there is NO embed surface. An embeddings endpoint is a new @google/genai integration the brief forbids. Token/word Jaccard fails for non-space-delimited ja/ko/zh/th (emora's priority markets); codepoint 3-gram Jaccard is CJK-safe. The same-family LLM-critic has disclosed self-judge bias and roughly doubles one-time cost for marginal gain the §5.5 human review already provides.
- **Renumber the migration to 0006 and split it into 0006_*.sql (plain) + 0006_*.cjs (noTransaction for llm_call).** — VERIFIED: migrations dir already contains 0005_compression_retention.cjs — all three proposals said '0005' and would collide. industry_template is a plain table (unique/partial-unique indexes are plain SQL). llm_call is a hypertable, so its ALTERs use the established .cjs/noTransaction() convention (mirrors 0004/0005).
- **Relax llm_call.run_id AND customer_id NOT NULL (not just run_id); do NOT add a synthetic run/FK workaround.** — VERIFIED: run_id is NOT NULL but has NO FK to run() (Review 3 correct; P1's risk #1 premise — an FK — is FALSE). customer_id is also NOT NULL with no FK. URL-first onboarding has neither a run nor a customer when the diagnosis call fires, so both must be nullable to ledger that spend. The 'synthetic onboarding run' idea is unnecessary and uglier. cost_daily aggregates by customer_id; NULL-customer diagnosis rows simply fall outside per-customer budget reads (intended).
- **llm_call.purpose CHECK can be widened safely if desired, but default to keeping value 'generation'.** — VERIFIED: llm_call is a hypertable but has NO compression policy (0005 compresses only response_raw + mention_judgment — Review 2's 'compression on llm_call' claim is FALSE), so a CHECK change is metadata-only. purpose is a TS literal union 'generation'|'judge' (schema.ts:211) so adding a value is a real code edit; keeping 'generation' avoids touching the union and any switch-on-purpose consumers. Run via .cjs as a precaution.
- **Gate onboarding-time generation with env GLOBAL_*_USD_CAP + a process-local per-run USD accumulator, not the customer-scoped budget.ts/cost_daily path.** — VERIFIED: GLOBAL_WEEKLY_USD_CAP/GLOBAL_MONTHLY_USD_CAP exist in config/env.ts (defaults 50/150 — Review 2's 'no seam' claim is FALSE). A brand-new customer has no budget row and an empty CAGG, so customer-scoped preflight would deadlock fail-closed. cost_daily's refresh has end_offset=>'1 hour' (verified), so it cannot see in-flight spend; a process-local accumulator over real per-call usage enforces the per-run ceiling correctly.
- **Emit exactly ONE authoritative config/customers/<slug>.yaml from materialize; DB rows come from loadTemplate reading it.** — VERIFIED: diagnose.ts:58-60 hard-codes resolve(`config/customers/${slug}.yaml`) and loadTemplate()s it before reading DB rows — so the proof path requires the YAML to exist with ZERO diagnose.ts change. P1's double-write (upsert + separate YAML re-read by loadAllTemplates) is a two-sources-of-truth drift hazard flagged by all reviews. Single write path (active -> emit YAML -> loadTemplate upserts) eliminates drift.
- **Template edits create a NEW draft version; active/reviewed rows are immutable. At-most-one-active-per-industry via a partial unique index, NOT an 'archived' status value.** — P2's in-place updateIndustryTemplate(questions?) breaks the append-only history both P2 and P3 rely on for rollback. P3's 'archived' status requires widening the status CHECK and auditing every TS status union/exhaustive switch (unverified risk). A partial unique index WHERE status='active' on the plain industry_template table is race-free and adds no enum value; activating demotes the prior active to 'reviewed' in the same transaction.
- **Enforce a HARD core-tier cap deterministically at generation time (<=20-25% and an absolute per-language max); never LLM-assign tiers.** — All three reviews flagged that decision/comparison/alternative wedge intents across 14-18 languages going to core (weekly N=5) is the dominant §11 operating cost and can immediately trip emora.yaml's $10/wk cap. Deterministic densityMap with a hard cap keeps tiering reproducible/testable and core a minority. Paraphrase siblings default to secondary (not all longtail/monthly), preserving the §7#1 monitoring goal.
- **intent_type/phrasingGroupId provenance lives ONLY in industry_template.questions JSONB; stripped to the 4 canonical columns on promote, accepted explicitly.** — The question table has only {text,language,funnel_stage,density_tier} (VERIFIED 0001). Adding columns would be a Phase 0 schema change the brief asks to avoid. All reviews require this loss be DOCUMENTED rather than silently stripped; the reviewer-facing JSONB retains full provenance for audit before promotion.

## Implementation Task List (T01–T21)

Dependency-ordered; same `parallelGroup` (pg) = disjoint files, may run concurrently. Machine-readable: `phase1-tasks.json`.

| id | pg | dependsOn | title |
|----|----|-----------|-------|
| T01 | 1 | — | Scaffold src/generate module + zod domain types |
| T02 | 1 | — | Add generateStructured() to GeminiAdapter (forced JSON) |
| T03 | 1 | — | URL fetcher seam with SSRF guard (read-only) |
| T04 | 1 | — | Migration 0006 part A: industry_template indexes + advisory cols |
| T05 | 1 | — | Migration 0006 part B: relax llm_call run_id/customer_id NOT NULL (.cjs) |
| T06 | 2 | T03 | Page extraction (readability heuristic) |
| T07 | 3 | T01,T02,T06 | Diagnosis prompt builder + BrandBrief inference |
| T08 | 3 | T01 | IntentMatrix builder (pure coverage contract) |
| T09 | 4 | T01,T08 | Density-tier mapping with hard core cap (pure) |
| T10 | 4 | T01,T02,T08,T09 | Native multilingual generation + per-language allocation |
| T11 | 4 | T01 | Dedup (normalized-exact + codepoint n-gram, CJK-safe) |
| T12 | 4 | T01 | Question guardrails (non-leading / neutral, pure) |
| T13 | 2 | T04 | Template repo methods (additive) |
| T14 | 2 | T05 | qgen budget preflight (global cap + per-run ceiling) |
| T15 | 5 | T07,T10,T11,T12,T13 | Assemble draft template + persist as industry_template draft |
| T16 | 6 | T15 | Materialize active template -> CustomerTemplate + YAML emit + upsert |
| T17 | 6 | T07,T14 | CLI: diagnose-url |
| T18 | 7 | T08,T09,T10,T11,T12,T15,T17 | CLI: gen-template rewrite (full pipeline -> draft) |
| T19 | 7 | T13,T16 | CLI: review-template lifecycle (draft->reviewed->active, version-on-edit) |
| T20 | 8 | T17,T18,T19 | Optional API routes (Fastify) |
| T21 | 8 | T16,T18,T19 | Integration + proof-path tests |
