# AEO/GEO Engine

Off-site AEO/GEO service: raises a brand's mention/recommendation across 10+ AI answer engines **without touching the
customer's site** (§0 off-site-only). Built phase by phase per `SPEC.md` §13, each phase design→implement→adversarially
verify→fix→**live-validate** (real TimescaleDB + real Gemini).

| Phase | What | Design doc | Status |
|---|---|---|---|
| **0** | Monitoring + SMR engine (free-diagnostic backend), surface v1-a | [DESIGN.md](DESIGN.md) | ✅ live-validated |
| **1** | Target-question auto-generator (URL/industry → 50–200 Q × funnel × phrasing × lang) + industry-template store | [DESIGN-phase1.md](DESIGN-phase1.md) | ✅ live-validated |
| **2** | Offsite content variant generator (format × 18 lang) + real §7 guardrail gates + JSON-LD | [DESIGN-phase2.md](DESIGN-phase2.md) | ✅ live-validated |
| **3** | Deploy connector layer (owned-net real + PR-wire/directory/social stubs) + publish tracking | [DESIGN-phase3.md](DESIGN-phase3.md) | ✅ live-validated |
| **4** | Surface v1-b monitoring (Copilot/Meta/Mistral/DeepSeek/Line/Kakao/AI-Overviews/Naver via SERP-API + RPA) | [DESIGN-phase4.md](DESIGN-phase4.md) | ✅ built (surfaces stubbed) |
| **5** | Customer dashboard (Next.js, gpto.kr-style) + weekly reports + approval workflow + billing | [DESIGN-phase5.md](DESIGN-phase5.md) | ✅ built + verified |

The **full §13 Phase 0–5 build is complete.** Surface **v1-a** = API-clean answer engines. **Google Gemini is the only
real provider/judge today**; all other providers + Phase 3 external channels + Phase 4 v1-b surfaces are clearly-marked
`NOT_CONFIGURED` stubs until keys arrive, so the whole engine runs end-to-end on Gemini alone. Test suite: **1851 passing**
(engine) + apps/web `tsc`/`next build` clean; **18 migrations** applied live; each phase design→implement→adversarially
verify→fix→live-validate.

See [`SPEC.md`](SPEC.md) for the product spec (§5 measurement, §6 content, §7 guardrails [hard code gates], §8 channels,
§11 cost). Each `DESIGN-phase*.md` has the locked architecture + task breakdown for that phase.

## Phase 0 — Monitoring + SMR

The monitoring + SMR measurement engine (the free-diagnostic backend), surface **v1-a** (API-clean answer engines).
Measures how often a brand is mentioned/recommended across LLM answer engines, with no changes to the customer's site.

## What Phase 0 does

For a customer (industry template of brand + competitors + questions × languages), it runs the measurement loop:

```
plan (density-tiered sampling, §5.3)
  → for each work-unit (question × model × language × sample @ temp 0.7):
      budget gate (§11, fail-closed) → cache check (intra-cycle samples never collapsed)
      → Gemini generate → persist raw → LLM-as-judge (forced JSON) + rule fallback + abstain (§5.4)
      → guardrail gates (§7 evidence-required) → persist judgment (append-only)
  → aggregate: SMR, SoV, Visibility, Priority Gap (§5.2), decomposed by model/language/question
  → report (only verifiable numbers + evidence refs, self-judge-bias disclosed)
```

- **Baseline** (§5.7): 10–20 questions, one-shot, free — the diagnostic funnel entry.
- **Operating** (§5.7): 50–200 questions, weekly durable cron (pg-boss), with boot catch-up.

## Stack

TypeScript / Node 22 (ESM) · PostgreSQL + **TimescaleDB** (time-series retention §5.6) · Kysely + node-pg-migrate ·
pg-boss (durable cron on the same Postgres, no Redis) · zod (judge JSON ↔ Gemini responseSchema) · Fastify · pino.

**Providers:** Google **Gemini is the only real adapter** today (`gemini-2.5-flash` answers+judge, `flash-lite`
cheap monitor, `pro` judge-escalation only). OpenAI / Anthropic / Perplexity / xAI-Grok / Mistral / DeepSeek /
Llama(Groq) are clearly-marked stubs returning `NOT_CONFIGURED` until keys arrive — the planner skips them, so the
engine runs end-to-end on Gemini alone.

