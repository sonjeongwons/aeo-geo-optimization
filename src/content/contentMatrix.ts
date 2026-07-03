/**
 * src/content/contentMatrix.ts
 *
 * T06 — ContentMatrix builder (coverage+cost contract).
 *
 * PURE module — no IO, no LLM calls, deterministic.
 *
 * buildContentMatrix(brief, template, caps) → ContentMatrixResult
 *
 * Computes the COMPLETE cartesian {contentType × format × language × channel_class}
 * plan BEFORE any token spend.  This is the coverage+cost contract analogous to
 * buildIntentMatrix for Phase 1 questions.
 *
 * Key design rules:
 *
 * 1. LANGUAGE ALLOCATION — weight-proportional via sortByWeight.
 *    Language weights are reconciled from BrandBrief.detectedLanguages merged
 *    with template.languages (template wins when both supply a language code).
 *    The reconciled list is sorted by weight descending (sortByWeight from
 *    sampling/languageWeight.ts:26) and clamped to caps.maxLanguages (default 18).
 *
 * 2. FORMAT THINNING — high-weight vs low-weight language split.
 *    Languages whose weight is >= the HIGH_WEIGHT_THRESHOLD (relative to the
 *    max weight in the set) get the FULL set of legal formats for each channel.
 *    Low-weight languages get a THINNED format set: definition_sentence +
 *    answer_block only (the cheapest + most broadly legal formats).
 *    This prevents a long tail of low-priority languages consuming the entire
 *    asset budget with exotic formats.
 *
 * 3. CHANNEL CONTENT MATRIX — channelContentMatrix.isFormatLegalOnChannel filters
 *    every (format × channel_class) combination.  JSON-LD formats are only added
 *    for owned_net; comparison_table is excluded from social; etc.
 *
 * 4. PHRASING SEEDS — each cell gets a deterministic phrasingGroupSeed derived from
 *    a hash of the cell coordinates.  This lets the generation prompt produce
 *    distinct phrasings per cell without randomness.
 *
 * 5. OVER-GENERATION — targetVariants per cell = ceil(1 × OVER_GEN_FACTOR) = 2.
 *    Each cell over-generates ~1.3x so the phrasingVariationGate has room to
 *    discard near-duplicates.
 *
 * 6. CLAMP — total cells are clamped to caps.max_content_assets_per_run.
 *    Active formats (distinct format values across all cells) are clamped to
 *    caps.max_formats.  Both caps are applied AFTER the language × channel
 *    expansion, trimming from the lowest-weight-language cells first.
 *
 * 7. PRINTABLE SUMMARY — buildContentMatrix returns a ContentMatrixResult that
 *    includes a human-readable summary string (for CLI genContent to print before
 *    spend) plus the cells array and per-language breakdown.
 *
 * References:
 *   DESIGN-phase2.md §"Variant Pipeline / STAGE A"
 *   SPEC.md §6, §11
 *   phase2-tasks.json T06
 */

import { sortByWeight } from "../sampling/languageWeight.js";
import {
  isFormatLegalOnChannel,
  legalFormatsForChannel,
} from "./channelContentMatrix.js";
import type {
  ChannelClass,
  ContentCell,
  ContentFormat,
  ContentType,
} from "./types.js";
import type { BrandBrief, DetectedLanguage } from "../generate/types.js";
import type { CustomerLanguage } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Over-generation factor: each cell requests ceil(targetVariants * factor).
 * Mirrors OVER_GEN_FACTOR from generateQuestions.ts.
 */
export const OVER_GEN_FACTOR = 1.3;

/**
 * Default number of phrasing variants per cell BEFORE over-generation.
 * Each cell targets 1 canonical variant; over-generated to 2 (ceil(1 × 1.3) = 2).
 */
const BASE_VARIANTS_PER_CELL = 1;

/**
 * Fraction of the max language weight at or above which a language is
 * considered "high-weight" and gets the full format set.
 * Languages below this threshold are "low-weight" and get a thinned set.
 *
 * 0.5 means: any language with weight >= 50% of the top language's weight
 * is high-weight.  Languages with weight < 50% of the top get thinned.
 */
