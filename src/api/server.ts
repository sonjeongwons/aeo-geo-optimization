/**
 * src/api/server.ts
 *
 * Fastify HTTP API for the AEO/GEO Phase 0 engine.
 *
 * Routes:
 *   GET  /healthz         — liveness check (returns 200)  [PUBLIC]
 *   GET  /providers       — provider registry readiness    [PUBLIC]
 *   GET  /smr/:runId      — return a recomputed-from-raw RunReport  [OPS-ONLY]
 *   POST /diagnose        — trigger a baseline run for a customer   [OPS-ONLY]
 *
 * Phase 5 multi-tenant hardening (P5-T18):
 *   GET /smr/:runId and POST /diagnose are OPS-ONLY routes, not public.
 *   They require a valid Authorization: Bearer <OPS_TOKEN> header where
 *   OPS_TOKEN is set in the environment.  When OPS_TOKEN is absent these
 *   routes are completely blocked (fail-closed — 403).
 *   The customer-facing surface is the Next.js tenant API (apps/web/).
 *   The ops CLI path (`npm run diagnose`) uses src/cli/diagnose.ts directly
 *   and does NOT go through these HTTP routes.
 *
 * DESIGN.md references:
 *   "POST /diagnose (trigger baseline), GET /smr/:runId (report JSON via direct SQL),
 *    GET /healthz, GET /providers (registry readiness)"
 */

import Fastify from "fastify";
import pino from "pino";
import { buildRegistry } from "../providers/registry.js";
import { assembleReport } from "../metrics/report.js";
import * as repo from "../db/repo.js";
import { loadTemplate } from "../config/loadTemplate.js";
import { runCycle } from "../pipeline/runCycle.js";
import { runResponse } from "../pipeline/runResponse.js";
import { Ledger } from "../cost/ledger.js";
import { evidenceRequiredGate } from "../guardrails/evidenceRequiredGate.js";
import { resolve } from "node:path";
import { wireSurfaces } from "../surfaces/wireSurfaces.js";
import { env } from "../config/env.js";
import type { RunCycleDeps } from "../pipeline/runCycle.js";
import type { ModelRef, CustomerLanguage, Budget, Question } from "../domain/types.js";

const log = pino({ name: "api.server" });

// ---------------------------------------------------------------------------
// Ops-only guard (Phase 5 / P5-T18)
//
// The legacy engine routes GET /smr/:runId and POST /diagnose are no longer
// public.  In the multi-tenant product the customer surface is the Next.js
// tenant API; these routes are retained for internal/ops use only.
//
// A valid "Authorization: Bearer <OPS_TOKEN>" header is required.
// If OPS_TOKEN is not configured in the environment the routes are blocked
// for ALL callers (fail-closed).  /healthz and /providers are NOT guarded.
// ---------------------------------------------------------------------------

/**
 * Returns true when the request carries a valid ops bearer token.
 * Fail-closed: returns false when OPS_TOKEN is not configured.
 */
function isValidOpsRequest(authHeader: string | undefined): boolean {
  if (!env.OPS_TOKEN) {
    // No token configured → block all callers (fail-closed)
    return false;
  }
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const supplied = authHeader.slice(prefix.length);
  // Constant-time comparison to mitigate timing attacks
  return timingSafeEqual(supplied, env.OPS_TOKEN);
}

/**
 * Constant-time string equality (avoids early-exit timing leaks).
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still run a comparison to avoid length-based timing leak,
    // then return false.
    let _dummy = 0;
    for (let i = 0; i < a.length; i++) {
      _dummy |= a.charCodeAt(i) ^ 0;
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Provider registry (if pre-built; otherwise builds from process.env) */
  registry?: ReturnType<typeof buildRegistry>;
}

/**
 * Build and configure the Fastify instance.
 * Does NOT call listen() — the caller (index.ts) does that.
 */
