/**
 * src/cli/reviewTemplate.ts
 *
 * T19 — CLI: review-template lifecycle (draft->reviewed->active, version-on-edit)
 *
 * Usage:
 *   npm run review-template -- --id <uuid> --action reviewed|active --by <email>
 *   npm run review-template -- --id <uuid> --action edit --file <path.json> [--by <email>]
 *
 * Actions:
 *   reviewed  — Transition status from 'draft' to 'reviewed'; stamp reviewer identity.
 *               Refuses if the current status is not 'draft'.
 *
 *   active    — Transition status from 'reviewed' to 'active'.
 *               REFUSES if the current status is 'draft' (structural §5.5 gate).
 *               Requires reviewed -> active (two-step promotion is mandatory).
 *               Inside ONE transaction:
 *                 1. Demote the currently ACTIVE template for the same industry to 'reviewed'.
 *                 2. Set this template to 'active'.
 *               Then invokes materialize() to emit the authoritative YAML + DB rows.
 *
 *   edit      — Import an edited JSONB file as a NEW draft row (version = max+1).
 *               NEVER mutates an existing row — active/reviewed rows are immutable.
 *               Re-validates the payload against QuestionSchema/CompetitorSchema
 *               before inserting the new draft.
 *
 * Re-validation:
 *   Every payload is validated against QuestionSchema (canonical 4-field subset)
 *   and CompetitorSchema on import AND on every status transition.  A bad
 *   density_tier / language fails at review time, not at materialize time.
 *
 * Materialize:
 *   On `--action active` the CLI invokes materialize() which emits
 *   config/customers/<slug>.yaml and calls loadTemplate() to upsert DB rows.
 *   The --by identity is stored in reviewed_by on the activated row.
 *
 * Immutability:
 *   The `edit` flow creates a NEW draft row (version bump).  The original row
 *   is never touched.  Active and reviewed rows are structurally immutable —
 *   only their STATUS field transitions (reviewed_by / reviewed_at stamped).
 *
 * DESIGN-phase1.md §"Industry-Template Store & Lifecycle", T19.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QuestionSchema, CompetitorSchema } from '../config/template.schema.js';

// ---------------------------------------------------------------------------
// Types for injectable ports (enables testing without pg/kysely)
// ---------------------------------------------------------------------------

/** Minimal industry_template row for reviewer operations. */
export interface TemplateRow {
  id: string;
  industry: string;
  version: number;
  status: 'draft' | 'reviewed' | 'active';
  questions: unknown;
  competitors: unknown;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  source_url?: string | null;
  customer_slug?: string | null;
  generated_total?: number | null;
}

/** Minimal context for materialize() invocation. */
export interface MaterializeCtx {
  slug: string;
  brandName: string;
  brandAliases?: string[];
  languages?: Array<{ code: string; weight: number }>;
  budget?: {
    max_models?: number;
    max_samples?: number;
    max_languages?: number;
    weekly_usd_cap?: number;
    monthly_usd_cap?: number;
  };
  outputDir?: string;
}

/**
 * Repo port — injectable for testing (avoids pg/kysely in unit tests).
 */
export interface ReviewRepo {
  getIndustryTemplate(id: string): Promise<TemplateRow | null>;
  updateTemplateStatus(
    id: string,
    status: 'draft' | 'reviewed' | 'active',
    reviewedBy?: string,
  ): Promise<void>;
  demoteActiveTemplate(industry: string): Promise<void>;
  nextTemplateVersion(industry: string): Promise<number>;
  insertIndustryTemplate(t: {
    industry: string;
    version?: number;
    questions: unknown;
    competitors: unknown;
    status?: 'draft' | 'reviewed' | 'active';
  }): Promise<{ id: string }>;
  /**
   * Run fn inside a single DB transaction.
   * fn receives a transaction-bound repo so that demoteActiveTemplate and
   * updateTemplateStatus execute on the SAME connection as the transaction,
   * making demote+activate truly atomic (TLI-01 fix).
   */
  withTransaction(fn: (txRepo: ReviewRepo) => Promise<void>): Promise<void>;
}

