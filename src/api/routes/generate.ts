/**
 * src/api/routes/generate.ts
 *
 * T20 — Optional Phase 1 Fastify API routes (generate.ts).
 *
 * Mirrors the existing src/api/server.ts style: thin handlers that delegate
 * to the same shared services the CLIs use.  No logic is duplicated here.
 *
 * Routes:
 *   POST  /diagnose-url           — Read-only URL diagnosis → BrandBrief JSON.
 *   POST  /templates              — Run gen-template pipeline → status='draft'.
 *   PATCH /templates/:id/review   — Transition draft → reviewed (stamps reviewer).
 *   POST  /templates/:id/activate — Transition reviewed → active + materialize.
 *
 * Design rules:
 *   - POST /diagnose-url is read-only (GET-only at the URL-fetch level via SSRF-guarded urlFetch.ts).
 *   - Activate route enforces reviewed→active (refuses draft→active via actionActive's §5.5 gate).
 *   - Budget preflight (qgenBudget) applied on diagnose and gen-template routes.
 *   - All Gemini calls routed through the Phase 0 GeminiAdapter (generateStructured).
 *   - Generated templates are ALWAYS status='draft'; never auto-activated.
 *
 * Dependencies delegated to shared services (CLIs use the same code paths):
 *   - diagnose()          from src/generate/diagnose.ts      (T07)
 *   - assembleTemplate()  from src/generate/assembleTemplate.ts (T15) via gen-template pipeline
 *   - actionReviewed()    from src/cli/reviewTemplate.ts     (T19)
 *   - actionActive()      from src/cli/reviewTemplate.ts     (T19)
 *   - createQgenBudget()  from src/cost/qgenBudget.ts        (T14)
 *   - makeGeminiAdapter() from src/providers/gemini.ts       (Phase 0)
 *
 * DESIGN-phase1.md §"src/api/ (optional, mirrors existing Fastify server.ts)", T20.
 *
 * Node 22 ESM NodeNext: all relative imports use .js extension.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import pino from "pino";
import { makeGeminiAdapter } from "../../providers/gemini.js";
import { diagnose } from "../../generate/diagnose.js";
import { createQgenBudget, QgenGlobalCapExceededError } from "../../cost/qgenBudget.js";
import {
  actionReviewed,
  actionActive,
  InvalidStatusTransitionError,
  PayloadValidationError,
  type ReviewRepo,
  type MaterializePort,
  type MaterializeCtx,
} from "../../cli/reviewTemplate.js";
import { env, geminiApiKeys } from "../../config/env.js";
import type { LedgerPort } from "../../generate/diagnose.js";
import type { z } from "zod";
import type { GenerateStructuredRequest } from "../../providers/types.js";

const log = pino({ name: "api.routes.generate" });

// ---------------------------------------------------------------------------
// Real DB ledger for API-level use — persists every Gemini call to the cost
// ledger table (§11: every billable call must be ledgered).  Uses a lazy
// import to match the route's other lazy DB usage patterns (CR-2 fix).
// ---------------------------------------------------------------------------

const apiLedger: LedgerPort = {
  async insertLlmCall(c) {
    // Debug log (kept for operational visibility)
    process.stderr.write(
      `[api/generate] llm_call: model=${c.modelId} in=${c.inputTokens} ` +
        `out=${c.outputTokens} usd=$${c.usd.toFixed(6)}\n`,
    );
    // Persist to the real DB cost ledger (lazy import — matches pattern in this file)
    const { insertLlmCall } = await import("../../db/repo.js");
    return insertLlmCall(c);
  },
};

// ---------------------------------------------------------------------------
// Production ReviewRepo (lazy DB imports — matches reviewTemplate.ts pattern)
// ---------------------------------------------------------------------------

function makeProductionRepo(): ReviewRepo {
  return {
    async getIndustryTemplate(id: string) {
      const { getIndustryTemplate } = await import("../../db/repo.js");
      return getIndustryTemplate(id);
    },
    async updateTemplateStatus(id, status, reviewedBy) {
      const { updateTemplateStatus } = await import("../../db/repo.js");
      return updateTemplateStatus(id, status, reviewedBy);
    },
    async demoteActiveTemplate(industry) {
      const { demoteActiveTemplate } = await import("../../db/repo.js");
      return demoteActiveTemplate(industry);
    },
    async nextTemplateVersion(industry) {
      const { nextTemplateVersion } = await import("../../db/repo.js");
      return nextTemplateVersion(industry);
    },
    async insertIndustryTemplate(t) {
      const { insertIndustryTemplate } = await import("../../db/repo.js");
      return insertIndustryTemplate(t);
    },
    async withTransaction(fn) {
      const { getDb } = await import("../../db/kysely.js");
      await getDb().transaction().execute(async (trx) => {
        // Build a transaction-bound repo so demote+activate run on the SAME
        // connection (mirrors reviewTemplate.ts makeProductionRepo pattern,
        // required by TLI-01 fix which changed the withTransaction signature).
        const txRepo: ReviewRepo = {
          async getIndustryTemplate(id: string) {
            const { getIndustryTemplate } = await import("../../db/repo.js");
            return getIndustryTemplate(id);
          },
          async updateTemplateStatus(id, status, reviewedBy) {
            const { updateTemplateStatus } = await import("../../db/repo.js");
            return updateTemplateStatus(id, status, reviewedBy, trx as never);
          },
          async demoteActiveTemplate(industry) {
            const { demoteActiveTemplate } = await import("../../db/repo.js");
            return demoteActiveTemplate(industry, trx as never);
          },
          async nextTemplateVersion(industry) {
            const { nextTemplateVersion } = await import("../../db/repo.js");
            return nextTemplateVersion(industry);
          },
          async insertIndustryTemplate(t) {
            const { insertIndustryTemplate } = await import("../../db/repo.js");
            return insertIndustryTemplate(t);
          },
          async withTransaction(innerFn) {
            // Nested transactions not supported; delegate to self.
            await innerFn(txRepo);
          },
        };
        await fn(txRepo);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Production MaterializePort (lazy import of materialize.ts)
// ---------------------------------------------------------------------------

function makeProductionMaterializePort(): MaterializePort {
  return {
    async materialize(row, ctx) {
      const { materialize } = await import("../../generate/materialize.js");
      return materialize(row, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Multilingual generation interface (T10 — may not be present; dynamic import)
// ---------------------------------------------------------------------------

interface MultilingualAdapter {
  generateStructured<T extends z.ZodTypeAny>(
    req: GenerateStructuredRequest<T>
  ): Promise<import("../../providers/types.js").GenerateStructuredResult<z.infer<T>>>;
}

interface MultilingualOptions {
  adapter: MultilingualAdapter;
  brief: import("../../generate/types.js").BrandBrief;
  matrix: import("../../generate/types.js").IntentCell[];
  genOptions: import("../../generate/types.js").GenOptions;
  ledger: LedgerPort;
  budget: ReturnType<typeof createQgenBudget>;
}

interface MultilingualResult {
  questions: import("../../generate/types.js").DraftQuestion[];
  generatedTotal: number;
}

async function tryLoadMultilingual(): Promise<
  ((opts: MultilingualOptions) => Promise<MultilingualResult>) | null
> {
  try {
    const modulePath = "../../generate/multilingual.js";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import(/* @vite-ignore */ modulePath) as any;
    if (typeof mod.generateMultilingual === "function") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
      return mod.generateMultilingual as (opts: MultilingualOptions) => Promise<MultilingualResult>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

