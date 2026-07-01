# Phase 0 — Monitoring + SMR Engine — Canonical Design

> Source: `phase0-design` workflow (3 independent Opus proposals → 3 adversarial reviews → synthesis).
> Authoritative requirements: `SPEC.md` §5 (measurement), §7 (guardrails), §11 (cost), §13 (roadmap).
> Scope: Phase 0 = monitoring + SMR engine (free-diagnostic backend), surface **v1-a** (API-clean only).

## Stack decision

TypeScript on **Node.js 22 LTS** (ESM, strict tsconfig), **single deployable service**. Per the spec steer so the
Response/mention/SMR/Metrics domain types and Zod schemas are shared verbatim with the Phase 5 Next.js dashboard.
Single typed `src/` tree (NOT a monorepo — all three reviews flagged that as Phase-0 over-engineering).

**Libraries:**
- `@google/genai` — the ONLY real provider/judge today: `gemini-2.5-flash` (answers + judge default),
  `gemini-2.5-flash-lite` (cheap monitor), `gemini-2.5-pro` (judge escalation on parse-fail only).
- `pg` + `kysely` (typed SQL, no heavy ORM — Timescale DDL stays first-class raw SQL; §5.6 *is* the product).
- `node-pg-migrate` (plain SQL migrations = source of truth).
- `pg-boss` (Postgres-backed durable queue + cron on the SAME mandated Postgres). Chosen over `node-cron`
  (silently skips a missed weekly window → §5.6 violation) and over BullMQ+Redis (2nd SPOF + fan-in race).
  Gives durable cron, retries/backoff, dead-letter, transactional enqueue+cost-debit. `JobQueue` interface
  keeps a Temporal swap local.
- `zod` (single source of truth: judge JSON → Gemini responseSchema + runtime validation + TS types; env/config).
- `bottleneck` (per-provider RPM/concurrency), `fastify` (tiny diagnostic API, portable to Next.js routes),
  `pino` (logs + alert sink), `vitest` (tests), `js-yaml` (templates), `dotenv`.

**Deploy:** single Docker image (`node:22-slim`) + docker-compose with TWO services only — `app` and
`timescaledb` (`timescale/timescaledb-ha:pg16`). `docker compose up` + `npm run migrate` +
`npm run diagnose -- --customer emora` runs the whole loop TODAY with only `GEMINI_API_KEY`. Cloud later =
same image + managed Postgres-with-Timescale, no code change. Secrets via env behind a `SecretProvider` seam.

## End-to-end loop overview

1. **CONFIG (§5.5):** each customer = an industry template (brand+aliases, competitor-set+aliases,
   languages+priority weights, questions tagged `density_tier` core/secondary/longtail + language, budget caps).
   LLM-auto-generated → human-reviewed. Phase 0 seeds reviewed YAML (emora, kbeauty from §14). A Gemini
   template-generator drafts question+competitor sets for new industries, `status='draft'` until approved.
2. **TRIGGER:** baseline (§5.7: 10–20 Q, one-shot, free) on-demand via `npm run diagnose` / `POST /diagnose`.
   operating (§5.7: 50–200 Q, weekly) = durable pg-boss cron job per customer.
3. **PLAN (§5.3):** planner expands a cycle into Response work-units = `cartesian(due Q × models × langs ×
   sample_idx 0..N-1)` at temp 0.7. Density tiering decides which questions are due via a PERSISTED rotation
   cursor (not ISO-week-modulo → no starvation). Language weighting + budget shape-caps trim deterministically
   (lowest-priority lang × tier first). Baseline includes the customer's PRIORITY LANGUAGES (not English-only).
   `N_total` = work-units actually scheduled, SNAPSHOTTED on `run.n_total` BEFORE execution → frozen
   reproducible SMR denominator (§5.2).
4. **SAMPLE+JUDGE (per work-unit, 1 DB tx):** budget gate (rolling USD from `cost_daily` rollup, fail-CLOSED) →
   cache check (cross-cycle accidental-dup only; N intra-cycle samples NEVER collapsed) → `provider.generate()`
   (NOT_CONFIGURED is a typed value; planner already skipped unkeyed providers) → insert `response_raw` +
   `llm_call(generation)` → `extractMention`: LLM-as-judge (Gemini, FORCED JSON via responseSchema, temp 0) →
   Zod-validate → alias-normalized evidence verify → rule fallback on any failure → ABSTAIN if neither
   evidence-backs → insert `mention_judgment` + `llm_call(judge)`.