/**
 * Materialize port — injectable for testing.
 */
export interface MaterializePort {
  materialize(
    row: TemplateRow,
    ctx: MaterializeCtx,
  ): Promise<{ yamlPath: string; questionCount: number; competitorCount: number }>;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown when a status transition is invalid (e.g. active-from-draft). */
export class InvalidStatusTransitionError extends Error {
  constructor(
    public readonly id: string,
    public readonly currentStatus: string,
    public readonly requestedAction: string,
  ) {
    super(
      `review-template: cannot perform action '${requestedAction}' on template ${id} ` +
        `whose current status is '${currentStatus}'.`,
    );
    this.name = 'InvalidStatusTransitionError';
  }
}

/** Thrown when the payload (questions/competitors) fails schema validation. */
export class PayloadValidationError extends Error {
  constructor(message: string) {
    super(`review-template: payload validation failed — ${message}`);
    this.name = 'PayloadValidationError';
  }
}

/** Thrown when a required CLI arg is missing. */
export class MissingArgError extends Error {
  constructor(message: string) {
    super(`review-template: ${message}`);
    this.name = 'MissingArgError';
  }
}

// ---------------------------------------------------------------------------
// JSONB validation (re-used on import and on transition)
// ---------------------------------------------------------------------------

/**
 * Validate the questions JSONB payload (canonical 4-field subset for every
 * entry).  Throws PayloadValidationError on any invalid entry.
 */
export function validateQuestionsPayload(questions: unknown): void {
  if (!Array.isArray(questions)) {
    throw new PayloadValidationError(
      `questions must be a JSON array, got ${typeof questions}`,
    );
  }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as Record<string, unknown>;
    const subset = {
      text: q['text'],
      language: q['language'],
      funnel_stage: q['funnel_stage'] ?? null,
      density_tier: q['density_tier'],
    };

    const result = QuestionSchema.safeParse(subset);
    if (!result.success) {
      throw new PayloadValidationError(
        `questions[${i}] failed QuestionSchema: ${result.error.message} ` +
          `(text="${String(q['text'])}", language="${String(q['language'])}")`,
      );
    }
  }
}

/**
 * Validate the competitors JSONB payload.
 * Throws PayloadValidationError on any invalid entry.
 */