export function buildServer(opts: ServerOptions = {}) {
  const app = Fastify({
    logger: false, // We use pino directly
    disableRequestLogging: true,
  });

  const registry = opts.registry ?? buildRegistry();

  // ---------------------------------------------------------------------------
  // GET /healthz
  // ---------------------------------------------------------------------------

  app.get("/healthz", async (_req, reply) => {
    return reply.status(200).send({ status: "ok", ts: new Date().toISOString() });
  });

  // ---------------------------------------------------------------------------
  // GET /providers
  // ---------------------------------------------------------------------------

  app.get("/providers", async (_req, reply) => {
    const readiness = registry.readiness();
    return reply.status(200).send({ providers: readiness });
  });

  // ---------------------------------------------------------------------------
  // GET /smr/:runId  [OPS-ONLY — requires Authorization: Bearer <OPS_TOKEN>]
  //
  // Phase 5 (P5-T18): this route is no longer a public endpoint.
  // The multi-tenant customer surface is the Next.js /api/reports routes.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { runId: string } }>(
    "/smr/:runId",
    async (req, reply) => {
      // Ops guard: reject unauthenticated / public callers (fail-closed)
      if (!isValidOpsRequest(req.headers.authorization)) {
        log.warn({ runId: req.params.runId }, "GET /smr/:runId: rejected — ops-only route");
        return reply.status(403).send({ error: "Forbidden — ops-only route", route: "GET /smr/:runId" });
      }

      const { runId } = req.params;

      // Validate the run exists
      const run = await repo.findRun(runId);
      if (!run) {
        return reply.status(404).send({ error: "Run not found", runId });
      }

      // Recompute the report from raw (direct SQL, synchronous)
      let report;
      try {
        report = await assembleReport(runId);
      } catch (err) {
        log.error({ runId, err }, "/smr/:runId: assembleReport failed");
        return reply.status(500).send({
          error: "Failed to assemble report",
          runId,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      return reply.status(200).send(report);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /diagnose  [OPS-ONLY — requires Authorization: Bearer <OPS_TOKEN>]
  //
  // Phase 5 (P5-T18): this route is no longer a public endpoint.
  // The free-diagnostic funnel uses the Next.js Server Action in
  // apps/web/lib/actions/diagnose.ts (scoped to a demo/lead customer).
  // ---------------------------------------------------------------------------

  app.post<{ Body: { customer: string } }>(
    "/diagnose",
    {
      schema: {
        body: {
          type: "object",
          required: ["customer"],
          properties: {
            customer: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      // Ops guard: reject unauthenticated / public callers (fail-closed)
      if (!isValidOpsRequest(req.headers.authorization)) {
        log.warn({ customer: req.body?.customer }, "POST /diagnose: rejected — ops-only route");
        return reply.status(403).send({ error: "Forbidden — ops-only route", route: "POST /diagnose" });
      }

      const { customer: customerSlug } = req.body;

      log.info({ customerSlug }, "POST /diagnose: starting");

      // 1. Load template (idempotent)
      const templatePath = resolve(`config/customers/${customerSlug}.yaml`);
      try {
        await loadTemplate(templatePath);
      } catch (err) {
        log.error({ customerSlug, templatePath, err }, "POST /diagnose: failed to load template");
        return reply.status(400).send({
          error: "Failed to load customer template",
          customer: customerSlug,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // 2. Fetch customer
      const customer = await repo.findCustomerBySlug(customerSlug);
      if (!customer) {
        return reply.status(404).send({ error: "Customer not found", customer: customerSlug });
      }
      const customerId = customer.id;

      // 3. Fetch context
      const [brands, competitorRows, questionRows, langRows, budgetRow, allEnabledModels] =
        await Promise.all([
          repo.findBrandsByCustomer(customerId),
          repo.findCompetitorsByCustomer(customerId),
          repo.findActiveQuestions(customerId),
          repo.findCustomerLanguages(customerId),
          repo.findBudget(customerId),
          repo.findEnabledModels(),
        ]);

      if (brands.length === 0) {
        return reply.status(400).send({ error: "No brand configured for customer", customer: customerSlug });
      }
      if (!budgetRow) {
        return reply.status(400).send({ error: "No budget configured for customer", customer: customerSlug });
      }

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

      // 4. Build adapters
      const adapters = new Map(
        registry.all()
          .filter((a) => a.status === "ready")
          .map((a) => [a.provider, a]),
      );

      const judgeAdapter = registry.get("gemini");
      if (!judgeAdapter || judgeAdapter.status !== "ready") {
        return reply.status(503).send({
          error: "GEMINI_API_KEY not configured — cannot run baseline",
          providers: registry.readiness(),
        });
      }

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

      // ICS-01: wire v1-b surface adapters into the baseline plan.
      // runKind=baseline: only ready SERP surfaces included (scrape excluded by wireSurfaces).
      const { surfaceModels, surfaceAdapters } = wireSurfaces({
        registryAdapters: registry.all(),
        runKind: "baseline",
      });
      for (const [key, adapter] of surfaceAdapters) {
        adapters.set(key, adapter);
      }
      const models: ModelRef[] = [...chatModels, ...surfaceModels];

      // 5. Cost reader
      const costReader = {
        getRollingSpendUsd: async (cid: string, windowDays: number): Promise<number | null> => {
          const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
          return repo.sumCostSince(cid, since);
        },
      };

      // 6. Ledger
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

      // 7. Cache fns
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

      // 8. Inline response handler
      const responseRunHandler: RunCycleDeps["responseRunHandler"] = async (payload, runResponseDeps) => {
        await runResponse(payload, runResponseDeps);
      };

      // 9. Build deps and run cycle
      // Compute isNewCustomer dynamically: only bypass fail-closed on the very
      // first call for this customer (no prior llm_call rows).  Returning customers
      // with missing CAGG data should fail closed per §11.
      const hasPriorCall = await repo.customerHasPriorLlmCall(customerId);
      const deps: RunCycleDeps = {
        responseRunHandler,
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
        isNewCustomer: !hasPriorCall,
        currentCycleIndex: 0,
      };

      let report;
      try {
        report = await runCycle({ customerId, kind: "baseline" }, deps);
      } catch (err) {
        log.error({ customerId, customerSlug, err }, "POST /diagnose: runCycle failed");
        return reply.status(500).send({
          error: "runCycle failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (!report) {
        return reply.status(422).send({
          error: "Run completed but report unavailable (possibly over_budget or empty plan)",
          customer: customerSlug,
        });
      }

      log.info({ runId: report.runId, smr: report.smr.value, customerSlug }, "POST /diagnose: done");
      return reply.status(200).send(report);
    },
  );

  return app;
}

// ---------------------------------------------------------------------------
// Start helper (used by index.ts)
// ---------------------------------------------------------------------------

/**
 * Build, configure, and start listening.
 *
 * @param port  Port to bind (default: 3000)
 * @param host  Host to bind (default: '0.0.0.0')
 * @returns     The running Fastify instance (call .close() to stop)
 */
export async function startServer(port = 3000, host = "0.0.0.0") {
  const app = buildServer();

  await app.listen({ port, host });
  log.info({ port, host }, "API server listening");

  return app;
}
