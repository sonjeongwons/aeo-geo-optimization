/**
 * src/config/loadTemplate.ts
 *
 * Load, validate, and upsert a customer YAML template into the database.
 *
 * Steps:
 *   1. Read the YAML file from disk
 *   2. Parse with js-yaml
 *   3. Validate with CustomerTemplateSchema (ZodError on invalid input)
 *   4. Upsert rows in order: customer → brand → competitors → questions →
 *      customer_language → budget → model seed rows
 *
 * All upserts are idempotent — re-running loadTemplate() for the same slug
 * is safe (ON CONFLICT DO UPDATE semantics in repo.ts).
 *
 * Seed model rows:
 *   The model table must contain the Gemini rows before any run can start.
 *   loadTemplate seeds them here so that a bare `npm run diagnose` works
 *   without a separate seed script.
 *
 * Gemini model pricing (from official Gemini API pricing as of 2025-06):
 *   gemini-2.5-flash          $0.30/M input  $1.00/M output  (judge + generation baseline)
 *   gemini-flash-lite-latest  $0.10/M input  $0.40/M output  (cheap monitor for operating +
 *                                                             DEFAULT_JUDGE_MODEL). "-latest"
 *                                                             alias, not a pinned dated id —
 *                                                             Google deprecated the pinned
 *                                                             "gemini-2.5-flash-lite" id for
 *                                                             new projects/accounts (2026-09).
 *   gemini-2.5-pro            $3.50/M input  $10.50/M output (judge escalation only)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { parseCustomerTemplate } from './template.schema.js';
import type { CustomerTemplate } from './template.schema.js';
import {
  upsertCustomer,
  upsertBrand,
  upsertCompetitor,
  upsertQuestion,
  upsertCustomerLanguage,
  upsertBudget,
  upsertModel,
} from '../db/repo.js';

// ---------------------------------------------------------------------------
// Canonical Gemini model seed rows
// All three models must exist in the model table before any run.
// ---------------------------------------------------------------------------

interface ModelSeed {
  id: string;
  provider: string;
  isCheapMonitor: boolean;
  isJudge: boolean;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  enabled: boolean;
}

const GEMINI_MODEL_SEEDS: ModelSeed[] = [
  {
    // Default judge + baseline generation model
    id: 'gemini-2.5-flash',
    provider: 'gemini',
    isCheapMonitor: false,
    isJudge: true,
    inputUsdPerMtok: 0.30,
    outputUsdPerMtok: 1.00,
    enabled: true,
  },
  {
    // Cheap monitor — default for operating cycle generation + the real
    // DEFAULT_JUDGE_MODEL (llmJudge.ts). "-latest" alias, not a pinned dated
    // id — see the pricing comment above.
    id: 'gemini-flash-lite-latest',
    provider: 'gemini',
    isCheapMonitor: true,
    isJudge: true,
    inputUsdPerMtok: 0.10,
    outputUsdPerMtok: 0.40,
    enabled: true,
  },
  {
    // Pro escalation — judge only, on parse failure
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    isCheapMonitor: false,
    isJudge: true,
    inputUsdPerMtok: 3.50,
    outputUsdPerMtok: 10.50,
    enabled: true,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a customer YAML file, validate it, and upsert all related DB rows.
 *
 * @param filePath - absolute or relative path to the YAML file
 * @returns the validated CustomerTemplate (useful for chaining / testing)
 */
export async function loadTemplate(filePath: string): Promise<CustomerTemplate> {
  const absolutePath = resolve(filePath);

  // 1. Read + parse YAML
  const raw = readFileSync(absolutePath, 'utf-8');
  const parsed = yamlLoad(raw);

  // 2. Validate with Zod (throws ZodError with clear message on invalid input)
  const template = parseCustomerTemplate(parsed);

  // 3. Upsert DB rows
  await upsertTemplateToDb(template);

  return template;
}

/**
 * Load a customer template from a pre-parsed object (useful for testing and
 * for the CLI genTemplate flow where we already have the object in memory).
 *
 * @param data - raw (unknown) object to validate and upsert
 * @returns the validated CustomerTemplate
 */
export async function loadTemplateFromObject(data: unknown): Promise<CustomerTemplate> {
  const template = parseCustomerTemplate(data);
  await upsertTemplateToDb(template);
  return template;
}

// ---------------------------------------------------------------------------
// Internal: DB upsert sequence
// ---------------------------------------------------------------------------

/**
 * Perform all upsert operations for a validated template.
 * Order matters (FK dependencies):
 *   customer → brand, competitor, customer_language, budget
 *   customer → question (after customer exists)
 *   model (global, no FK to customer)
 */
async function upsertTemplateToDb(template: CustomerTemplate): Promise<void> {
  // ---- 1. Customer ----
  const customer = await upsertCustomer(template.slug);
  const customerId = customer.id;

  // ---- 2. Brand ----
  await upsertBrand({
    customerId,
    name: template.brand.name,
    aliases: template.brand.aliases,
  });

  // ---- 3. Competitors ----
  for (const comp of template.competitors) {
    await upsertCompetitor({
      customerId,
      name: comp.name,
      aliases: comp.aliases,
    });
  }

  // ---- 4. Questions ----
  for (const q of template.questions) {
    await upsertQuestion({
      customerId,
      text: q.text,
      language: q.language,
      funnelStage: q.funnel_stage ?? null,
      densityTier: q.density_tier,
      active: true,
    });
  }

  // ---- 5. Customer Languages ----
  for (const lang of template.languages) {
    await upsertCustomerLanguage({
      customerId,
      language: lang.code,
      weight: lang.weight,
    });
  }

  // ---- 6. Budget ----
  await upsertBudget({
    customerId,
    maxModels: template.budget.max_models,
    maxSamples: template.budget.max_samples,
    maxLanguages: template.budget.max_languages,
    weeklyUsdCap: template.budget.weekly_usd_cap,
    monthlyUsdCap: template.budget.monthly_usd_cap,
  });

  // ---- 7. Seed Gemini model rows (global, idempotent) ----
  for (const m of GEMINI_MODEL_SEEDS) {
    await upsertModel(m);
  }
}

// ---------------------------------------------------------------------------
// CLI helper: load all templates under config/customers/
// ---------------------------------------------------------------------------

/**
 * Load all *.yaml files from the default config/customers/ directory.
 * Used by the CLI seed script and diagnose command.
 *
 * @param customersDir - path to the directory containing customer YAML files
 *                       (defaults to config/customers relative to cwd)
 * @returns array of loaded + validated templates
 */
export async function loadAllTemplates(
  customersDir = 'config/customers',
): Promise<CustomerTemplate[]> {
  const { readdirSync } = await import('node:fs');
  const dir = resolve(customersDir);

  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  const templates: CustomerTemplate[] = [];
  for (const file of files) {
    const template = await loadTemplate(resolve(dir, file));
    templates.push(template);
  }

  return templates;
}