export const HIGH_WEIGHT_THRESHOLD_RATIO = 0.5;

/**
 * The THINNED format set for low-weight languages.
 * Only the simplest, most broadly legal formats are generated.
 */
const LOW_WEIGHT_FORMATS: ContentFormat[] = [
  "definition_sentence",
  "answer_block",
];

/**
 * Full non-JSON-LD format set (JSON-LD is handled separately, owned_net only).
 * Generated for high-weight languages across all legal channels.
 */
// Order = priority when caps.max_formats trims the set (formatsForTierAndChannel
// preserves this order). Research DESIGN-research-aeo-geo.md rank 8 + the 2026
// absorption study: Definition (+57.3%) and Comparison (+55.3%) are the top
// answer-shaping genres while pure Q&A is slightly NEGATIVE (-5.7%) — and
// self-published "alternatives to X"/comparison pages are ~51% of ChatGPT
// citations (DerivateX). So comparison_table is prioritized ABOVE faq_table; FAQ
// is kept last (it belongs as a SECTION within a pillar page, not as the lead format).
const FULL_PROSE_FORMATS: ContentFormat[] = [
  "definition_sentence",
  "answer_block",
  "comparison_table",
  "case_study",
  "faq_table",
];

/**
 * JSON-LD formats (owned_net only, built by jsonld.ts builders, $0 cost).
 * Added to high-weight language + owned_net cells.
 */
const JSONLD_FORMATS: ContentFormat[] = [
  "jsonld_org",
  "jsonld_faqpage",
  "jsonld_article",
];

/**
 * All channel classes (the §8 deploy-channel family).
 * community/review are intentionally omitted (§7#3 structural exclusion).
 */
const ALL_CHANNEL_CLASSES: ChannelClass[] = [
  "owned_net",
  "pr_wire",
  "directory",
  "web2",
  "social",
  "entity",
];

/**
 * Maximum number of languages supported in a single run (18-language capability).
 */
const MAX_SUPPORTED_LANGUAGES = 18;

// ---------------------------------------------------------------------------
// Content type → format mapping (each format implies its content_type)
// ---------------------------------------------------------------------------

/**
 * Maps each ContentFormat to its ContentType.
 * Used to populate the contentType field of each ContentCell.
 */
export const FORMAT_TO_CONTENT_TYPE: Record<ContentFormat, ContentType> = {
  definition_sentence: "definition",
  answer_block: "answer_block",
  faq_table: "faq",
  comparison_table: "comparison",
  case_study: "case_study",
  jsonld_org: "jsonld",
  jsonld_faqpage: "jsonld",
  jsonld_article: "jsonld",
};

// ---------------------------------------------------------------------------
// Caps type
// ---------------------------------------------------------------------------

/**
 * Per-customer content generation caps derived from budget columns.
 * All optional — defaults are applied when absent.
 */
export interface ContentMatrixCaps {
  /**
   * Maximum total ContentCell rows to produce.
   * Cells beyond this cap are trimmed starting from the lowest-weight language.
   * Defaults to 200 when absent.
   */
  max_content_assets_per_run?: number | null;

  /**
   * Maximum number of distinct format values across all cells.
   * When the natural expansion produces more formats than this cap, the
   * lowest-priority formats are excluded.
   * Defaults to 8 (all formats) when absent.
   */
  max_formats?: number | null;

  /**
   * Maximum number of languages to include.
   * Defaults to MAX_SUPPORTED_LANGUAGES (18) when absent.
   */
  maxLanguages?: number | null;

  /**
   * Restrict generation to this subset of channel classes. When absent, cells
   * are built for ALL_CHANNEL_CLASSES. Useful to generate ONLY publishable
   * channels (e.g. owned_net — the only 'ready' connector today) so no Gemini
   * spend is wasted on cells whose connector is still a stub.
   */
  channels?: ChannelClass[] | null;
}

// ---------------------------------------------------------------------------
// Per-language breakdown (part of the auditable summary)
// ---------------------------------------------------------------------------