/**
 * Register the Phase 1 generate routes on the given Fastify instance.
 *
 * Usage in server.ts (or an index file):
 *   import { registerGenerateRoutes } from './routes/generate.js';
 *   await app.register(registerGenerateRoutes);
 *
 * All routes are prefixed with no additional path (they live at root level,
 * matching the existing Phase 0 server.ts route style).
 */
export const registerGenerateRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {

  // -------------------------------------------------------------------------
  // POST /diagnose-url
  //
  // Read-only: runs the URL diagnosis pipeline (fetch + extract + ONE Gemini
  // call → BrandBrief).  Off-site §0: URL fetch is GET-only (SSRF guard in
  // urlFetch.ts).  Budget preflight: global gate checked before Gemini call.
  // -------------------------------------------------------------------------

  app.post<{
    Body: {
      url?: string;
      industry?: string;
      customer?: string;
    };
  }>(
    "/diagnose-url",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            url: { type: "string" },
            industry: { type: "string" },
            customer: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { url, industry, customer } = req.body;

      // Require at least url or industry
      if (!url && !industry) {
        return reply.status(400).send({
          error: "Supply at least 'url' or 'industry' in the request body.",
        });
      }

      // GEMINI_API_KEY check
      const apiKeys = geminiApiKeys();
      if (apiKeys.length === 0 && !industry) {
        return reply.status(503).send({
          error:
            "GEMINI_API_KEY is not configured and no industry fallback was supplied. " +
            "Set GEMINI_API_KEY to use the diagnose-url route.",
        });
      }

      // Budget preflight (coarse global gate — one diagnosis call ≈ $0.05)
      const ESTIMATED_DIAGNOSIS_USD = 0.05;
      const budget = createQgenBudget({ runCeilingUsd: ESTIMATED_DIAGNOSIS_USD * 2 });

      try {
        budget.assertGlobalGate({ estimatedUsd: ESTIMATED_DIAGNOSIS_USD });
      } catch (err) {
        if (err instanceof QgenGlobalCapExceededError) {
          return reply.status(429).send({
            error: `Global ${err.capType} cap would be exceeded`,
            estimatedUsd: err.estimatedUsd,
            capUsd: err.capUsd,
          });
        }
        throw err;
      }

      // Build adapter
      const adapter = makeGeminiAdapter(apiKeys);

      log.info(
        { url, industry, customer },
        "POST /diagnose-url: starting diagnosis",
      );

      // Run diagnosis (delegates to shared diagnose() service)
      const result = await diagnose({
        ...(url !== undefined ? { url } : {}),
        ...(industry !== undefined ? { industry } : {}),
        customerId: null,
        adapter,
        ledger: apiLedger,
      });

      // Handle NOT_CONFIGURED
      if (!result.ok && result.code === "NOT_CONFIGURED") {
        return reply.status(503).send({
          error: result.message,
        });
      }

      // Handle other errors
      if (!result.ok) {
        return reply.status(502).send({
          error: result.message,
          code: result.code,
        });
      }

      log.info(
        {
          mode: result.mode,
          brand: result.brief.brandName,
          industry: result.brief.industryKey,
          confidence: result.brief.confidence,
        },
        "POST /diagnose-url: done",
      );

      // Build response (matches diagnoseUrl.ts output shape)
      const response: Record<string, unknown> = {
        mode: result.mode,
        brief: result.brief,
      };

      if (result.robotsNote) {
        response["robotsNote"] = result.robotsNote;
      }
      if (result.degradeReason) {
        response["degradeReason"] = result.degradeReason;
      }
      if (customer) {
        response["customerSeed"] = {
          slug: customer,
          brandName: result.brief.brandName,
          industryKey: result.brief.industryKey,
          detectedLanguages: result.brief.detectedLanguages,
          seedCompetitors: result.brief.seedCompetitors,
        };
      }

      return reply.status(200).send(response);
    },
  );

  // -------------------------------------------------------------------------
  // POST /templates
  //
  // Run the full gen-template pipeline → status='draft'.
  // Delegates to the same pipeline modules used by genTemplate.ts (T18).
  // Budget: per-run ceiling + global gate enforced via createQgenBudget().
  // -------------------------------------------------------------------------

  app.post<{
    Body: {
      url?: string;
      industry?: string;
      customer?: string;
      total?: number;
    };
  }>(
    "/templates",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            url: { type: "string" },
            industry: { type: "string" },
            customer: { type: "string" },
            total: { type: "number" },
          },
        },
      },
    },
    async (req, reply) => {
      const { url, industry, customer, total: rawTotal = 120 } = req.body;

      if (!url && !industry) {
        return reply.status(400).send({
          error: "Supply at least 'url' or 'industry' in the request body.",
        });
      }

      const apiKeys = geminiApiKeys();
      if (apiKeys.length === 0) {
        return reply.status(503).send({
          error:
            "GEMINI_API_KEY is not configured. " +
            "Set GEMINI_API_KEY to generate templates.",
        });
      }

      // Budget preflight (global gate; per-run ceiling $5.00 for full gen run)
      const ESTIMATED_TOTAL_USD = 3.0;
      const budget = createQgenBudget({ runCeilingUsd: 5.0 });

      try {
        budget.assertGlobalGate({ estimatedUsd: ESTIMATED_TOTAL_USD });
      } catch (err) {
        if (err instanceof QgenGlobalCapExceededError) {
          return reply.status(429).send({
            error: `Global ${err.capType} cap would be exceeded`,
            estimatedUsd: err.estimatedUsd,
            capUsd: err.capUsd,
          });
        }
        throw err;
      }

      // Parse + clamp total via GenOptionsSchema (delegates to shared types)
      let genOptions: import("../../generate/types.js").GenOptions;
      try {
        const { GenOptionsSchema } = await import("../../generate/types.js");
        genOptions = GenOptionsSchema.parse({ requestedTotal: rawTotal });
      } catch (err) {
        return reply.status(400).send({
          error: `Invalid 'total' parameter: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const adapter = makeGeminiAdapter(apiKeys);

      log.info(
        { url, industry, customer, total: genOptions.requestedTotal },
        "POST /templates: starting gen-template pipeline",
      );

      // Stage A: Diagnosis (delegates to shared diagnose() service)
      const diagResult = await diagnose({
        ...(url !== undefined ? { url } : {}),
        ...(industry !== undefined ? { industry } : {}),
        customerId: null,
        adapter,
        ledger: apiLedger,
      });

      if (!diagResult.ok) {
        if (diagResult.code === "NOT_CONFIGURED") {
          return reply.status(503).send({ error: diagResult.message });
        }
        return reply.status(502).send({
          error: diagResult.message,
          code: diagResult.code,
        });
      }

      const brief = diagResult.brief;

      // Stage B: IntentMatrix (pure)
      const { buildIntentMatrix, sumTargetCounts } = await import(
        "../../generate/intentMatrix.js"
      );
      const matrix = buildIntentMatrix(brief, genOptions);
      const matrixTotal = sumTargetCounts(matrix);

      log.info(
        { cells: matrix.length, total: matrixTotal },
        "POST /templates: IntentMatrix built",
      );

      // Stage C: Apply density tiers to matrix
      const { applyDensityTiers, applyDensityToQuestions, buildLangWeightsMap } =
        await import("../../generate/densityMap.js");
      const langWeightsMap = buildLangWeightsMap(brief);
      applyDensityTiers(matrix, langWeightsMap, matrixTotal);

      // Stage D: Multilingual generation (T10 — dynamic import)
      const generateMultilingual = await tryLoadMultilingual();

      if (!generateMultilingual) {
        return reply.status(503).send({
          error:
            "Multilingual generation module (src/generate/multilingual.ts) is not available. " +
            "Ensure all Phase 1 tasks are built before using this endpoint.",
        });
      }

      let generatedQuestions: import("../../generate/types.js").DraftQuestion[];
      let generatedTotal: number;

      try {
        const result = await generateMultilingual({
          adapter,
          brief,
          matrix,
          genOptions,
          ledger: apiLedger,
          budget,
        });
        generatedQuestions = result.questions;
        generatedTotal = result.generatedTotal;
      } catch (err) {
        const { QgenBudgetExceededError } = await import("../../cost/qgenBudget.js");
        if (err instanceof QgenBudgetExceededError) {
          return reply.status(429).send({
            error: "Per-run budget ceiling exceeded during multilingual generation.",
            accumulatedUsd: err.accumulatedUsd,
            ceilingUsd: err.ceilingUsd,
          });
        }
        return reply.status(502).send({
          error: `Multilingual generation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Stage E (skip density here — applied AFTER pruning; see Stage G+)
      // Do NOT call applyDensityToQuestions on the over-generated pool. The cap
      // denominator must be the FINAL question count (GQ-1 fix).

      // Stage F: Dedup
      const { dedup } = await import("../../generate/dedup.js");
      const { kept: dedupedQuestions } = dedup(generatedQuestions);

      // Stage G: Guardrails
      const { applyQuestionGuards } = await import("../../generate/questionGuards.js");
      const { kept: guardedQuestions } = applyQuestionGuards(
        dedupedQuestions,
        brief.brandName,
        brief.brandAliases,
      );

      // Stage G+: Apply density tiers to the FINAL kept set
      // Run applyDensityToQuestions on the post-dedup + post-guardrails set so
      // the HARD core cap (<=25%) is enforced against the actual final count,
      // not the over-generated pool (fixes GQ-1: cap denominator = final count).
      applyDensityToQuestions(guardedQuestions, brief);

      log.info(
        { final: guardedQuestions.length, total: generatedTotal },
        "POST /templates: pipeline complete, assembling draft",
      );

      // Stage H: Assemble + persist draft (delegates to shared assembleTemplate())
      let templateId: string;
      let questionCount: number;

      try {
        const { assembleTemplate } = await import("../../generate/assembleTemplate.js");
        const result = await assembleTemplate({
          questions: guardedQuestions,
          seedCompetitors: brief.seedCompetitors,
          brief,
          generatedTotal,
          source: url ? "url" : "industry",
          lowResourceLanguages: genOptions.lowResourceLanguages,
          ...(url ? { sourceUrl: url } : {}),
          ...(customer ? { customerSlug: customer } : {}),
        });
        templateId = result.templateId;
        questionCount = result.questionCount;
      } catch (err) {
        return reply.status(500).send({
          error: `assembleTemplate failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      log.info(
        { templateId, questions: questionCount },
        "POST /templates: draft template created",
      );

      return reply.status(201).send({
        templateId,
        industry: brief.industryKey,
        status: "draft",
        questionCount,
        competitorCount: brief.seedCompetitors.length,
        generatedTotal,
        diagnosisMode: diagResult.mode,
        budgetUsd: budget.totalUsd,
        message:
          "Draft industry template created. " +
          "Use PATCH /templates/:id/review to mark it as reviewed, " +
          "then POST /templates/:id/activate to activate it.",
        ...(customer ? { customerSlug: customer } : {}),
      });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /templates/:id/review
  //
  // Transition draft → reviewed.  Stamps reviewer identity.
  // Delegates to actionReviewed() from reviewTemplate.ts (T19).
  //
  // Body: { by: string }
  // -------------------------------------------------------------------------

  app.patch<{
    Params: { id: string };
    Body: { by: string };
  }>(
    "/templates/:id/review",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["by"],
          properties: {
            by: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { by } = req.body;

      const repo = makeProductionRepo();

      log.info({ id, by }, "PATCH /templates/:id/review: starting");

      try {
        const result = await actionReviewed(id, by, repo);

        log.info(
          { templateId: result.templateId, industry: result.industry },
          "PATCH /templates/:id/review: done",
        );

        return reply.status(200).send({
          action: "reviewed",
          templateId: result.templateId,
          industry: result.industry,
          version: result.version,
          reviewedBy: by,
          status: "reviewed",
        });
      } catch (err) {
        if (err instanceof InvalidStatusTransitionError) {
          return reply.status(409).send({
            error: err.message,
            templateId: err.id,
            currentStatus: err.currentStatus,
            requestedAction: err.requestedAction,
          });
        }
        if (err instanceof PayloadValidationError) {
          return reply.status(422).send({
            error: err.message,
          });
        }
        // Template not found
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          return reply.status(404).send({ error: msg });
        }
        log.error({ id, err }, "PATCH /templates/:id/review: unexpected error");
        return reply.status(500).send({ error: msg });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /templates/:id/activate
  //
  // Transition reviewed → active.
  //   - REFUSES if current status is 'draft' (structural §5.5 gate enforced
  //     by actionActive() via InvalidStatusTransitionError).
  //   - Demotes any prior active template for the same industry (in txn).
  //   - Invokes materialize() → emits YAML + loadTemplate() upserts.
  //
  // Body: { by: string, slug?: string, brandName?: string }
  // -------------------------------------------------------------------------

  app.post<{
    Params: { id: string };
    Body: {
      by: string;
      slug?: string;
      brandName?: string;
      brandAliases?: string[];
      languages?: Array<{ code: string; weight: number }>;
      budget?: {
        max_models?: number;
        max_samples?: number;
        max_languages?: number;
        weekly_usd_cap?: number;
        monthly_usd_cap?: number;
      };
    };
  }>(
    "/templates/:id/activate",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["by"],
          properties: {
            by: { type: "string", minLength: 1 },
            slug: { type: "string" },
            brandName: { type: "string" },
            brandAliases: {
              type: "array",
              items: { type: "string" },
            },
            languages: {
              type: "array",
              items: {
                type: "object",
                required: ["code", "weight"],
                properties: {
                  code: { type: "string" },
                  weight: { type: "number" },
                },
              },
            },
            budget: {
              type: "object",
              properties: {
                max_models: { type: "number" },
                max_samples: { type: "number" },
                max_languages: { type: "number" },
                weekly_usd_cap: { type: "number" },
                monthly_usd_cap: { type: "number" },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { by, slug, brandName, brandAliases, languages, budget } = req.body;

      const repo = makeProductionRepo();
      const materializePort = makeProductionMaterializePort();

      // Build optional materialize context from body fields
      let materializeCtx: MaterializeCtx | undefined;
      if (slug || brandName) {
        // Load the row to fill in any missing context from customer_slug / industry
        const previewRow = await repo.getIndustryTemplate(id);
        if (!previewRow) {
          return reply.status(404).send({ error: `Template not found: ${id}` });
        }
        const derivedSlug =
          slug ??
          (previewRow.customer_slug ?? previewRow.industry.replace(/[^a-z0-9-]/g, "-"));

        materializeCtx = {
          slug: derivedSlug,
          brandName: brandName ?? derivedSlug,
          ...(brandAliases !== undefined ? { brandAliases } : {}),
          ...(languages !== undefined ? { languages } : {}),
          ...(budget !== undefined ? { budget } : {}),
        };
      }

      log.info({ id, by, slug }, "POST /templates/:id/activate: starting");

      try {
        const result = await actionActive(id, by, repo, materializePort, materializeCtx);

        log.info(
          {
            templateId: result.templateId,
            industry: result.industry,
            yamlPath: result.yamlPath,
            questions: result.questionCount,
          },
          "POST /templates/:id/activate: done",
        );

        return reply.status(200).send({
          action: "active",
          templateId: result.templateId,
          industry: result.industry,
          version: result.version,
          activatedBy: by,
          status: "active",
          yamlPath: result.yamlPath,
          questionCount: result.questionCount,
          competitorCount: result.competitorCount,
        });
      } catch (err) {
        if (err instanceof InvalidStatusTransitionError) {
          // §5.5 structural gate: refuse draft→active or other invalid transitions
          const httpStatus = err.currentStatus === "draft" ? 409 : 409;
          return reply.status(httpStatus).send({
            error: err.message,
            templateId: err.id,
            currentStatus: err.currentStatus,
            requestedAction: err.requestedAction,
          });
        }
        if (err instanceof PayloadValidationError) {
          return reply.status(422).send({ error: err.message });
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          return reply.status(404).send({ error: msg });
        }
        if (msg.includes("status=") && msg.includes("structural gate")) {
          // MaterializeStatusError — should not reach here (actionActive catches it)
          return reply.status(409).send({ error: msg });
        }
        log.error({ id, err }, "POST /templates/:id/activate: unexpected error");
        return reply.status(500).send({ error: msg });
      }
    },
  );
};