5. **GUARDRAILS (§7 code gates):** evidence-required gate downgrades `brand_mentioned=true` with no locatable
   alias-normalized span to abstain (excluded from numerator, still persisted); enforced in app code + same-table
   NOT NULL CHECK. Report DTO has NO free-text claims field → "only verifiable numbers" (§7#2) is structural.
   Pluggable `Gate{phase}`; publish gates pre-registered `PHASE_0_NOOP`.
6. **AGGREGATE (§5.2):** metrics computed by PLAIN SQL over a `current_judgment` view (`DISTINCT ON
   (response_raw_id) ORDER BY captured_at DESC` = latest-judgment-wins → re-judge never double-counts).
   `SMR = brand_hits / N_total(snapshot)`; `Visibility = Σ(1/brand_rank)/N_total`; SoV from brand+competitor
   occurrence counts; Priority Gap = low-brand-SMR + high-competitor questions; decomposition via GROUP BY.
   Every number traces to gate-passed judgment → evidence span → raw `answer_text` (§7#7). Baseline reports
   recompute synchronously via direct SQL. Single-hypertable `cost_daily` CAGG feeds §11 budget reads + alerts.
7. **RETENTION (§5.6/§12):** raw `answer_text` compressed after 30d, retained default 365d (audit note: evidence
   verifiability depends on raw retention); judgments + cost ledger retained longer. Gemini self-judge bias
   DISCLOSED in the report; judge contract allows swapping to another-vendor judge once a 2nd key arrives.

## Module tree

```
aeo-geo-engine/
  docker-compose.yml                 # app + timescaledb (timescale/timescaledb-ha:pg16) ONLY
  Dockerfile  package.json  tsconfig.json  .eslintrc.cjs  vitest.config.ts  .env.example
  config/customers/emora.yaml        # §5.5/§14.1 reviewed template
  config/customers/kbeauty.yaml      # §5.5/§14.2 reviewed template
  src/
    index.ts                         # entrypoint: migrate-check + start fastify + start pg-boss worker/cron
    config/env.ts template.schema.ts loadTemplate.ts
    domain/                          # PURE, no IO; shared with Phase 5 dashboard
      types.ts metrics.types.ts mention.schema.ts errors.ts rank.ts   # rank.ts = shared brand_rank semantics
    providers/
      types.ts                       # ProviderAdapter, Generate/JudgeResult unions, NOT_CONFIGURED as VALUE
      registry.ts pricing.ts gemini.ts stub.ts index.ts
    judge/ llmJudge.ts ruleFallback.ts extractMention.ts evidence.ts
    sampling/ plan.ts density.ts rotation.ts languageWeight.ts
    cost/ budget.ts cache.ts ledger.ts alerts.ts
    guardrails/ gate.ts evidenceRequiredGate.ts verifiableNumbersGate.ts publishStubs.ts
    pipeline/ runResponse.ts runCycle.ts
    metrics/ aggregate.ts report.ts
    scheduler/ queue.ts jobs.ts worker.ts
    db/ pool.ts kysely.ts schema.ts repo.ts migrate.ts
      migrations/0001_dimensions.sql 0002_hypertables.sql 0003_views_aggregates.sql 0004_compression_retention.sql
    api/server.ts                    # POST /diagnose, GET /smr/:runId, GET /healthz, GET /providers
    cli/diagnose.ts cli/genTemplate.ts
  test/ metrics.aggregate.test.ts rule-fallback.test.ts judge-parse.test.ts rank-agreement.test.ts
    budget.test.ts cache-samples.test.ts density-rotation.test.ts gemini.integration.test.ts
```

## Data model (canonical DDL)

```sql
-- PostgreSQL 16 + TimescaleDB. node-pg-migrate plain SQL. Append-only raw/judgment/cost ledger; ALL
-- metrics derived by plain SQL over a latest-judgment view (no hand-maintained SMR counters).
-- RESOLVED BLOCKERS: (a) NO CAGG joins two hypertables; (b) hypertable UNIQUE indexes must include the
-- partition column -> idempotency/cache in PLAIN tables; (c) latest-judgment-wins via DISTINCT ON view;
-- (d) denormalize judgment so SMR aggregates single-table.

-- ===== 0001_dimensions.sql : plain relational tables =====
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE customer (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE brand (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customer(id), name text NOT NULL, aliases text[] NOT NULL DEFAULT '{}');
CREATE TABLE competitor (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customer(id), name text NOT NULL, aliases text[] NOT NULL DEFAULT '{}');
CREATE TABLE question (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customer(id), text text NOT NULL, language text NOT NULL, funnel_stage text, density_tier text NOT NULL CHECK (density_tier IN ('core','secondary','longtail')), active boolean NOT NULL DEFAULT true, UNIQUE (customer_id, text, language));
CREATE TABLE model (id text PRIMARY KEY, provider text NOT NULL, is_cheap_monitor boolean NOT NULL DEFAULT false, is_judge boolean NOT NULL DEFAULT false, input_usd_per_mtok numeric NOT NULL DEFAULT 0, output_usd_per_mtok numeric NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE budget (customer_id uuid PRIMARY KEY REFERENCES customer(id), max_models int NOT NULL DEFAULT 1, max_samples int NOT NULL DEFAULT 5, max_languages int NOT NULL DEFAULT 14, weekly_usd_cap numeric NOT NULL DEFAULT 50, monthly_usd_cap numeric NOT NULL DEFAULT 150);
CREATE TABLE customer_language (customer_id uuid NOT NULL REFERENCES customer(id), language text NOT NULL, weight numeric NOT NULL DEFAULT 1.0, PRIMARY KEY (customer_id, language));
CREATE TABLE industry_template (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), industry text NOT NULL, version int NOT NULL DEFAULT 1, status text NOT NULL CHECK (status IN ('draft','reviewed','active')) DEFAULT 'draft', questions jsonb NOT NULL, competitors jsonb NOT NULL, reviewed_by text, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE run (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customer(id), kind text NOT NULL CHECK (kind IN ('baseline','operating')), status text NOT NULL CHECK (status IN ('planned','running','completed','failed','over_budget')) DEFAULT 'planned', n_samples int NOT NULL, temperature numeric NOT NULL DEFAULT 0.7, n_total int, planned_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz);
CREATE TABLE rotation_state (customer_id uuid NOT NULL REFERENCES customer(id), density_tier text NOT NULL, last_cycle_index int NOT NULL DEFAULT 0, PRIMARY KEY (customer_id, density_tier));
-- idempotency + cache as PLAIN tables (hypertable unique index cannot omit partition col):
CREATE TABLE work_unit (run_id uuid NOT NULL REFERENCES run(id), question_id uuid NOT NULL, model_id text NOT NULL, language text NOT NULL, sample_idx int NOT NULL, status text NOT NULL CHECK (status IN ('pending','done','skipped','error')) DEFAULT 'pending', response_raw_id uuid, PRIMARY KEY (run_id, question_id, model_id, language, sample_idx));
CREATE TABLE response_cache (request_hash text PRIMARY KEY, answer_text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- ===== 0002_hypertables.sql : time-series =====
CREATE TABLE response_raw (captured_at timestamptz NOT NULL DEFAULT now(), id uuid NOT NULL DEFAULT gen_random_uuid(), run_id uuid NOT NULL, customer_id uuid NOT NULL, question_id uuid NOT NULL, model_id text NOT NULL, language text NOT NULL, sample_idx int NOT NULL, temperature numeric NOT NULL, request_hash text NOT NULL, prompt_version text NOT NULL, answer_text text, provider_meta jsonb, status text NOT NULL CHECK (status IN ('ok','not_configured','error','cached')), PRIMARY KEY (captured_at, id));
SELECT create_hypertable('response_raw','captured_at', chunk_time_interval => INTERVAL '7 days');
CREATE INDEX ix_resp_customer_time ON response_raw (customer_id, captured_at DESC);
CREATE INDEX ix_resp_run ON response_raw (run_id);
CREATE INDEX ix_resp_dims ON response_raw (question_id, model_id, language, captured_at DESC);
-- mention_judgment DENORMALIZES status+coords so SMR aggregates SINGLE-TABLE (no two-hypertable CAGG/JOIN):
CREATE TABLE mention_judgment (captured_at timestamptz NOT NULL DEFAULT now(), id uuid NOT NULL DEFAULT gen_random_uuid(), response_raw_id uuid NOT NULL, run_id uuid NOT NULL, customer_id uuid NOT NULL, question_id uuid NOT NULL, model_id text NOT NULL, language text NOT NULL, response_status text NOT NULL, brand_mentioned boolean NOT NULL, brand_rank int, sentiment text CHECK (sentiment IN ('positive','neutral','negative')), competitors_found jsonb NOT NULL DEFAULT '[]', evidence_quote text, evidence_start int, evidence_end int, provenance text NOT NULL CHECK (provenance IN ('judge','fallback','abstain')), judge_model text, judge_raw jsonb, guardrail_status text NOT NULL DEFAULT 'pass' CHECK (guardrail_status IN ('pass','downgraded_abstain')), PRIMARY KEY (captured_at, id), CONSTRAINT mention_evidence_chk CHECK (brand_mentioned = false OR evidence_quote IS NOT NULL));
SELECT create_hypertable('mention_judgment','captured_at', chunk_time_interval => INTERVAL '7 days');
CREATE INDEX ix_mj_response ON mention_judgment (response_raw_id, captured_at DESC);
CREATE INDEX ix_mj_run ON mention_judgment (run_id);
CREATE INDEX ix_mj_decomp ON mention_judgment (customer_id, model_id, language, question_id, captured_at DESC);
CREATE TABLE llm_call (ts timestamptz NOT NULL DEFAULT now(), id uuid NOT NULL DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, run_id uuid NOT NULL, purpose text NOT NULL CHECK (purpose IN ('generation','judge')), provider text NOT NULL, model_id text NOT NULL, input_tokens int NOT NULL DEFAULT 0, output_tokens int NOT NULL DEFAULT 0, usd numeric NOT NULL DEFAULT 0, cache_hit boolean NOT NULL DEFAULT false, response_raw_id uuid, PRIMARY KEY (ts, id));
SELECT create_hypertable('llm_call','ts', chunk_time_interval => INTERVAL '7 days');
CREATE INDEX ix_cost_customer_time ON llm_call (customer_id, ts DESC);

-- ===== 0003_views_aggregates.sql =====
CREATE VIEW current_judgment AS SELECT DISTINCT ON (response_raw_id) * FROM mention_judgment ORDER BY response_raw_id, captured_at DESC;
CREATE VIEW run_smr_overall AS SELECT cj.run_id, cj.customer_id, count(*) FILTER (WHERE cj.response_status='ok' AND cj.guardrail_status='pass') AS judged_ok, count(*) FILTER (WHERE cj.brand_mentioned AND cj.guardrail_status='pass') AS brand_hits, sum(1.0/NULLIF(cj.brand_rank,0)) FILTER (WHERE cj.brand_mentioned AND cj.guardrail_status='pass') AS inv_rank_sum FROM current_judgment cj GROUP BY cj.run_id, cj.customer_id;
-- aggregate.ts joins run_smr_overall to run.n_total: SMR=brand_hits/n_total, Visibility=inv_rank_sum/n_total.
CREATE MATERIALIZED VIEW cost_daily WITH (timescaledb.continuous) AS SELECT time_bucket('1 day', ts) AS day, customer_id, sum(usd) AS usd, count(*) AS calls, count(*) FILTER (WHERE cache_hit) AS cache_hits FROM llm_call GROUP BY day, customer_id;
SELECT add_continuous_aggregate_policy('cost_daily', start_offset => INTERVAL '35 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour');

-- ===== 0004_compression_retention.sql (§5.6/§12) =====
ALTER TABLE response_raw SET (timescaledb.compress, timescaledb.compress_segmentby='customer_id');
SELECT add_compression_policy('response_raw', INTERVAL '30 days');
SELECT add_retention_policy('response_raw', INTERVAL '365 days');
ALTER TABLE mention_judgment SET (timescaledb.compress, timescaledb.compress_segmentby='customer_id');
SELECT add_compression_policy('mention_judgment', INTERVAL '90 days');
```

## Provider adapter contract

See the synthesized `src/providers/types.ts` / `gemini.ts` / `stub.ts` sketch — the ONE seam v1-b SERP/scrape
surfaces slot into. `NOT_CONFIGURED` is a typed RETURNED value (deterministic planner skip, no try/catch control
flow); adapter returns `AdapterUsage{usd}` so §11 metering happens where tokens are known; judge is a SEPARATE
optional capability; `Modality` + capability flags anticipate v1-b structured (SERP/AI-Overview) results.
`buildRegistry()` = real Gemini + `makeStubAdapter` for openai/anthropic/perplexity/grok/mistral/deepseek/llama-groq.
Adding a v1-b surface = new class implementing `ProviderAdapter` with `modality:'serp'|'scrape'`; sampler/judge/metrics unchanged.

## Judge contract (§5.4)

`mention.schema.ts` `JudgeVerdict` Zod object is the SINGLE source of truth (→ Gemini responseSchema → TS type):
`{ brand_mentioned, brand_rank|null, sentiment, competitors_found[{name,rank}], evidence }`.

**brand_rank semantics (PINNED, identical in judge prompt AND fallback — `domain/rank.ts`):** rank = 1-based
ordinal of the entity's FIRST textual occurrence among {brand} ∪ {tracked competitors} by character offset.
NOT "all named entities" (the fallback cannot see untracked entities). `rank-agreement.test.ts` asserts judge and
fallback produce IDENTICAL ranks so `Visibility = Σ(1/rank)/N` is provenance-independent.

**`extractMention` pipeline:** STEP 1 LLM-as-judge (Gemini cheap model, FORCED JSON, temp 0; escalate to
`gemini-2.5-pro` once on PARSE_FAILED). STEP 2 evidence verification — alias + NFC-normalized matching (NOT strict
verbatim) → `{quote,start,end}`; `brand_mentioned` but no locatable span → ungrounded → fall through. STEP 3 rule
fallback (deterministic, NFC+lower+diacritic-fold; rank via `domain/rank.ts`; sentiment='neutral' never fabricated;
real evidence window). STEP 4 abstain (counts in N_total, never as a hit). Persists `judge_raw`, `provenance`,
`judge_model`. Re-judging APPENDS a row; metrics read `current_judgment` (latest) → history preserved, never
double-counted. Self-judge bias DISCLOSED in report.

## Sampling design (§5.3)

Pure, testable, provider-free logic. WORK-UNIT = `{run_id, question_id, model_id, language, sample_idx, prompt,
request_hash}`; matrix = `cartesian(due Q × selected models × selected langs × sampleIdx 0..N-1)` @ temp 0.7.
Density tiering with PERSISTED rotation cursor (`rotation_state`): core→every cycle full N=5; secondary→biweekly
N=3 (rotated slice); longtail→monthly N=3 cheap-only. Language weighting after tier, clamped by `budget.max_languages`,
deterministic lowest-first trim. Cheap model default. Baseline (10–20 Q, one-shot, N=3, INCLUDES priority languages,
synchronous direct-SQL report) vs operating (50–200 Q, weekly, full tiering) — SAME code path. `N_total` = scheduled
work-units, snapshotted on `run.n_total` BEFORE execution. `request_hash = sha256(model|lang|normPrompt|temp|promptVersion)`
— does NOT include sample_idx; the N intra-cycle samples are N distinct `work_unit` rows, NEVER cache-collapsed.

## Guardrail design (§7 as code gates)

Pluggable `Gate{name, phase:'measurement'|'publish', apply}` + `runGates()` fold. **Phase 0 measurement gates:**
(1) `evidenceRequiredGate` (§7#7/#2, write-time) — `brand_mentioned===true` + no alias-normalized span →
`downgraded_abstain` (forced false, excluded from numerator, still persisted); defense-in-depth same-table CHECK.
Cross-table "evidence ⊂ answer_text" check is APP code (`evidence.ts`), not a DB CHECK (a CHECK can't reference
another table). (2) `verifiableNumbersGate` (§7#2, report-time) — report DTO permits ONLY
`{metric,value,n_total,evidence_refs[]}`, NO free-text claims field → narrative superlatives structurally impossible;
report recomputes from raw `current_judgment` rows. **Phase 2-3 seam:** `publishStubs.ts` pre-registers
phrasingVariation(§7#1)/claimVerification(§7#7)/disclosure(§7#6) `phase:'publish'` returning `PHASE_0_NOOP`.

## Cost design (§11)

(1) CAPS: shape caps (max_models/samples/languages) at matrix-build time + weekly/monthly USD caps; `preflight()`
rejects → `run.status='over_budget'`; per-call `assertWithinCap()` reads rolling spend from `cost_daily` CAGG (NOT a
hot-path raw SUM); FAIL-CLOSED on missing cost data. (2) CACHING: `request_hash` dedup for cross-cycle accidental dups
within short TTL only; intra-cycle N samples NEVER collapsed; cache hits write `llm_call` usd=0,cache_hit=true.
(3) CHEAP MODEL: generation default `gemini-2.5-flash-lite` (operating)/`gemini-2.5-flash` (baseline); judge default
cheap, escalate to pro ONLY on parse failure. (4) MONITORING+ALERTING: every generation+judge call writes `llm_call`;
`cost_daily` CAGG drives dashboards; `checkThreshold()` → pluggable AlertSink (pino now, webhook later).
(5) DENSITY TIERING = structural spend lever. Only Gemini keyed → real spend today is Gemini-only and tiny.

## Key decisions (resolved cross-check disagreements)

1. Single Node/TS service, no Redis, no monorepo; durable scheduling via pg-boss on the mandated Postgres.
2. NO continuous aggregate joins two hypertables; SMR/SoV/Visibility = plain SQL over `current_judgment`;
   `mention_judgment` denormalized so aggregation is single-table. (Verified FATAL: only ONE hypertable per CAGG.)
3. Idempotency (`work_unit`) and cache (`response_cache`) in PLAIN tables, not hypertables. (Hypertable UNIQUE index
   must include the partition column.)
4. Latest-judgment-wins via `DISTINCT ON` in `current_judgment`; re-judge append-only. (count(*) SMR double-counts otherwise.)
5. SMR denominator = `run.n_total` snapshot; error/abstain stay in denominator, never inflate numerator. (§5.2)
6. `brand_rank` = ordinal among {brand}∪{tracked competitors} by first offset, one shared module for judge+fallback,
   with rank-agreement test. (Visibility must be provenance-independent.)
7. Four-state judge outcome (judge/fallback/abstain) with alias/NFC-normalized evidence verification, NOT strict verbatim.
   (Strict verbatim undercounts transliterated names in EMORA ja/ko + K-Beauty id/th/vi — the wedge markets.)
8. USD budget caps (weekly/monthly) from `cost_daily` rollup, fail-closed; judge cheap-default + pro escalation on parse fail only.
9. Evidence cross-table check in app code (+ same-table NOT NULL CHECK), not a cross-table DB CHECK; report DTO has no claims field.
10. Baseline is multilingual (priority languages), not English-only; baseline report computed synchronously via direct SQL.
11. Adapter returns NOT_CONFIGURED as a typed VALUE + `AdapterUsage{usd}`; judge a separate optional capability;
    Modality/capability flags for v1-b.

## Implementation task list (T01–T15)

Dependency-ordered. Tasks with the same `parallelGroup` touch disjoint files and may run concurrently.
See `phase0-tasks.json` for the machine-readable spec (files, dependsOn, acceptanceCriteria) driving the build workflow.

| id | title | dependsOn | files |
|----|-------|-----------|-------|
| T01 | Scaffold (package.json, tsconfig, lint, docker-compose, Dockerfile, env) | — | root + src/config/env.ts |
| T02 | DB migrations (dimensions/hypertables/views/compression) + migrate.ts | T01 | src/db/migrations/*, migrate.ts |
| T03 | Domain types, mention Zod schema, shared brand_rank module | T01 | src/domain/* |
| T04 | Provider adapter contract, registry, pricing, Gemini real, stubs | T03 | src/providers/* |
| T05 | Judge orchestration (LLM judge, evidence, rule fallback, extractMention) | T03,T04 | src/judge/* |
| T06 | Sampling (density, rotation, language weight, plan, cache) | T03 | src/sampling/*, src/cost/cache.ts |
| T07 | Cost (budget USD caps fail-closed, ledger, alerts) | T02,T03 | src/cost/{budget,ledger,alerts}.ts |
| T08 | Guardrail gate layer (interface, evidence-required, verifiable-numbers, publish stubs) | T03 | src/guardrails/* |
| T09 | DB repositories (Kysely): runs, responses, judgments, cost, config, rotation | T02,T03 | src/db/{pool,kysely,schema,repo}.ts |
| T10 | Config (template Zod schema, YAML loader, emora & kbeauty seeds) | T09 | src/config/*, config/customers/* |
| T11 | Metrics aggregation + report assembler | T08,T09 | src/metrics/* |
| T12 | Scheduler (JobQueue interface + pg-boss, jobs, worker cron + boot catch-up) | T07,T09 | src/scheduler/* |
| T13 | Pipeline (runResponse 1 tx, runCycle plan→fan-out→aggregate) | T05,T06,T07,T08,T09,T11,T12 | src/pipeline/* |
| T14 | CLI + Fastify API + entrypoint | T13,T10 | src/cli/*, src/api/server.ts, src/index.ts |
| T15 | Tests (metrics, fallback, judge-parse, rank-agreement, budget, cache-samples, density, Gemini integration) | T11,T05,T06,T07,T04 | test/* |

**Build waves (topological):**
- Wave 1: T01
- Wave 2: T02, T03
- Wave 3: T04, T06, T07, T08, T09
- Wave 4: T05, T10, T11, T12
- Wave 5: T13, T15
- Wave 6: T14
