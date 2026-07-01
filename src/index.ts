/**
 * src/index.ts
 *
 * Main entrypoint for the AEO/GEO Phase 0 engine.
 *
 * Startup sequence:
 *   1. Load and validate environment (env.ts — fail fast on missing DATABASE_URL).
 *   2. Start Fastify API server.
 *   3. Start pg-boss durable worker (registers handlers + weekly cron + boot catch-up).
 *
 * Shutdown: SIGTERM / SIGINT → graceful stop (drain in-flight jobs, close DB pool,
 * close Fastify).
 *
 * DESIGN.md: "index.ts: env check + start fastify + start pg-boss durable worker."
 */

import "./config/env.js"; // side-effect: load .env + fail fast on missing DATABASE_URL
import { env } from "./config/env.js";
import pino from "pino";
import { startServer } from "./api/server.js";
import { createJobQueue } from "./scheduler/queue.js";
import { startWorker } from "./scheduler/worker.js";
import {
  buildCyclePlanHandler,
  buildCycleAggregateHandler,
} from "./pipeline/runCycle.js";
import { runResponse } from "./pipeline/runResponse.js";
import { buildRegistry, resolveJudgeAdapter } from "./providers/registry.js";
import * as repo from "./db/repo.js";
import { Ledger } from "./cost/ledger.js";
import { evidenceRequiredGate } from "./guardrails/evidenceRequiredGate.js";
import type { RunCycleDeps } from "./pipeline/runCycle.js";
import type { ModelRef, CustomerLanguage, Budget, Question } from "./domain/types.js";
import type { CyclePlanPayload } from "./scheduler/jobs.js";
import type { ResponseRunPayload } from "./scheduler/jobs.js";
import { buildProviderLimiters } from "./scheduler/worker.js";
import type Bottleneck from "bottleneck";
import { getDb } from "./db/kysely.js";
import { createResponseCache } from "./cost/cache.js";
// Phase 4 — surface wiring helper
import { wireSurfaces } from "./surfaces/wireSurfaces.js";
// Phase 3 — deploy connector layer
import { makeOwnedNetConnector } from "./deploy/connectors/ownedNet.js";
import { prWireConnector } from "./deploy/connectors/prWire.js";
import { directoryConnector } from "./deploy/connectors/directory.js";
import { web2Connector } from "./deploy/connectors/web2.js";
import { socialConnector } from "./deploy/connectors/social.js";
import { entityConnector } from "./deploy/connectors/entity.js";
import { buildConnectorRegistry } from "./deploy/registry.js";
import { handlePublishDispatch } from "./deploy/dispatch.js";
import { publishUnit } from "./deploy/publishUnit.js";
import { handlePublishVerify } from "./deploy/verifyIndexing.js";

