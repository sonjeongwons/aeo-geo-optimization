/**
 * src/generate/materialize.ts
 *
 * T16 — Materialize an ACTIVE industry_template into CustomerTemplate +
 * YAML emit + DB upsert via loadTemplate().
 *
 * DESIGN (DESIGN-phase1.md §"Phase 0 Integration"):
 *   An ACTIVE industry_template row is the single source of truth for a
 *   customer's question/competitor configuration.  On activation this
 *   module:
 *
 *     1. Verifies the template's status is 'active' (structural §5.5 gate).
 *     2. Strips questions to the 4 canonical fields {text, language,
 *        funnel_stage, density_tier} (provenance-only fields live in
 *        industry_template.questions JSONB, not in the question table).
 *     3. Builds a full CustomerTemplate object (YAML-compatible shape).
 *     4. Emits ONE authoritative YAML file: config/customers/<slug>.yaml
 *        (overwriting any previous version of the file).
 *     5. Calls loadTemplate(yamlPath) which reads + validates + upserts all
 *        DB rows (customer, brand, competitor, question, budget, language).
 *        This is the SINGLE write path — no separate upsert + re-read.
 *
 * Idempotency:
 *   Re-materializing (calling materialize() on an already-active template
 *   with the same slug) is safe.  loadTemplate() uses ON CONFLICT DO UPDATE
 *   semantics everywhere; the result is identical.
 *
 * §5.5 STRUCTURAL GATE:
 *   materialize() throws MaterializeStatusError when the template's status
 *   is not 'active'.  This is caught by reviewTemplate --action active and
 *   by CLI/API callers — it must NEVER be bypassed.
 *
 * Node 22 ESM NodeNext: all relative imports use .js extension.
 *
 * DESIGN-phase1.md §"Industry-Template Store & Lifecycle",
 * §"Phase 0 Integration", §Key Decisions ("Emit exactly ONE authoritative …").
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { dump as yamlDump } from 'js-yaml';
import { QuestionSchema, CompetitorSchema } from '../config/template.schema.js';
import type { CustomerTemplate } from '../config/template.schema.js';

// ---------------------------------------------------------------------------
// TemplateQuestionRecord shape (matches assembleTemplate.ts JSONB output)
// ---------------------------------------------------------------------------

/**
 * Minimal subset we need to read from industry_template.questions JSONB.
 * Only the 4 canonical fields are required; provenance fields are ignored.
 */
interface JsonbQuestion {
  text: string;
  language: string;
  funnel_stage?: string | null;
  density_tier: 'core' | 'secondary' | 'longtail';
  [key: string]: unknown; // tolerate provenance fields
}

/**
 * Minimal subset for industry_template.competitors JSONB.
 */
interface JsonbCompetitor {
  name: string;
  aliases?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Input: MaterializeContext
// ---------------------------------------------------------------------------

/**
 * Customer context required to build the CustomerTemplate YAML.
 *
 * Fields with sensible defaults may be omitted; materialize() will use
 * the industry_template's embedded data when not explicitly supplied.
 */
export interface MaterializeContext {
  /**
   * Customer slug (e.g. "emora").  Becomes the YAML slug field and the
   * output filename: config/customers/<slug>.yaml.
   */
  slug: string;

  /**
   * The canonical brand name for this customer (e.g. "EMORA").
   * Stored in brand.name in the YAML.
   */
  brandName: string;

  /**
   * Additional brand aliases (transliterations, alternative forms).
   * Defaults to [] when omitted.
   */
  brandAliases?: string[];

  /**
   * Languages to include, with weights.
   * When not supplied, materialize() derives them from the
   * BrandBrief's detectedLanguages (if available) or defaults to
   * [{ code: 'en', weight: 1.0 }].
   */
  languages?: Array<{ code: string; weight: number }>;

  /**
   * Budget caps to embed in the YAML.
   * All fields are optional; unset fields use CustomerTemplateSchema defaults.
   */
  budget?: {
    max_models?: number;
    max_samples?: number;
    max_languages?: number;
    weekly_usd_cap?: number;
    monthly_usd_cap?: number;
  };