export function validateCompetitorsPayload(competitors: unknown): void {
  if (!Array.isArray(competitors)) {
    throw new PayloadValidationError(
      `competitors must be a JSON array, got ${typeof competitors}`,
    );
  }

  for (let i = 0; i < competitors.length; i++) {
    const c = competitors[i] as Record<string, unknown>;
    const candidate = {
      name: c['name'],
      aliases: Array.isArray(c['aliases']) ? c['aliases'] : [],
    };

    const result = CompetitorSchema.safeParse(candidate);
    if (!result.success) {
      throw new PayloadValidationError(
        `competitors[${i}] failed CompetitorSchema: ${result.error.message} ` +
          `(name="${String(c['name'])}")`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Action implementations (all exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Transition a template from 'draft' to 'reviewed'.
 *
 * Pre-conditions:
 *   - Template exists with the given id.
 *   - Current status MUST be 'draft'.
 *   - `by` (reviewer email) is required.
 *
 * Side effects:
 *   - Re-validates the questions/competitors payload (fail-fast at review time).
 *   - Calls repo.updateTemplateStatus(id, 'reviewed', by).
 *
 * @returns The updated template (status='reviewed').
 */
export async function actionReviewed(
  id: string,
  by: string,
  repo: ReviewRepo,
): Promise<{ templateId: string; industry: string; version: number }> {
  const row = await repo.getIndustryTemplate(id);
  if (!row) {
    throw new Error(`review-template: template not found: ${id}`);
  }

  if (row.status !== 'draft') {
    throw new InvalidStatusTransitionError(id, row.status, 'reviewed');
  }

  // Re-validate payload at review time so bad density_tier/language fails here.
  validateQuestionsPayload(row.questions);
  validateCompetitorsPayload(row.competitors);

  await repo.updateTemplateStatus(id, 'reviewed', by);

  return { templateId: id, industry: row.industry, version: row.version };
}

/**
 * Transition a template from 'reviewed' to 'active'.
 *
 * Pre-conditions:
 *   - Template exists with the given id.
 *   - Current status MUST be 'reviewed' (refuse if 'draft' — §5.5 structural gate).
 *   - `by` (activator email) is required for the audit trail.
 *
 * Side effects (inside ONE transaction):
 *   1. Demote the currently ACTIVE template for the same industry to 'reviewed'.
 *   2. Set this template to 'active', stamping reviewed_by = by.
 *
 * Then (outside the transaction):
 *   3. Invokes materializePort.materialize() with context derived from the template.
 *
 * @param materializeCtx  — Customer context for YAML emission.  If not supplied, a
 *   minimal default context is derived from the template's customer_slug / industry.
 * @returns Materialize result metadata.
 */
export async function actionActive(
  id: string,
  by: string,
  repo: ReviewRepo,
  materializePort: MaterializePort,
  materializeCtx?: MaterializeCtx,
): Promise<{
  templateId: string;
  industry: string;
  version: number;
  yamlPath: string;
  questionCount: number;
  competitorCount: number;
}> {
  const row = await repo.getIndustryTemplate(id);
  if (!row) {
    throw new Error(`review-template: template not found: ${id}`);
  }

  // §5.5 STRUCTURAL GATE: refuse active-directly-from-draft
  if (row.status === 'draft') {
    throw new InvalidStatusTransitionError(id, row.status, 'active');
  }

  if (row.status !== 'reviewed') {
    throw new InvalidStatusTransitionError(id, row.status, 'active');
  }

  // Re-validate payload before activation (fail-fast)
  validateQuestionsPayload(row.questions);
  validateCompetitorsPayload(row.competitors);

  // Atomic transaction: demote prior active -> promote this one.
  // txRepo is bound to the transaction connection so both calls execute
  // inside the SAME transaction (TLI-01 fix: was calling global repo).
  await repo.withTransaction(async (txRepo) => {
    await txRepo.demoteActiveTemplate(row.industry);
    await txRepo.updateTemplateStatus(id, 'active', by);
  });

  // Fetch updated row after the transaction
  const activeRow = await repo.getIndustryTemplate(id);
  if (!activeRow) {
    throw new Error(`review-template: template vanished after activation: ${id}`);
  }

  // Build materialize context from what we know
  const ctx = materializeCtx ?? buildDefaultMaterializeCtx(activeRow);

  // Invoke materialize (emits YAML + loadTemplate upserts)
  const materializeResult = await materializePort.materialize(activeRow, ctx);

  return {
    templateId: id,
    industry: row.industry,
    version: row.version,
    ...materializeResult,
  };
}

/**
 * Build a minimal MaterializeCtx from an industry_template row.
 * Used when the caller does not supply explicit context.
 *
 * The slug is derived from customer_slug (if set) or the industry key.
 * The brand name is a placeholder that the reviewer must correct if needed.
 *
 * Languages are derived from the DISTINCT `language` values present in the
 * questions JSONB (TLI-03 fix: avoids silently collapsing multilingual
 * questions to English-only when no explicit ctx.languages is given).
 * Weights come from briefSnapshot.detectedLanguages if carried; otherwise
 * equal weight (1.0) is assigned to each distinct language.
 */
function buildDefaultMaterializeCtx(row: TemplateRow): MaterializeCtx {
  const slug = row.customer_slug ?? row.industry.replace(/[^a-z0-9-]/g, '-');

  // Extract languages from the questions JSONB
  const languages = deriveLanguagesFromQuestions(row.questions);

  const ctx: MaterializeCtx = {
    slug,
    brandName: slug, // placeholder; reviewer supplies real brand in production
  };
  if (languages.length > 0) {
    ctx.languages = languages;
  }
  return ctx;
}

/**
 * Derive a languages list from an industry_template.questions JSONB value.
 *
 * Extracts distinct language codes from all question entries, then looks for
 * weight hints in briefSnapshot.detectedLanguages (if any question carries them).
 * Falls back to equal weight 1.0 for each language when no weight hint is found.
 *
 * Returns [] when the questions array is absent or malformed (caller falls
 * back to materialize's own default).
 */
function deriveLanguagesFromQuestions(
  questions: unknown,
): Array<{ code: string; weight: number }> {
  if (!Array.isArray(questions)) return [];

  // Collect distinct language codes in insertion order
  const seenCodes = new Set<string>();
  const languageOrder: string[] = [];

  // Also try to pick up weight hints from briefSnapshot.detectedLanguages
  // (set by assembleTemplate/diagnose when it writes the JSONB).
  const weightHints = new Map<string, number>();

  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;

    const lang = (q as Record<string, unknown>)['language'];
    if (typeof lang === 'string' && lang.length > 0 && !seenCodes.has(lang)) {
      seenCodes.add(lang);
      languageOrder.push(lang);
    }

    // Attempt to read detectedLanguages from briefSnapshot if carried
    const bs = (q as Record<string, unknown>)['briefSnapshot'];
    if (bs && typeof bs === 'object') {
      const dl = (bs as Record<string, unknown>)['detectedLanguages'];
      if (Array.isArray(dl)) {
        for (const entry of dl) {
          if (
            entry &&
            typeof entry === 'object' &&
            typeof (entry as Record<string, unknown>)['code'] === 'string' &&
            typeof (entry as Record<string, unknown>)['weight'] === 'number' &&
            !weightHints.has((entry as Record<string, unknown>)['code'] as string)
          ) {
            weightHints.set(
              (entry as Record<string, unknown>)['code'] as string,
              (entry as Record<string, unknown>)['weight'] as number,
            );
          }
        }
      }
    }
  }

  return languageOrder.map((code) => ({
    code,
    weight: weightHints.get(code) ?? 1.0,
  }));
}

/**
 * Import an edited JSONB file as a NEW draft version.
 *
 * Reads `filePath`, parses it as JSON, re-validates questions/competitors,
 * and inserts a new row with version = nextTemplateVersion(industry).
 *
 * The original row (active/reviewed) is NEVER touched — append-only.
 *
 * @param id        — The ID of the existing template to fork a new version from.
 * @param filePath  — Path to the JSON file with the edited payload.
 * @param by        — Optional reviewer identity (advisory, stored nowhere in this step).
 * @param repo      — Repository port.
 * @returns The new draft row's ID and version number.
 */
export async function actionEdit(
  id: string,
  filePath: string,
  repo: ReviewRepo,
  _by?: string,
): Promise<{
  newTemplateId: string;
  industry: string;
  newVersion: number;
}> {
  // Load the existing template for its industry key and version baseline
  const existing = await repo.getIndustryTemplate(id);
  if (!existing) {
    throw new Error(`review-template: template not found: ${id}`);
  }

  // Read and parse the edited payload from the file
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `review-template: could not read edit file '${filePath}': ${String(err)}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `review-template: '${filePath}' is not valid JSON: ${String(err)}`,
    );
  }

  // The file may be either a full {questions, competitors} envelope or
  // just the questions array for convenience.
  let questions: unknown;
  let competitors: unknown;

  if (
    typeof payload === 'object' &&
    payload !== null &&
    ('questions' in payload || 'competitors' in payload)
  ) {
    // Envelope shape: { questions: [...], competitors: [...] }
    const env = payload as Record<string, unknown>;
    questions = env['questions'] ?? existing.questions;
    competitors = env['competitors'] ?? existing.competitors;
  } else if (Array.isArray(payload)) {
    // Plain array: treat as the questions array; keep existing competitors
    questions = payload;
    competitors = existing.competitors;
  } else {
    throw new PayloadValidationError(
      `edit file must be a JSON object with { questions, competitors } or a questions array`,
    );
  }

  // Re-validate the payload before inserting the new draft
  validateQuestionsPayload(questions);
  validateCompetitorsPayload(competitors);

  // Get the next version number for this industry
  const newVersion = await repo.nextTemplateVersion(existing.industry);

  // Insert the new draft row (never touch the existing row)
  const { id: newTemplateId } = await repo.insertIndustryTemplate({
    industry: existing.industry,
    version: newVersion,
    questions,
    competitors,
    status: 'draft',
  });

  return {
    newTemplateId,
    industry: existing.industry,
    newVersion,
  };
}

// ---------------------------------------------------------------------------
// Production repo implementation (lazy imports)
// ---------------------------------------------------------------------------

/**
 * Build the production ReviewRepo using lazy DB imports.
 * This avoids importing pg/kysely at module load time so that
 * tests injecting a stub repo work in the ESM sandbox.
 */
function makeProductionRepo(): ReviewRepo {
  return {
    async getIndustryTemplate(id: string) {
      const { getIndustryTemplate } = await import('../db/repo.js');
      return getIndustryTemplate(id);
    },

    async updateTemplateStatus(id, status, reviewedBy) {
      const { updateTemplateStatus } = await import('../db/repo.js');
      return updateTemplateStatus(id, status, reviewedBy);
    },

    async demoteActiveTemplate(industry) {
      const { demoteActiveTemplate } = await import('../db/repo.js');
      return demoteActiveTemplate(industry);
    },

    async nextTemplateVersion(industry) {
      const { nextTemplateVersion } = await import('../db/repo.js');
      return nextTemplateVersion(industry);
    },

    async insertIndustryTemplate(t) {
      const { insertIndustryTemplate } = await import('../db/repo.js');
      return insertIndustryTemplate(t);
    },

    async withTransaction(fn) {
      // Use Kysely's transaction API for atomic demote+activate.
      // We build a minimal txRepo that calls demoteActiveTemplate /
      // updateTemplateStatus with the TRANSACTION executor so both
      // operations execute inside the SAME connection (TLI-01 fix).
      const { getDb } = await import('../db/kysely.js');
      await getDb().transaction().execute(async (trx) => {
        const txRepo: ReviewRepo = {
          // Reads and writes not involved in the demote+activate sequence
          // can safely delegate to the outer production repo (getIndustryTemplate,
          // nextTemplateVersion, insertIndustryTemplate).  Only the two mutating
          // helpers that must be atomic are bound to trx.
          async getIndustryTemplate(id: string) {
            const { getIndustryTemplate } = await import('../db/repo.js');
            return getIndustryTemplate(id);
          },
          async updateTemplateStatus(id, status, reviewedBy) {
            const { updateTemplateStatus } = await import('../db/repo.js');
            return updateTemplateStatus(id, status, reviewedBy, trx as never);
          },
          async demoteActiveTemplate(industry) {
            const { demoteActiveTemplate } = await import('../db/repo.js');
            return demoteActiveTemplate(industry, trx as never);
          },
          async nextTemplateVersion(industry) {
            const { nextTemplateVersion } = await import('../db/repo.js');
            return nextTemplateVersion(industry);
          },
          async insertIndustryTemplate(t) {
            const { insertIndustryTemplate } = await import('../db/repo.js');
            return insertIndustryTemplate(t);
          },
          async withTransaction(innerFn) {
            // Nested transactions are not supported; just run the fn with self.
            await innerFn(txRepo);
          },
        };
        await fn(txRepo);
      });
    },
  };
}

/**
 * Build the production MaterializePort.
 */
function makeProductionMaterializePort(): MaterializePort {
  return {
    async materialize(row, ctx) {
      const { materialize } = await import('../generate/materialize.js');
      return materialize(row, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  id: string | undefined;
  action: 'reviewed' | 'active' | 'edit' | undefined;
  by: string | undefined;
  file: string | undefined;
  /** Optional explicit slug for materialize context */
  slug: string | undefined;
  /** Optional brand name for materialize context */
  brand: string | undefined;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);

  let id: string | undefined;
  let action: 'reviewed' | 'active' | 'edit' | undefined;
  let by: string | undefined;
  let file: string | undefined;
  let slug: string | undefined;
  let brand: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    if ((flag === '--id') && next && !next.startsWith('-')) {
      id = next;
      i++;
    } else if ((flag === '--action' || flag === '-a') && next && !next.startsWith('-')) {
      const raw = next;
      if (raw === 'reviewed' || raw === 'active' || raw === 'edit') {
        action = raw;
      } else {
        process.stderr.write(
          `review-template: unknown action '${raw}'; expected reviewed|active|edit\n`,
        );
        process.exit(1);
      }
      i++;
    } else if ((flag === '--by' || flag === '-b') && next && !next.startsWith('-')) {
      by = next;
      i++;
    } else if ((flag === '--file' || flag === '-f') && next && !next.startsWith('-')) {
      file = next;
      i++;
    } else if (flag === '--slug' && next && !next.startsWith('-')) {
      slug = next;
      i++;
    } else if (flag === '--brand' && next && !next.startsWith('-')) {
      brand = next;
      i++;
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(
        'Usage: npm run review-template -- --id <uuid> --action reviewed|active|edit --by <email>\n\n' +
          'Actions:\n' +
          '  reviewed  Transition template from draft to reviewed (--by required)\n' +
          '  active    Transition template from reviewed to active (--by required)\n' +
          '            Refuses if current status is draft (structural §5.5 gate).\n' +
          '            Demotes any existing active template for the same industry.\n' +
          '            Then invokes materialize() to emit the YAML + upsert DB rows.\n' +
          '  edit      Import edited JSONB as a NEW draft version (--file required)\n' +
          '            Never mutates the existing row (append-only history).\n\n' +
          'Options:\n' +
          '  --id, -i      Template UUID (required)\n' +
          '  --action, -a  Action to perform: reviewed | active | edit\n' +
          '  --by, -b      Reviewer / activator email (required for reviewed + active)\n' +
          '  --file, -f    Path to JSON file with edited payload (required for edit)\n' +
          '  --slug        Customer slug for materialize context (optional, for active)\n' +
          '  --brand       Brand name for materialize context (optional, for active)\n' +
          '  --help, -h    Show this help\n',
      );
      process.exit(0);
    }
  }

  return { id, action, by, file, slug, brand };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { id, action, by, file, slug, brand } = parseArgs();

  // ---- Validate required args -----------------------------------------------
  if (!id) {
    process.stderr.write(
      'review-template: --id <uuid> is required.\n' +
        'Usage: npm run review-template -- --id <uuid> --action reviewed|active|edit\n',
    );
    process.exit(1);
  }

  if (!action) {
    process.stderr.write(
      'review-template: --action reviewed|active|edit is required.\n' +
        'Usage: npm run review-template -- --id <uuid> --action reviewed|active|edit\n',
    );
    process.exit(1);
  }

  const repo = makeProductionRepo();
  const materializePort = makeProductionMaterializePort();

  try {
    switch (action) {
      case 'reviewed': {
        if (!by) {
          process.stderr.write(
            'review-template: --by <email> is required for --action reviewed.\n',
          );
          process.exit(1);
        }

        const result = await actionReviewed(id, by, repo);

        process.stdout.write(
          JSON.stringify(
            {
              action: 'reviewed',
              templateId: result.templateId,
              industry: result.industry,
              version: result.version,
              reviewedBy: by,
              status: 'reviewed',
            },
            null,
            2,
          ) + '\n',
        );

        process.stderr.write(
          `[review-template] Template ${id} v${result.version} (${result.industry}) ` +
            `transitioned draft -> reviewed by ${by}\n`,
        );
        break;
      }

      case 'active': {
        if (!by) {
          process.stderr.write(
            'review-template: --by <email> is required for --action active.\n',
          );
          process.exit(1);
        }

        // Build materialize context from optional CLI args or let actionActive derive it
        let materializeCtx: MaterializeCtx | undefined;
        if (slug || brand) {
          // Load the row to get any missing context
          const previewRow = await repo.getIndustryTemplate(id);
          materializeCtx = {
            slug: slug ?? (previewRow?.customer_slug ?? previewRow?.industry ?? id),
            brandName: brand ?? slug ?? (previewRow?.customer_slug ?? previewRow?.industry ?? id),
          };
        }

        const result = await actionActive(id, by, repo, materializePort, materializeCtx);

        process.stdout.write(
          JSON.stringify(
            {
              action: 'active',
              templateId: result.templateId,
              industry: result.industry,
              version: result.version,
              activatedBy: by,
              status: 'active',
              yamlPath: result.yamlPath,
              questionCount: result.questionCount,
              competitorCount: result.competitorCount,
            },
            null,
            2,
          ) + '\n',
        );

        process.stderr.write(
          `[review-template] Template ${id} v${result.version} (${result.industry}) ` +
            `transitioned reviewed -> active by ${by}\n` +
            `[review-template] YAML emitted: ${result.yamlPath}\n` +
            `[review-template] ${result.questionCount} questions, ${result.competitorCount} competitors materialized\n`,
        );
        break;
      }

      case 'edit': {
        if (!file) {
          process.stderr.write(
            'review-template: --file <path> is required for --action edit.\n',
          );
          process.exit(1);
        }

        const result = await actionEdit(id, file, repo, by);

        process.stdout.write(
          JSON.stringify(
            {
              action: 'edit',
              sourceTemplateId: id,
              newTemplateId: result.newTemplateId,
              industry: result.industry,
              newVersion: result.newVersion,
              status: 'draft',
              note: 'A new draft version was created. The original row was not modified.',
            },
            null,
            2,
          ) + '\n',
        );

        process.stderr.write(
          `[review-template] New draft v${result.newVersion} created for industry '${result.industry}'\n` +
            `[review-template] New template ID: ${result.newTemplateId}\n` +
            `[review-template] Source template ${id} was NOT modified (append-only).\n`,
        );
        break;
      }

      default: {
        const _: never = action;
        process.stderr.write(`review-template: unknown action: ${String(_)}\n`);
        process.exit(1);
      }
    }
  } catch (err) {
    if (err instanceof InvalidStatusTransitionError) {
      process.stderr.write(`review-template: ${err.message}\n`);
      process.exit(1);
    }
    if (err instanceof PayloadValidationError) {
      process.stderr.write(`review-template: ${err.message}\n`);
      process.exit(1);
    }
    if (err instanceof Error) {
      process.stderr.write(`review-template: error: ${err.message}\n`);
      if (err.stack) {
        process.stderr.write(err.stack + '\n');
      }
    } else {
      process.stderr.write(`review-template: unknown error: ${String(err)}\n`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// ESM main-module guard: only invoke main() when this file is run directly,
// not when it is imported as a module in tests.
//
// In Node 22 ESM + tsx, process.argv[1] is the .ts source path when invoked
// via `tsx src/cli/reviewTemplate.ts`.  We match against the known basenames.
// ---------------------------------------------------------------------------

const _selfUrl = import.meta.url;
const _selfPath = fileURLToPath(_selfUrl);
const _argv1 = process.argv[1] ?? '';

const _isCli =
  _argv1 === _selfPath ||
  _argv1.endsWith('/reviewTemplate.ts') ||
  _argv1.endsWith('\\reviewTemplate.ts') ||
  _argv1.endsWith('/reviewTemplate.js') ||
  _argv1.endsWith('\\reviewTemplate.js');

if (_isCli) {
  main().catch((err: unknown) => {
    process.stderr.write(`review-template: fatal: ${String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    process.exit(1);
  });
}
