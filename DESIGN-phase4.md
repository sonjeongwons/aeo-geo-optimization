# Phase 4 — Surface v1-b Monitoring Expansion — Canonical Design

> Source: `phase4-design` workflow (3 Opus proposals → adversarial cross-check → synthesis). Builds on verified Phase 0–3.
> NOTE: the synthesis under-filled the prose fields; this doc captures the scope + invariants + the (complete, concrete)
> task list T01–T17. Authoritative: `SPEC.md` §4 (surfaces/tiers, v1-a/v1-b), §5 (measurement), §11 (cost), §12 (compliance).

## Scope

Add **surface v1-b** monitoring surfaces to the existing Phase 0 loop:
- **Extension 1 (model/path-distinct):** Copilot, Meta AI (Llama), Mistral Le Chat, DeepSeek.
- **Extension 2 (market):** Line (JP/TW/TH), Kakao (KR).
- **No-API (SERP):** Google AI Overviews, Naver AI.

These register into the EXISTING Phase 0 planner → runCycle → runResponse → judge → SMR aggregation and produce the same
§5.1 `Response`+`mention` atoms as v1-a API surfaces. A SERP/AIO answer is just `answer_text` (+ citations) the judge consumes.

## Hard invariants (from the design + task acceptance criteria)

- **Stubs until keys.** No SERP-API key, no scraping/RPA infra → every v1-b surface is a typed `NOT_CONFIGURED` stub today
  (mirrors Phase 0 `providers/stub.ts` + Phase 3 connector stubs). The REAL, unit-testable work: the serp/scrape surface
  adapter abstraction (extends the Phase 0 `ProviderAdapter` / `Modality` `api|serp|scrape` seam), the SERP-API client seam,
  the RPA-runner seam, the citation/answer **parser contracts** (fixtures), surface registry + tiering, and monitoring-loop
  integration. No live network in tests.
- **§12 compliance:** Google AI Overviews + Naver are resolved via an **official SERP API ONLY** — they are NOT
  RpaRunner-constructible (gray-zone raw scraping disabled by construction). Encoded in `surfaces/compliance.ts` manifest.
- **Prose/citation separation:** parsers must put ONLY the answer prose into `answer_text`; citations are a separate
  structured list (never concatenated into `answer_text`), so the judge sees clean prose and brand attribution is faithful.
- **Additive on the measurement core:** new surfaces measure through the SAME `runResponse`/judge/SMR path — `mention_judgment`
  and the SMR aggregation are untouched; e2e test proves a surface answer reaches `mention_judgment` with NO core edits.
- **Modality sampling clamp:** non-chat (serp/scrape) surfaces use `nSamples=1` (one work-unit; deterministic, not temp-0.7
  probabilistic sampling). Selection drops not-ready surfaces and scrape surfaces from the baseline path.
- **§11 cost:** SERP calls metered via the existing `llm_call` ledger (`surfacePricing.ts`); density tiering applies.
- **Native-review flagging** for market-language surfaces (Line JP/TW/TH, Kakao KR, Naver KR); SMR identical whether the
  flag is on or off (it is advisory metadata, not a measurement change).
- New migration **0012** (cols + surface seed + queues); obeys Phase 0 TimescaleDB rules; `mention_judgment` untouched.

## Implementation tasks (T01–T17)

Dependency-level waves (same `parallelGroup` = disjoint files). Machine-readable: `phase4-tasks.json`.

| id | title | dependsOn | key files |
|----|-------|-----------|-----------|
| T01 | Surface types (Citation/SurfaceAnswer/SurfaceParser) | — | src/surfaces/types.ts |
| T04 | Migration 0012 (cols + seed + queues) | — | src/db/migrations/0012_phase4_surfaces.sql |
| T02 | Compliance manifest + invariants (AIO/Naver official_serp) | T01 | src/surfaces/compliance.ts |
| T03 | Surface pricing (surfaceUsdPerCall) | T01 | src/surfaces/surfacePricing.ts |
| T05 | schema.ts + repo.ts (modality map; inserts) | T04 | src/db/{schema,repo}.ts |
| T06 | SERP + RPA client seams (NotConfigured stubs) | T01 | src/surfaces/serp/serpClient.ts, scrape/rpaRunner.ts |
| T08 | SERP parsers (AI Overviews, Naver; prose-only) | T01 | src/surfaces/serp/parse/* |
| T09 | Scrape parsers (Copilot, Meta, Line, Kakao) | T01 | src/surfaces/scrape/parse/* |
| T07 | SurfaceAdapter (NO_ANSWER error; judge NOT_CONFIGURED) | T01,T03,T06 | src/surfaces/SurfaceAdapter.ts |
| T13 | Sample clamp (non-chat nSamples=1) | T05 | src/sampling/plan.ts |
| T14 | Native-review flag + hook | T05,T02 | src/surfaces/nativeReview.ts, src/pipeline/runCycle.ts |
| T10 | Surface adapters (AIO/Naver SerpClient-only; armed scrape) | T07,T08,T09,T02 | src/surfaces/{serp,scrape}/adapters/* |
| T15 | Preflight + cache carry-forward (surface estimate) | T13 | src/pipeline/runCycle.ts, src/cost/budget.ts |
| T11 | Surface registry → buildRegistry (stubs) | T10 | src/surfaces/registry.ts, src/providers/registry.ts |
| T12 | Surface selection (drop not-ready/scrape-baseline) | T05,T11 | src/surfaces/surfaceSelection.ts |
| T16 | Wire CLI + worker (selectEligibleModels; limiters per surfaceId) | T12,T11 | src/cli/{diagnose,diagnoseUrl}.ts, src/scheduler/worker.ts |
| T17 | Tests (parsers/guard/selection/N=1/e2e) | T07–T14 | test/surfaces/* |

**Waves:** W1[T01,T04] · W2[T02,T03,T05,T06,T08,T09] · W3[T07,T13,T14] · W4[T10,T15] · W5[T11] · W6[T12] · W7[T16,T17].