## Run it

Requires Docker (for TimescaleDB) and a `GEMINI_API_KEY`.

```bash
cp .env.example .env            # set GEMINI_API_KEY and DATABASE_URL
docker compose up -d timescaledb
npm install
npm run migrate                 # applies all migrations (TimescaleDB CAGG/compression run non-transactionally via .cjs)

# Phase 0 — monitoring + SMR
npm run diagnose -- --customer emora               # full baseline loop, prints the SMR report JSON
npm run dev                                        # Fastify API + durable worker: POST /diagnose  GET /smr/:runId  GET /providers  GET /healthz

# Phase 1 — target-question generator + template store
npm run gen-template -- --industry ai-companion --total 50   # Gemini drafts Q+competitor set → industry_template (status=draft, §5.5)
npm run diagnose-url -- --url https://example.com            # off-site read-only URL diagnosis → BrandBrief (SSRF-guarded)
npm run review-template -- --id <uuid> --action reviewed --by <email>   # then --action active (two-step §5.5 promotion)

# Phase 2 — offsite content generator + §7 gates + JSON-LD
npm run gen-content -- --customer <uuid> --industry ai-companion --total 12   # generate → gate (§7) → queue passed for Phase 3
npm run review-claims -- --set <content-set-uuid> --by <email>               # human sign-off on needs_human claims, then re-gate
npm run queue-content -- --set <content-set-uuid>                            # queue gate-passed assets for Phase 3 deploy
```

Live-validation harness (DB-gated, no Gemini key needed): `npm run verify:live` (Phase 0 round-trip),
`npm run verify:live:p1` (Phase 1 template lifecycle). Seeded customers: `config/customers/emora.yaml`,
`config/customers/kbeauty.yaml` (from SPEC §14).

## Verification status

| Check | Status |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npx vitest run` | ✅ **1196 passed / 5 skipped** (Gemini integration tests gated on `GEMINI_API_KEY`) |
| Adversarial spec/integration audit (Opus, per phase) | ✅ Phase 0: 21 findings · Phase 1: 8 · Phase 2: 11 — all found+fixed+re-verified |
| **Live migrations vs real TimescaleDB** | ✅ all 10 migrations apply (hypertables + `cost_daily` CAGG + compression/retention + content tables; non-transactional `.cjs` for policy DDL) |
| **Live DB round-trips** (`npm run verify:live[:p1]`) | ✅ seed idempotency, jsonb arrays, latest-judgment-wins, template lifecycle (version + atomic demote/activate + partial-unique active) |
| **Gemini end-to-end** | ✅ Phase 0 `diagnose` (real SMR, EMORA before-baseline≈0), Phase 1 `gen-template` (42-Q draft), Phase 2 `gen-content` (11 assets → §7 gates → needs_human routing) |

Everything is **verified live** against real TimescaleDB + real Gemini. Live runs caught **~11 real bugs unit tests
missed** — all at real-network / real-LLM / real-DB boundaries mocks couldn't exercise (e.g. `brand`/`competitor`
missing the `ON CONFLICT` unique index → 42P10; `zodToGeminiSchema` not unwrapping `ZodDefault`/handling `ZodLiteral`
→ Gemini returned strings/`{}` for arrays/discriminators; SSRF IP-pinning non-functional under real DNS). Standing
practice: live-close every phase, and add un-mocked coverage for any seam that stubs network/DB/LLM.

## Layout

`src/domain` pure types + judge schema + shared brand_rank · `src/providers` adapter contract + Gemini + stubs ·
`src/judge` LLM-judge + evidence + rule fallback · `src/sampling` density/rotation/plan · `src/cost` budget/cache/
ledger/alerts · `src/guardrails` gate layer · `src/metrics` aggregation + report · `src/scheduler` pg-boss queue/
worker · `src/pipeline` runResponse/runCycle · `src/db` migrations + Kysely repo · `src/api` + `src/cli` entrypoints.