  /**
   * Base directory for YAML output.
   * Defaults to 'config/customers' relative to process.cwd().
   */
  outputDir?: string;
}

// ---------------------------------------------------------------------------
// Input: IndustryTemplateRow (minimal read-side type)
// ---------------------------------------------------------------------------

/**
 * The subset of an industry_template row that materialize() needs.
 * Matches the shape returned by repo.getIndustryTemplate().
 */
export interface IndustryTemplateRow {
  id: string;
  industry: string;
  version: number;
  /** MUST be 'active'; materialize() throws otherwise (§5.5 gate). */
  status: 'draft' | 'reviewed' | 'active';
  /** JSONB: array of TemplateQuestionRecord objects. */
  questions: unknown;
  /** JSONB: array of {name, aliases} objects. */
  competitors: unknown;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  source_url?: string | null;
  customer_slug?: string | null;
  generated_total?: number | null;
}

// ---------------------------------------------------------------------------
// Ports (injectable for testing)
// ---------------------------------------------------------------------------

/**
 * Minimal file-system port for YAML emission.
 * Production: uses fs.writeFileSync.
 * Tests: may capture the emitted YAML string without touching the real FS.
 */
export interface FsPort {
  writeFile(path: string, content: string): void;
  mkdirRecursive(dir: string): void;
}

/**
 * Minimal loadTemplate port.
 * Production: calls the REAL loadTemplate(filePath) from loadTemplate.ts.
 * Tests: may stub this to avoid pg/kysely.
 */
export interface LoadTemplatePort {
  loadTemplate(filePath: string): Promise<CustomerTemplate>;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown (not returned) when materialize() is called with a template whose
 * status is not 'active'.  This is the §5.5 structural gate.
 */
export class MaterializeStatusError extends Error {
  constructor(
    public readonly templateId: string,
    public readonly actualStatus: string,
  ) {
    super(
      `materialize(): template ${templateId} has status='${actualStatus}'; ` +
        `only 'active' templates may be materialized (§5.5 structural gate).`,
    );
    this.name = 'MaterializeStatusError';
  }
}

/**
 * Thrown when the JSONB questions or competitors array cannot be parsed
 * into a valid shape.  Indicates a corrupt or manually-edited template.
 */
export class MaterializePayloadError extends Error {
  constructor(message: string) {
    super(`materialize(): invalid JSONB payload — ${message}`);
    this.name = 'MaterializePayloadError';
  }
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result returned by a successful materialize() call.
 */
export interface MaterializeResult {
  /** The validated CustomerTemplate that was emitted as YAML + loaded. */
  customerTemplate: CustomerTemplate;

  /**
   * Absolute path of the emitted YAML file.
   * This is the SINGLE authoritative artifact; DB rows come from reading it.
   */
  yamlPath: string;

  /** Number of questions materialized into the question table. */
  questionCount: number;

  /** Number of competitors materialized into the competitor table. */
  competitorCount: number;
}

// ---------------------------------------------------------------------------
// JSONB parsing helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Parse and validate the industry_template.questions JSONB field.
 * Extracts the 4 canonical fields and discards provenance-only fields.
 *
 * Throws MaterializePayloadError on any structural mismatch.
 */
export function parseJsonbQuestions(
  raw: unknown,
): Array<{ text: string; language: string; funnel_stage: string | null | undefined; density_tier: 'core' | 'secondary' | 'longtail' }> {
  if (!Array.isArray(raw)) {
    throw new MaterializePayloadError(
      `questions must be a JSON array, got ${typeof raw}`,
    );
  }

  const results: Array<{
    text: string;
    language: string;
    funnel_stage: string | null | undefined;
    density_tier: 'core' | 'secondary' | 'longtail';
  }> = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as JsonbQuestion;

    if (!item || typeof item !== 'object') {
      throw new MaterializePayloadError(`questions[${i}] is not an object`);
    }

    // Re-validate the canonical 4-field subset via QuestionSchema
    const canonical = {
      text: item.text,
      language: item.language,
      funnel_stage: item.funnel_stage ?? null,
      density_tier: item.density_tier,
    };

    const parsed = QuestionSchema.safeParse(canonical);
    if (!parsed.success) {
      throw new MaterializePayloadError(
        `questions[${i}] failed QuestionSchema: ${parsed.error.message} ` +
          `(text="${item.text}", language="${item.language}")`,
      );
    }

    results.push({
      text: parsed.data.text,
      language: parsed.data.language,
      funnel_stage: parsed.data.funnel_stage,
      density_tier: parsed.data.density_tier,
    });
  }

  return results;
}

/**
 * Parse and validate the industry_template.competitors JSONB field.
 * Validates each entry against CompetitorSchema.
 *
 * Throws MaterializePayloadError on any structural mismatch.
 */
export function parseJsonbCompetitors(
  raw: unknown,
): Array<{ name: string; aliases: string[] }> {
  if (!Array.isArray(raw)) {
    throw new MaterializePayloadError(
      `competitors must be a JSON array, got ${typeof raw}`,
    );
  }

  const results: Array<{ name: string; aliases: string[] }> = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as JsonbCompetitor;

    if (!item || typeof item !== 'object') {
      throw new MaterializePayloadError(`competitors[${i}] is not an object`);
    }

    const candidate = {
      name: item.name,
      aliases: Array.isArray(item.aliases) ? item.aliases : [],
    };

    const parsed = CompetitorSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new MaterializePayloadError(
        `competitors[${i}] failed CompetitorSchema: ${parsed.error.message} ` +
          `(name="${item.name}")`,
      );
    }

