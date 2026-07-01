/**
 * src/cli/diagnose.ts
 *
 * CLI entry point: `npm run diagnose -- --customer emora`
 *
 * Steps:
 *   1. Load .env + validate environment.
 *   2. Parse --customer <slug> arg.
 *   3. Load the customer YAML template (idempotent upsert).
 *   4. Fetch customer context (brand, competitors, questions, budget, languages, models).
 *   5. Build RunCycleDeps with the synchronous inline path (responseRunHandler).
 *   6. Execute runCycle (baseline) — blocks until all work-units are done.
 *   7. Print the RunReport as JSON to stdout.
 *
 * This is the "FULL loop end-to-end with only GEMINI_API_KEY" path from DESIGN.md.
 */

import "../config/env.js"; // side-effect: load .env + fail fast on missing DATABASE_URL
import { env } from "../config/env.js";
import { resolve } from "node:path";
import pino from "pino";
import { loadTemplate } from "../config/loadTemplate.js";
import { buildRegistry } from "../providers/registry.js";
import * as repo from "../db/repo.js";
import { runCycle } from "../pipeline/runCycle.js";
import { runResponse } from "../pipeline/runResponse.js";
import { Ledger } from "../cost/ledger.js";
import { evidenceRequiredGate } from "../guardrails/evidenceRequiredGate.js";
import { wireSurfaces } from "../surfaces/wireSurfaces.js";
import type { RunCycleDeps } from "../pipeline/runCycle.js";
import type { ModelRef, CustomerLanguage, Budget, Question } from "../domain/types.js";

const log = pino({ name: "cli.diagnose", level: env.LOG_LEVEL });

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { customerSlug: string } {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--customer");
  if (idx === -1 || !args[idx + 1]) {
    process.stderr.write("Usage: npm run diagnose -- --customer <slug>\n");
    process.exit(1);
  }
  return { customerSlug: args[idx + 1]! };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { customerSlug } = parseArgs();

  log.info({ customerSlug }, "diagnose: starting");

  // 1. Load template (idempotent — safe to re-run)
  const templatePath = resolve(`config/customers/${customerSlug}.yaml`);
  log.info({ templatePath }, "diagnose: loading template");
  await loadTemplate(templatePath);
  log.info("diagnose: template loaded");

  // 2. Fetch customer row
  const customer = await repo.findCustomerBySlug(customerSlug);
  if (!customer) {
    process.stderr.write(`diagnose: customer not found after template load: ${customerSlug}\n`);
    process.exit(1);
  }
  const customerId = customer.id;

  // 3. Fetch brand
  const brands = await repo.findBrandsByCustomer(customerId);
  if (brands.length === 0) {
    process.stderr.write(`diagnose: no brand found for customer: ${customerSlug}\n`);
    process.exit(1);
  }
  const brand = brands[0]!;

  // 4. Fetch competitors
  const competitorRows = await repo.findCompetitorsByCustomer(customerId);
  const competitors = competitorRows.map((c) => ({ name: c.name, aliases: c.aliases }));

  // 5. Fetch questions
  const questionRows = await repo.findActiveQuestions(customerId);
  const questions: Question[] = questionRows.map((q) => ({
    id: q.id,
    customerId,
    text: q.text,
    language: q.language,
    funnelStage: q.funnel_stage,
    densityTier: q.density_tier,
    active: true,
  }));

  // 6. Fetch customer languages
  const langRows = await repo.findCustomerLanguages(customerId);
  const languages: CustomerLanguage[] = langRows.map((l) => ({
    customerId,
    language: l.language,
    weight: parseFloat(l.weight),
  }));

  // 7. Fetch budget
  const budgetRow = await repo.findBudget(customerId);
  if (!budgetRow) {
    process.stderr.write(`diagnose: no budget found for customer: ${customerSlug}\n`);
    process.exit(1);
  }
  const budget: Budget = {
    customerId,
    maxModels: budgetRow.max_models,
    maxSamples: budgetRow.max_samples,
    maxLanguages: budgetRow.max_languages,
    weeklyUsdCap: parseFloat(budgetRow.weekly_usd_cap),
    monthlyUsdCap: parseFloat(budgetRow.monthly_usd_cap),
  };

  // 8. Build provider registry
  const registry = buildRegistry();
  const readiness = registry.readiness();
  log.info({ readiness }, "diagnose: provider readiness");

  // 9. Filter to ready models only
  const allEnabledModels = await repo.findEnabledModels();

  // Build adapters map (provider → adapter for ready providers)
  const adapters = new Map(
    registry.all()
      .filter((a) => a.status === "ready")
      .map((a) => [a.provider, a]),
  );

  // Gemini judge adapter (required)
  const judgeAdapter = registry.get("gemini");
  if (!judgeAdapter || judgeAdapter.status !== "ready") {
    process.stderr.write(
      "diagnose: GEMINI_API_KEY is required but not set or not ready.\n" +
      "Set GEMINI_API_KEY in your .env file and retry.\n",
    );
    process.exit(1);
  }

  // Models: only enabled models whose provider adapter is ready (chat surfaces)
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

  // Phase 4 T16 / ICS-01: wire v1-b surface adapters via shared helper.
  //
  // wireSurfaces pulls all non-chat (SERP/scrape) surface adapters from the
  // unified registry, applies surface selection rules (drop not_configured,
  // drop scrape on baseline), and returns the eligible surface model refs +
  // adapter map entries to merge into the plan.
  //
  // Baseline runs: only ready SERP surfaces (scrape excluded by wireSurfaces).
  // Operating runs: ready SERP + ready scrape surfaces.
  const { surfaceModels, surfaceAdapters } = wireSurfaces({
    registryAdapters: registry.all(),
    runKind: "baseline",  // diagnose CLI always runs the baseline path
  });

  // Merge surface adapters into the existing adapters map.
  for (const [key, adapter] of surfaceAdapters) {
    adapters.set(key, adapter);
  }

  const models: ModelRef[] = [...chatModels, ...surfaceModels];

  log.info(
    { chatModelCount: chatModels.length, surfaceModelCount: surfaceModels.length, modelCount: models.length },
    "diagnose: ready models (chat + surfaces)",
  );

  // 10. Build cost reader (wraps repo.sumCostSince)
  const costReader = {
    getRollingSpendUsd: async (cid: string, windowDays: number): Promise<number | null> => {
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
      return repo.sumCostSince(cid, since);
    },
  };

  // 11. Build ledger
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

  // 12. Build cache query functions (CacheQueryFns interface: findByHash + upsert)
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

  // 13. Gates (measurement phase only — evidenceRequiredGate at minimum)
  const gates = [evidenceRequiredGate];

  // 14. Inline response handler (synchronous path for baseline)
  const responseRunHandler: RunCycleDeps["responseRunHandler"] = async (payload, runResponseDeps) => {
    await runResponse(payload, runResponseDeps);
  };

  // 15. Build RunCycleDeps
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
    gates,
    isNewCustomer: !hasPriorCall,
    currentCycleIndex: 0,
  };

  // 16. Execute the baseline cycle
  log.info({ customerId, customerSlug }, "diagnose: executing baseline runCycle");
  const report = await runCycle(
    { customerId, kind: "baseline" },
    deps,
  );

  if (!report) {
    process.stderr.write(
      "diagnose: runCycle returned null (run may be over_budget or empty plan). " +
      "Check the logs above.\n",
    );
    process.exit(1);
  }

  // 17. Print report JSON to stdout
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  log.info({ runId: report.runId, smr: report.smr.value }, "diagnose: done");
}

main().catch((err) => {
  process.stderr.write(`diagnose: fatal error: ${String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