/**
 * Per-language allocation summary for the auditable matrix report.
 */
export interface LanguageAllocation {
  language: string;
  weight: number;
  tier: "high" | "low";
  formats: ContentFormat[];
  cellCount: number;
}

// ---------------------------------------------------------------------------
// ContentMatrixResult — the returned artifact
// ---------------------------------------------------------------------------

/**
 * ContentMatrixResult — the full auditable coverage+cost contract returned by
 * buildContentMatrix().
 *
 * - cells: the flat list of ContentCells to feed into the generation pipeline.
 * - languageAllocations: per-language breakdown (format count, tier, weight).
 * - formatSet: the distinct set of formats included after cap application.
 * - summary: human-readable printable description for genContent CLI output.
 * - totalCells: total cells BEFORE over-generation (auditable count).
 * - totalVariants: total variants including over-generation (actual LLM requests).
 */
export interface ContentMatrixResult {
  cells: ContentCell[];
  languageAllocations: LanguageAllocation[];
  formatSet: ContentFormat[];
  summary: string;
  totalCells: number;
  totalVariants: number;
}

// ---------------------------------------------------------------------------
// Reconcile detected languages from BrandBrief + template
// ---------------------------------------------------------------------------

/**
 * Reconcile BrandBrief.detectedLanguages with template.languages into a
 * unified CustomerLanguage[] list.
 *
 * Strategy:
 *   - Start with template.languages (explicit customer config).
 *   - For languages in detectedLanguages NOT already in template.languages,
 *     add them with the detected weight (scaled relative to template weights).
 *   - Template weight always wins when both supply a language code.
 *
 * @param detectedLanguages - From BrandBrief.
 * @param templateLanguages - From the active industry_template customer config.
 * @returns Reconciled list suitable for sortByWeight.
 */