    results.push({
      name: parsed.data.name,
      aliases: parsed.data.aliases,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Language derivation helper (pure)
// ---------------------------------------------------------------------------

/**
 * Derive an ordered, weighted languages list from the canonical parsed
 * questions and the raw JSONB (for weight hints).
 *
 * Algorithm:
 *   1. Collect distinct language codes from parsedQuestions in insertion order.
 *   2. Look for weight hints in briefSnapshot.detectedLanguages embedded in the
 *      raw JSONB questions (written by assembleTemplate/diagnose).
 *   3. Assign equal weight 1.0 to any language without a hint.
 *
 * Exported for testing.
 */
export function deriveLanguagesFromParsedQuestions(
  parsedQuestions: Array<{ language: string }>,
  rawJsonb: unknown,
): Array<{ code: string; weight: number }> {
  // Step 1: collect distinct codes in order of first appearance
  const seenCodes = new Set<string>();
  const languageOrder: string[] = [];

  for (const q of parsedQuestions) {
    if (q.language && !seenCodes.has(q.language)) {
      seenCodes.add(q.language);
      languageOrder.push(q.language);
    }
  }

  if (languageOrder.length === 0) return [];

  // Step 2: extract weight hints from briefSnapshot.detectedLanguages in the
  // raw JSONB (best-effort; malformed entries are silently ignored).
  const weightHints = new Map<string, number>();

  if (Array.isArray(rawJsonb)) {
    for (const item of rawJsonb) {
      if (!item || typeof item !== 'object') continue;
      const bs = (item as Record<string, unknown>)['briefSnapshot'];
      if (!bs || typeof bs !== 'object') continue;
      const dl = (bs as Record<string, unknown>)['detectedLanguages'];
      if (!Array.isArray(dl)) continue;
      for (const entry of dl) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (
          typeof e['code'] === 'string' &&
          typeof e['weight'] === 'number' &&
          !weightHints.has(e['code'])
        ) {
          weightHints.set(e['code'], e['weight']);
        }
      }
    }
  }

  // Step 3: build final list with weights
  return languageOrder.map((code) => ({
    code,
    weight: weightHints.get(code) ?? 1.0,
  }));
}

// ---------------------------------------------------------------------------
// CustomerTemplate builder (pure)
// ---------------------------------------------------------------------------

/**
 * Build a CustomerTemplate object from an industry_template row + context.
 *
 * This is PURE — it performs no IO.
 * The caller is responsible for YAML emission and DB upsert.
 *
 * Exported for testing so callers can inspect the template shape without IO.
 */
export function buildCustomerTemplate(
  row: IndustryTemplateRow,
  ctx: MaterializeContext,
  parsedQuestions: Array<{
    text: string;
    language: string;
    funnel_stage: string | null | undefined;
    density_tier: 'core' | 'secondary' | 'longtail';
  }>,
  parsedCompetitors: Array<{ name: string; aliases: string[] }>,
): CustomerTemplate {
  // Derive languages:
  //   1. Use caller-supplied list when provided and non-empty.
  //   2. Otherwise derive from DISTINCT `language` values in parsedQuestions,
  //      with weight hints from briefSnapshot.detectedLanguages in the raw
  //      JSONB (TLI-03 fix: avoids collapsing multilingual questions to en).
  //   3. Only fall back to [{en,1.0}] when parsedQuestions is empty.
  let languages: Array<{ code: string; weight: number }>;

  if (ctx.languages && ctx.languages.length > 0) {
    languages = ctx.languages;
  } else {
    languages = deriveLanguagesFromParsedQuestions(parsedQuestions, row.questions);
    if (languages.length === 0) {
      // Empty question set — maintain the historical default.
      languages = [{ code: 'en', weight: 1.0 }];
    }
  }

  // Build the CustomerTemplate (matches CustomerTemplateSchema exactly)
  const template: CustomerTemplate = {
    slug: ctx.slug,
    brand: {
      name: ctx.brandName,
      aliases: ctx.brandAliases ?? [],
    },
    competitors: parsedCompetitors,
    languages,
    questions: parsedQuestions.map((q) => ({
      text: q.text,
      language: q.language,
      // funnel_stage is nullable/optional in QuestionSchema
      ...(q.funnel_stage !== undefined && q.funnel_stage !== null
        ? { funnel_stage: q.funnel_stage }
        : { funnel_stage: null }),
      density_tier: q.density_tier,
    })),
    budget: {
      max_models: ctx.budget?.max_models ?? 1,
      max_samples: ctx.budget?.max_samples ?? 5,
      max_languages: ctx.budget?.max_languages ?? languages.length,
      weekly_usd_cap: ctx.budget?.weekly_usd_cap ?? 10,
      monthly_usd_cap: ctx.budget?.monthly_usd_cap ?? 35,
    },
  };

  return template;
}

// ---------------------------------------------------------------------------
// YAML serialization helper (pure)
// ---------------------------------------------------------------------------

/**
 * Serialize a CustomerTemplate to a YAML string.
 *
 * Uses js-yaml's dump() with lineWidth=-1 to avoid long-line wrapping that
 * breaks YAML parsers for CJK content.
 *
 * Exported for testing.
 */
export function serializeTemplateToYaml(template: CustomerTemplate): string {
  // js-yaml's dump() handles all types correctly; lineWidth=-1 disables wrapping.
  return yamlDump(template, {
    lineWidth: -1,
    quotingType: '"',
    forceQuotes: false,
    noRefs: true,
  });
}

// ---------------------------------------------------------------------------
// Production ports
// ---------------------------------------------------------------------------

/**
 * Production FS port using Node.js fs module.
 */
function makeProductionFsPort(): FsPort {
  return {
    writeFile(path: string, content: string): void {
      writeFileSync(path, content, 'utf-8');
    },
    mkdirRecursive(dir: string): void {
      mkdirSync(dir, { recursive: true });
    },
  };
}

/**
 * Production loadTemplate port using the real loadTemplate.ts function.
 * Uses a dynamic import to avoid pulling pg/kysely into test scope.
 */
function makeProductionLoadTemplatePort(): LoadTemplatePort {
  return {
    async loadTemplate(filePath: string): Promise<CustomerTemplate> {
      const { loadTemplate } = await import('../config/loadTemplate.js');
      return loadTemplate(filePath);
    },
  };
}

// ---------------------------------------------------------------------------
// Main export: materialize()
// ---------------------------------------------------------------------------

/**
 * Materialize an ACTIVE industry_template row into the customer configuration.
 *
 * Steps:
 *   1. GATE: Throw MaterializeStatusError if status !== 'active'.
 *   2. PARSE: Extract + re-validate questions/competitors from JSONB.
 *   3. BUILD: Construct a CustomerTemplate from the parsed data + context.
 *   4. EMIT: Write config/customers/<slug>.yaml (single authoritative artifact).
 *   5. LOAD: Call loadTemplate(yamlPath) → upserts all DB rows.
 *
 * The YAML file is the single source of truth; DB rows come exclusively from
 * loadTemplate reading it.  There is no separate upsert path.
 *
 * @param row  - The ACTIVE industry_template row.
 * @param ctx  - Customer context (slug, brand, languages, budget).
 * @param opts - Optional injectable ports (fs, loadTemplate) for testing.
 * @returns MaterializeResult with the CustomerTemplate, YAML path, and counts.
 * @throws MaterializeStatusError if row.status !== 'active'.
 * @throws MaterializePayloadError if JSONB cannot be parsed/validated.
 * @throws ZodError if the constructed template fails CustomerTemplateSchema.
 */
export async function materialize(
  row: IndustryTemplateRow,
  ctx: MaterializeContext,
  opts?: {
    _fs?: FsPort;
    _loadTemplate?: LoadTemplatePort;
  },
): Promise<MaterializeResult> {
  // ---- §5.5 STRUCTURAL GATE ------------------------------------------------
  if (row.status !== 'active') {
    throw new MaterializeStatusError(row.id, row.status);
  }

  // ---- Step 2: Parse JSONB payloads ----------------------------------------
  const parsedQuestions = parseJsonbQuestions(row.questions);
  const parsedCompetitors = parseJsonbCompetitors(row.competitors);

  // ---- Step 3: Build CustomerTemplate (pure) --------------------------------
  const customerTemplate = buildCustomerTemplate(
    row,
    ctx,
    parsedQuestions,
    parsedCompetitors,
  );

  // ---- Step 4: Emit YAML ---------------------------------------------------
  const outputDir = resolve(ctx.outputDir ?? 'config/customers');
  const yamlPath = resolve(outputDir, `${ctx.slug}.yaml`);
  const yamlContent = serializeTemplateToYaml(customerTemplate);

  const fsPort = opts?._fs ?? makeProductionFsPort();
  fsPort.mkdirRecursive(outputDir);
  fsPort.writeFile(yamlPath, yamlContent);

  // ---- Step 5: Load via loadTemplate (single write path) -------------------
  // loadTemplate() reads the YAML we just wrote, validates it, and upserts
  // all DB rows — this is the canonical DB write path, no separate upsert.
  const loadPort = opts?._loadTemplate ?? makeProductionLoadTemplatePort();
  const loadedTemplate = await loadPort.loadTemplate(yamlPath);

  // ---- Return result -------------------------------------------------------
  return {
    customerTemplate: loadedTemplate,
    yamlPath,
    questionCount: parsedQuestions.length,
    competitorCount: parsedCompetitors.length,
  };
}