const log = pino({ name: "index", level: env.LOG_LEVEL });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info("AEO/GEO Phase 0 engine starting");

  // 1. Build provider registry (singleton)
  const registry = buildRegistry();
  const readiness = registry.readiness();
  log.info({ readiness }, "provider readiness");

  // 2. Start Fastify
  const app = await startServer(env.PORT);
  log.info({ port: env.PORT }, "Fastify API listening");

  // 3. Build pg-boss job queue
  const queue = createJobQueue(env.DATABASE_URL);
  await queue.start();
  log.info("pg-boss queue started");

  // 4. Build per-provider limiters (shared between worker and pipeline)
  const limiters = buildProviderLimiters();

  // 5. Build deps factory for cycle.plan (per-customer, per-cycle)
  async function depsFactory(payload: CyclePlanPayload): Promise<RunCycleDeps> {
    const { customerId } = payload;

    // Fetch customer slug for logging (we have customerId, need to look up slug via DB)
    const customerRow = await getDb()
      .selectFrom("customer")
      .select(["id", "slug"])
      .where("id", "=", customerId)
      .executeTakeFirst();
    const customerSlug = customerRow?.slug ?? customerId;

    const [brands, competitorRows, questionRows, langRows, budgetRow, allEnabledModels] =
      await Promise.all([
        repo.findBrandsByCustomer(customerId),
        repo.findCompetitorsByCustomer(customerId),
        repo.findActiveQuestions(customerId),
        repo.findCustomerLanguages(customerId),
        repo.findBudget(customerId),
        repo.findEnabledModels(),
      ]);

    if (brands.length === 0) throw new Error(`No brand for customer ${customerId}`);
    if (!budgetRow) throw new Error(`No budget for customer ${customerId}`);

    const brand = brands[0]!;
    const competitors = competitorRows.map((c) => ({ name: c.name, aliases: c.aliases }));
    const questions: Question[] = questionRows.map((q) => ({
      id: q.id,
      customerId,
      text: q.text,
      language: q.language,
      funnelStage: q.funnel_stage,
      densityTier: q.density_tier,
      active: true,
    }));
    const languages: CustomerLanguage[] = langRows.map((l) => ({
      customerId,
      language: l.language,
      weight: parseFloat(l.weight),
    }));
    const budget: Budget = {
      customerId,
      maxModels: budgetRow.max_models,
      maxSamples: budgetRow.max_samples,
      maxLanguages: budgetRow.max_languages,
      weeklyUsdCap: parseFloat(budgetRow.weekly_usd_cap),
      monthlyUsdCap: parseFloat(budgetRow.monthly_usd_cap),
    };

    const adapters = new Map(
      registry.all()
        .filter((a) => a.status === "ready")
        .map((a) => [a.provider, a]),
    );

    // Hi-end audit MUST #1: pluggable judge — uses JUDGE_PROVIDER when ready
    // (e.g. perplexity), else falls back to gemini. Makes a 2nd-engine key
    // actually substitute the judge (and the §5.4 disclosure true in code).
    const judgeAdapter = resolveJudgeAdapter(registry, env.JUDGE_PROVIDER);

    const readyProviders = new Set(adapters.keys());
    const chatModels: ModelRef[] = allEnabledModels
      .filter((m) => readyProviders.has(m.provider))
      .map((m) => ({
        id: m.id,
        provider: m.provider,
        modality: "chat" as const,
        capabilities: ["generate" as const, "judge" as const, "structured" as const],
        isCheapMonitor: m.is_cheap_monitor,
        isJudge: m.is_judge,
        inputUsdPerMtok: parseFloat(m.input_usd_per_mtok),
        outputUsdPerMtok: parseFloat(m.output_usd_per_mtok),
        enabled: true,
      }));

    // ICS-01: wire v1-b surface adapters so operating cycles measure surfaces too.
    // runKind comes from the payload (baseline | operating).
    const { surfaceModels, surfaceAdapters } = wireSurfaces({
      registryAdapters: registry.all(),
      runKind: payload.kind,
    });
    for (const [key, adapter] of surfaceAdapters) {
      adapters.set(key, adapter);
    }
    const models: ModelRef[] = [...chatModels, ...surfaceModels];

    const costReader = {
      getRollingSpendUsd: async (cid: string, windowDays: number): Promise<number | null> => {
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        return repo.sumCostSince(cid, since);
      },
    };

    const ledger = new Ledger({
      insertLlmCall: async (row) => {
        await repo.insertLlmCall({
          customerId: row.customerId,
          runId: row.runId,
          purpose: row.purpose,
          provider: row.provider,
          modelId: row.modelId,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          usd: row.usd,
          cacheHit: row.cacheHit,
          responseRawId: row.responseRawId,
        });
      },
    });

    const cacheFns = {
      findByHash: async (requestHash: string) => {
        const row = await repo.lookupResponseCache(requestHash);
        if (!row) return null;
        // Return the real created_at so TTL is computed from the actual insert time.
        return { answerText: row.answer_text, createdAt: row.created_at };
      },
      upsert: async (requestHash: string, answerText: string) => {
        await repo.insertResponseCache({ requestHash, answerText });
      },
    };

    return {
      queue,
      customerSlug,
      brand: { name: brand.name, aliases: brand.aliases },
      competitors,
      questions,
      models,
      languages,
      budget,
      adapters,
      judgeAdapter,
      costReader,
      ledger,
      cacheFns,
      gates: [evidenceRequiredGate],
      limiters,
    };
  }

  // 6. Build response.run handler for the worker
  async function responseRunWorkerHandler(
    payload: ResponseRunPayload,
    workerLimiters: Map<string, Bottleneck>,
  ): Promise<void> {
    // Fetch required context for runResponse
    const { customerId, runId, questionId, modelId, language, sampleIdx } = payload;

    const [brands, competitorRows, budgetRow, runRow, hasPriorCall] = await Promise.all([
      repo.findBrandsByCustomer(customerId),
      repo.findCompetitorsByCustomer(customerId),
      repo.findBudget(customerId),
      repo.findRun(runId),
      // Exclude the CURRENT run's own llm_call rows so that sample 0's freshly-written
      // row is not seen by sibling samples in the same run.  All samples of a
      // first-ever operating run must agree that isNewCustomer=true (§11 fix).
      repo.customerHasPriorLlmCall(customerId, runId),
    ]);

    if (brands.length === 0) throw new Error(`No brand for customer ${customerId}`);
    if (!budgetRow) throw new Error(`No budget for customer ${customerId}`);

    const brand = brands[0]!;
    const competitors = competitorRows.map((c) => ({ name: c.name, aliases: c.aliases }));
    const budget: Budget = {
      customerId,
      maxModels: budgetRow.max_models,
      maxSamples: budgetRow.max_samples,
      maxLanguages: budgetRow.max_languages,
      weeklyUsdCap: parseFloat(budgetRow.weekly_usd_cap),
      monthlyUsdCap: parseFloat(budgetRow.monthly_usd_cap),
    };

    // Find the adapter for this model
    const modelRow = (await repo.findEnabledModels()).find((m) => m.id === modelId);
    const adapter = modelRow ? registry.get(modelRow.provider) : undefined;
    if (!adapter) throw new Error(`No adapter for model ${modelId}`);

    // Hi-end audit MUST #1: pluggable judge (see depsFactory above).
    const judgeAdapter = resolveJudgeAdapter(registry, env.JUDGE_PROVIDER);

    const costReader = {
      getRollingSpendUsd: async (cid: string, windowDays: number): Promise<number | null> => {
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        return repo.sumCostSince(cid, since);
      },
    };

    const ledger = new Ledger({
      insertLlmCall: async (row) => {
        await repo.insertLlmCall({
          customerId: row.customerId,
          runId: row.runId,
          purpose: row.purpose,
          provider: row.provider,
          modelId: row.modelId,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          usd: row.usd,
          cacheHit: row.cacheHit,
          responseRawId: row.responseRawId,
        });
      },
    });

    // run.started_at is used to exclude intra-cycle cache entries: we only serve
    // cross-cycle hits from rows created BEFORE this run began (§5.3 / §11).
    const runStartedAt = runRow?.started_at ?? undefined;

    const cacheFns = {
      findByHash: async (requestHash: string, createdBefore?: Date) => {
        const row = await repo.lookupResponseCache(requestHash);
        if (!row) return null;
        // Intra-cycle isolation on async path: skip cache entries created during
        // this run (i.e. written by a sibling sample_idx for the same hash).
        const cutoff = createdBefore ?? runStartedAt;
        if (cutoff && row.created_at >= cutoff) return null;
        // Return the real created_at so TTL is computed from the actual insert time.
        return { answerText: row.answer_text, createdAt: row.created_at };
      },
      upsert: async (requestHash: string, answerText: string) => {
        await repo.insertResponseCache({ requestHash, answerText });
      },
    };

    const responseCache = createResponseCache(cacheFns);

    await runResponse(payload, {
      adapter,
      judgeAdapter,
      budget,
      // Compute isNewCustomer dynamically: only bypass fail-closed for the very
      // first call (no prior llm_call rows).  Returning customers must fail closed
      // when CAGG data is missing (§11).
      isNewCustomer: !hasPriorCall,
      costReader,
      ledger,
      cacheFns,
      responseCache,
      gates: [evidenceRequiredGate],
      brand: { name: brand.name, aliases: brand.aliases },
      competitors,
      limiters: workerLimiters,
    });
  }

  // 7. Build the Phase 3 connector registry (owned_net is the only 'ready' connector)
  const ownedNetConnector = makeOwnedNetConnector(
    env.OWNED_NET_OUT_DIR,
    env.OWNED_NET_HUB_BASE_URL,
    env.CUSTOMER_DOMAIN_BLOCKLIST,
  );
  const connectorRegistry = buildConnectorRegistry([
    ownedNetConnector,
    prWireConnector,
    directoryConnector,
    web2Connector,
    socialConnector,
    entityConnector,
  ]);

  // 8. Start the worker (with Phase 3 publish handlers injected)
  const stopWorker = await startWorker({
    queue,
    handlers: {
      cyclePlan: buildCyclePlanHandler(depsFactory),
      responseRun: responseRunWorkerHandler,
      cycleAggregate: buildCycleAggregateHandler(),
      // Phase 3 handlers (T15): curry the registry + queue into the core fns
      publishDispatch: (payload, q) => handlePublishDispatch(payload, q, connectorRegistry),
      publishUnit: (payload, q) => publishUnit(payload, q, connectorRegistry),
      publishVerify: (payload) => handlePublishVerify(payload, connectorRegistry),
    },
    limiters,
  });

  log.info("pg-boss worker started");

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  let stopping = false;

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;

    log.info({ signal }, "shutdown: starting graceful stop");

    try {
      await app.close();
      log.info("shutdown: Fastify closed");
    } catch (err) {
      log.error({ err }, "shutdown: error closing Fastify");
    }

    try {
      await stopWorker();
      log.info("shutdown: worker stopped");
    } catch (err) {
      log.error({ err }, "shutdown: error stopping worker");
    }

    log.info("shutdown: complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
  process.on("SIGINT",  () => { shutdown("SIGINT").catch(() => process.exit(1)); });

  log.info({ port: env.PORT }, "AEO/GEO Phase 0 engine running");
}

main().catch((err) => {
  process.stderr.write(`[index] fatal startup error: ${String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