export function reconcileLanguages(
  detectedLanguages: DetectedLanguage[],
  templateLanguages: Array<{ code: string; weight: number }>
): CustomerLanguage[] {
  const templateCodes = new Set(templateLanguages.map((l) => l.code));

  // Build a fake customerId for CustomerLanguage (the field is required by
  // the type but sortByWeight only uses .language and .weight).
  const DUMMY_CUSTOMER_ID = "00000000-0000-0000-0000-000000000000";

  // Template languages take priority.
  const result: CustomerLanguage[] = templateLanguages.map((l) => ({
    customerId: DUMMY_CUSTOMER_ID,
    language: l.code,
    weight: l.weight,
  }));

  // Add detected languages not already covered by the template.
  for (const detected of detectedLanguages) {
    if (!templateCodes.has(detected.code)) {
      result.push({
        customerId: DUMMY_CUSTOMER_ID,
        language: detected.code,
        weight: detected.weight,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Deterministic phrasing group seed
// ---------------------------------------------------------------------------

/**
 * Produce a short deterministic seed string from cell coordinates.
 * Used as phrasingGroupSeed — passed to the generation prompt to encourage
 * distinct phrasings without requiring a random number generator.
 *
 * Format: "<format>:<language>:<channel>:<variant>"
 * This is intentionally human-readable for debugging.
 */
function phrasingGroupSeed(
  format: ContentFormat,
  language: string,
  channel_class: ChannelClass,
  variantIndex: number
): string {
  return `${format}:${language}:${channel_class}:v${variantIndex}`;
}

// ---------------------------------------------------------------------------
// Determine formats for a language tier
// ---------------------------------------------------------------------------

/**
 * Determine which formats to use for a given language tier and channel.
 *
 * @param tier         - 'high' or 'low' weight tier.
 * @param channel      - Target channel class.
 * @param allowedFmts  - Caps-filtered allowed format set.
 */
function formatsForTierAndChannel(
  tier: "high" | "low",
  channel: ChannelClass,
  allowedFmts: Set<ContentFormat>
): ContentFormat[] {
  const candidates = tier === "high"
    ? [...FULL_PROSE_FORMATS, ...JSONLD_FORMATS]
    : LOW_WEIGHT_FORMATS;

  return candidates.filter(
    (fmt) =>
      allowedFmts.has(fmt) &&
      isFormatLegalOnChannel(fmt, channel)
  );
}

// ---------------------------------------------------------------------------
// buildContentMatrix — main entry point
// ---------------------------------------------------------------------------

/**
 * Build the ContentMatrix: the PURE, deterministic, BOUNDED coverage+cost
 * contract for one generation run.
 *
 * Called BEFORE any token spend (IntentMatrix analogue for Phase 2).
 *
 * @param brief    - BrandBrief with detectedLanguages, brandAliases, etc.
 * @param template - Active industry_template customer config (languages, budget).
 * @param caps     - Per-customer asset/format caps (from budget table).
 * @returns        ContentMatrixResult — cells + auditable summary.
 */
export function buildContentMatrix(
  brief: BrandBrief,
  template: {
    languages: Array<{ code: string; weight: number }>;
  },
  caps: ContentMatrixCaps = {}
): ContentMatrixResult {
  // --- 1. Resolve caps with defaults ---
  const maxAssets = caps.max_content_assets_per_run ?? 200;
  const maxFormats = caps.max_formats ?? 8; // all 8 formats by default
  const maxLanguages = Math.min(
    caps.maxLanguages ?? MAX_SUPPORTED_LANGUAGES,
    MAX_SUPPORTED_LANGUAGES
  );

  // --- 2. Reconcile + sort languages by weight ---
  const reconciled = reconcileLanguages(
    brief.detectedLanguages,
    template.languages
  );
  const sorted = sortByWeight(reconciled);
  const selectedLangs = sorted.slice(0, maxLanguages);

  if (selectedLangs.length === 0) {
    return _emptyResult();
  }

  const maxWeight = selectedLangs[0]?.weight ?? 1.0;

  // --- 3. Determine active format set (capped by max_formats) ---
  // Priority order: prose formats first, JSON-LD last (they are $0 builders).
  // Within prose: definition_sentence (broadest) → answer_block → faq_table →
  // comparison_table → case_study.
  const formatPriority: ContentFormat[] = [
    ...FULL_PROSE_FORMATS,
    ...JSONLD_FORMATS,
  ];
  const allowedFormats = new Set<ContentFormat>(
    formatPriority.slice(0, maxFormats)
  );

  // --- 4. Build cells for each language × channel × format ---
  const allCells: ContentCell[] = [];
  const langAllocations: LanguageAllocation[] = [];

  for (const lang of selectedLangs) {
    const languageCode = lang.language;
    const isHighWeight =
      lang.weight >= maxWeight * HIGH_WEIGHT_THRESHOLD_RATIO;
    const tier: "high" | "low" = isHighWeight ? "high" : "low";

    const langCells: ContentCell[] = [];
    const langFormatSet = new Set<ContentFormat>();

    const activeChannels =
      caps.channels && caps.channels.length > 0
        ? ALL_CHANNEL_CLASSES.filter((c) => caps.channels!.includes(c))
        : ALL_CHANNEL_CLASSES;
    for (const channel of activeChannels) {
      const legalFormats = formatsForTierAndChannel(tier, channel, allowedFormats);

      for (const format of legalFormats) {
        langFormatSet.add(format);
        const variants = Math.ceil(BASE_VARIANTS_PER_CELL * OVER_GEN_FACTOR);
        for (let v = 0; v < variants; v++) {
          langCells.push({
            contentType: FORMAT_TO_CONTENT_TYPE[format],
            format,
            language: languageCode,
            channel_class: channel,
            targetVariants: 1, // 1 canonical variant per cell slot
            phrasingGroupSeed: phrasingGroupSeed(format, languageCode, channel, v),
          });
        }
      }
    }

    allCells.push(...langCells);
    langAllocations.push({
      language: languageCode,
      weight: lang.weight,
      tier,
      formats: [...langFormatSet].sort(),
      cellCount: langCells.length,
    });
  }

  // --- 5. Clamp to max_content_assets_per_run ---
  // Trim from the lowest-weight language (last in sorted order) first.
  let cells = allCells;
  if (cells.length > maxAssets) {
    cells = _trimToAssetCap(cells, langAllocations, maxAssets);
  }

  // --- 6. Derive the actual format set from final cells ---
  const finalFormatSet = [...new Set(cells.map((c) => c.format))].sort() as ContentFormat[];

  // Recompute per-language cell counts after trimming.
  const langCellCounts = new Map<string, number>();
  for (const c of cells) {
    langCellCounts.set(c.language, (langCellCounts.get(c.language) ?? 0) + 1);
  }
  const finalAllocations: LanguageAllocation[] = langAllocations
    .map((la) => ({
      ...la,
      cellCount: langCellCounts.get(la.language) ?? 0,
    }))
    .filter((la) => la.cellCount > 0);

  const totalVariants = cells.reduce((sum, c) => sum + c.targetVariants, 0);

  // --- 7. Build printable summary ---
  const summary = _buildSummary(
    finalAllocations,
    finalFormatSet,
    cells.length,
    totalVariants,
    maxAssets,
    maxFormats
  );

  return {
    cells,
    languageAllocations: finalAllocations,
    formatSet: finalFormatSet,
    summary,
    totalCells: cells.length,
    totalVariants,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Trim cell list to the asset cap, removing lowest-weight language cells first.
 * Language order in langAllocations is already weight-descending (from sortByWeight).
 */
function _trimToAssetCap(
  cells: ContentCell[],
  langAllocations: LanguageAllocation[],
  maxAssets: number
): ContentCell[] {
  // Build a priority score per cell: index in language order (lower = higher priority).
  // Cells for the highest-weight language are kept first.
  const langPriority = new Map<string, number>();
  for (let i = 0; i < langAllocations.length; i++) {
    langPriority.set(langAllocations[i]!.language, i);
  }

  // Sort cells by language priority (ascending = highest-weight first),
  // then by format priority (definition first).
  const formatOrder: ContentFormat[] = [
    "definition_sentence",
    "answer_block",
    "faq_table",
    "comparison_table",
    "case_study",
    "jsonld_org",
    "jsonld_faqpage",
    "jsonld_article",
  ];
  const formatPriorityMap = new Map<string, number>(
    formatOrder.map((f, i) => [f, i])
  );

  const sorted = [...cells].sort((a, b) => {
    const la = langPriority.get(a.language) ?? 999;
    const lb = langPriority.get(b.language) ?? 999;
    if (la !== lb) return la - lb;
    const fa = formatPriorityMap.get(a.format) ?? 99;
    const fb = formatPriorityMap.get(b.format) ?? 99;
    return fa - fb;
  });

  return sorted.slice(0, maxAssets);
}

/**
 * Build the human-readable printable summary.
 */
function _buildSummary(
  allocations: LanguageAllocation[],
  formatSet: ContentFormat[],
  totalCells: number,
  totalVariants: number,
  maxAssets: number,
  maxFormats: number
): string {
  const lines: string[] = [
    "╔══════════════════════════════════════════════════════════════╗",
    "║           CONTENT MATRIX — Coverage + Cost Contract          ║",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
    `  Total cells : ${totalCells} (cap: ${maxAssets})`,
    `  Formats     : ${formatSet.length} of ${maxFormats} max — [${formatSet.join(", ")}]`,
    `  Languages   : ${allocations.length}`,
    "",
    "  Language allocation:",
  ];

  for (const la of allocations) {
    lines.push(
      `    ${la.language.padEnd(8)} wt=${la.weight.toFixed(2)}  tier=${la.tier}  ` +
        `formats=${la.formats.length}  cells=${la.cellCount}`
    );
  }

  lines.push("");
  lines.push(
    "  NOTE: Generation cost is billed per language call (not per cell)."
  );
  lines.push(
    "        Total variants (incl. over-gen): " + totalVariants
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Return an empty ContentMatrixResult when no languages are selected.
 */
function _emptyResult(): ContentMatrixResult {
  return {
    cells: [],
    languageAllocations: [],
    formatSet: [],
    summary: "(empty matrix — no languages selected)",
    totalCells: 0,
    totalVariants: 0,
  };
}
