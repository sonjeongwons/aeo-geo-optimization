/**
 * src/content/generationPromptContent.ts
 *
 * T07 — PURE per-(language, format) native prompt builder for content generation.
 *
 * DESIGN-phase2.md §"Variant Pipeline / STAGE B":
 *   - Seeds from BrandBrief DESCRIPTORS only — NEVER other-language strings or
 *     machine-translated strings.
 *   - Uses the channel register descriptor (native phrasing register for the
 *     target channel class) to encourage correct tone/style.
 *   - System instruction explicitly instructs native generation, NOT translation.
 *   - Per-format instruction shapes the expected output structure.
 *
 * BUG FIX: buildContentPromptForFormat (new) is the per-(language, format) variant
 * used by generateContentForLanguage after the fix. It generates a prompt that
 * instructs the model to produce items for ONE specific format, with a concrete
 * JSON body example for that format — so Gemini's responseSchema (derived from the
 * concrete body schema) aligns with the prompt instructions.
 *
 * buildContentPrompt (original) is kept for existing tests and backward compatibility.
 *
 * No IO, no LLM calls. Deterministic for identical inputs.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import type { BrandBrief } from "../generate/types.js";
import type { ContentCell } from "./types.js";
import type { ChannelClass, ContentFormat } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContentPromptInput {
  /** BCP-47 language code for this generation call. */
  language: string;
  /** All content cells for this language (may span multiple formats/channels). */
  cells: ContentCell[];
  /** BrandBrief from diagnosis (descriptors: brandName, aliases, category, etc.). */
  brief: BrandBrief;
  /**
   * Total number of output items to request from the model.
   * Caller passes ceil(totalCells * OVER_GEN_FACTOR).
   */
  totalItemsRequested: number;
}

export interface ContentPromptOutput {
  systemInstruction: string;
  userPrompt: string;
}

// ---------------------------------------------------------------------------
// Channel register descriptors
// ---------------------------------------------------------------------------

/**
 * Human-readable register/tone descriptor for each channel class.
 * These describe HOW to write for the target channel — native style cues,
 * NOT content strings from other languages.
 */
const CHANNEL_REGISTER_DESCRIPTORS: Record<ChannelClass, string> = {
  owned_net:
    "authoritative owned-channel content: clear, structured, professional; " +
    "optimized for AI answer engines; use native category terminology",
  pr_wire:
    "press-release register: formal, factual, third-person; " +
    "must include disclosure tag; wire-service neutral tone; no marketing puffery",
  directory:
    "directory listing register: concise, factual, keyword-rich; " +
    "must include disclosure tag; standard business description format",
  web2:
    "Web 2.0 publication register (Medium/dev.to/Brunch/Hashnode): " +
    "conversational yet authoritative; disclosure required; first-person brand perspective",
  social:
    "social media register: brief, punchy, native social style; " +
    "disclosure required; no comparison tables; platform-appropriate length",
  entity:
    "entity profile register (Wikidata/Crunchbase/Wikipedia-style): " +
    "encyclopaedic, neutral, third-person; only verifiable factual claims; " +
    "no marketing language; no superlatives",
};

// ---------------------------------------------------------------------------
// Format instruction descriptors
// ---------------------------------------------------------------------------

/**
 * Per-format output shape instructions for the model.
 * These describe the STRUCTURE of the expected JSON body — in English for
 * the system instruction, but the CONTENT must be in the target language.
 */
/**
 * Lean per-format body shape instructions for the LLM.
 *
 * These show ONLY the fields the LLM should author.  Post-generation fields
 * (meaning_key, length_units, numeric_claim_ids, source_ids, answer_claim_ids,
 * claim_id) are deliberately OMITTED — they are filled code-side by
 * buildStorageBodyWithLength() after generation.
 *
 * jsonld_* formats are NOT included — they are built deterministically by
 * jsonld.ts and are never sent to the LLM.
 */
const FORMAT_INSTRUCTIONS: Partial<Record<ContentFormat, string>> = {
  definition_sentence:
    "A short (1-2 sentence) definitional phrase in the target language. " +
    'JSON: {"content_type":"definition","text":"<native text>"}',

  answer_block:
    "A self-contained answer of 134-167 words (or per-script character equivalent) " +
    "in the target language. LEAD WITH THE ANSWER (BLUF): the FIRST sentence must name " +
    "the brand and directly answer the question, restating the question's key nouns so the " +
    "passage stands alone out of context. Then make it EVIDENCE-DENSE by naming concrete, specific " +
    "capabilities/features drawn ONLY from the brand's product attributes provided in the context. " +
    "Include a numeric figure ONLY if it appears VERBATIM in an attribute (copy it exactly — never " +
    "round, approximate, derive, or invent numbers; never use superlatives like best/ultimate/#1). " +
    "Naming specific real features is what makes a passage citation-worthy to answer engines. Do NOT " +
    "emit any claim IDs, UUIDs, or arrays. The only fields to output are " +
    "content_type and text.\n" +
    'JSON: {"content_type":"answer_block","text":"<native prose text>"}',

  faq_table:
    "A FAQ with 3-8 Q&A pairs in the target language. " +
    "Only output the q and a fields for each row — no claim IDs or UUID arrays.\n" +
    'JSON: {"content_type":"faq","rows":[{"q":"<question>","a":"<answer>"},...]}',

  comparison_table:
    "A comparison table in the target language with column headers and entity rows. " +
    "Use only competitor data provided in the brand context. " +
    "For each cell output only the value string — no claim_id field.\n" +
    'JSON: {"content_type":"comparison","columns":["<col>",...],"rows":[{"entity":"<name>","cells":[{"value":"<v>"},...]},...]}',

  case_study:
    "A case study in the target language with situation/action/result narrative and " +
    "quantified metrics. For each metric output label, before, and after only — no claim_id.\n" +
    'JSON: {"content_type":"case_study","situation":"<text>","action":"<text>","result":"<text>","metrics":[{"label":"<label>","before":"<val>","after":"<val>"},...]}',
};

// ---------------------------------------------------------------------------
// buildContentPrompt — main export
// ---------------------------------------------------------------------------

/**
 * Build the system instruction and user prompt for a native multilingual
 * content-generation call batched across a language's cells.
 *
 * - Seeded by BrandBrief DESCRIPTORS (brandName/aliases, category, positioning,
 *   productAttributes, competitor names in script-appropriate form).
 * - NEVER seeds with other-language strings or machine-translated content.
 * - Each cell maps to one format + channel class combination.
 * - Over-generated at 1.3x to give the phrasingVariationGate room.
 *
 * @param input.language             BCP-47 language code for this call.
 * @param input.cells                ContentCells for this language.
 * @param input.brief                BrandBrief from diagnosis.
 * @param input.totalItemsRequested  Total output items to request.
 * @returns SystemInstruction + userPrompt strings.
 */
export function buildContentPrompt(input: ContentPromptInput): ContentPromptOutput {
  const { language, cells, brief, totalItemsRequested } = input;

  // ---- Competitor context (script-appropriate first alias) ----
  const competitorList =
    brief.seedCompetitors.length > 0
      ? brief.seedCompetitors
          .slice(0, 8)
          .map((c) => (c.aliases.length > 0 ? c.aliases[0]! : c.name))
          .join(", ")
      : "(none inferred)";

  // ---- Product attributes ----
  const attributeList =
    brief.productAttributes.length > 0
      ? brief.productAttributes.slice(0, 8).join(", ")
      : "(none specified)";

  // ---- ICP context ----
  const icpContext =
    brief.icp.length > 0
      ? brief.icp.slice(0, 4).join("; ")
      : "(general users)";

  // ---- Brand aliases ----
  const aliasesLine =
    brief.brandAliases.length > 0
      ? `  Brand aliases / transliterations: ${brief.brandAliases.join(", ")}`
      : "";

  // ---- Positioning ----
  const positioningLine = brief.positioning
    ? `  Positioning / wedge: ${brief.positioning}`
    : "";

  // ---- Deduplicate format + channel pairs for the cell descriptor list ----
  const cellGroups = new Map<string, { format: ContentFormat; channel: ChannelClass; count: number }>();
  for (const cell of cells) {
    const key = `${cell.format}:${cell.channel_class}`;
    const existing = cellGroups.get(key);
    if (existing) {
      existing.count += cell.targetVariants;
    } else {
      cellGroups.set(key, {
        format: cell.format,
        channel: cell.channel_class,
        count: cell.targetVariants,
      });
    }
  }

  // ---- Cell/format descriptors ----
  const cellDescriptors = [...cellGroups.values()]
    .map(({ format, channel, count }, idx) => {
      const formatInstr = FORMAT_INSTRUCTIONS[format] ?? format;
      const channelDesc = CHANNEL_REGISTER_DESCRIPTORS[channel] ?? channel;
      return (
        `Content group ${idx + 1} (${count} variant(s)):\n` +
        `  Format     : ${format}\n` +
        `  Channel    : ${channel} — ${channelDesc}\n` +
        `  Body shape : ${formatInstr}`
      );
    })
    .join("\n\n");

  // ---- System instruction ----
  const systemInstruction =
    `You are a native ${language} content writer creating offsite content for ` +
    `AI answer engine optimization (AEO/GEO). ` +
    `\n\n` +
    `CRITICAL RULES:\n` +
    `1. Write ALL content bodies in ${language} using the native script and vocabulary.\n` +
    `2. DO NOT translate from English — generate content from scratch as a native ${language} speaker.\n` +
    `3. Content must sound natural and idiomatic to a native ${language} reader.\n` +
    `4. Use only verifiable factual claims. Do NOT invent metrics, reviews, or testimonials.\n` +
    `5. Make the passage EVIDENCE-DENSE using the brand's product attributes above: name concrete,\n` +
    `   specific capabilities/features (this is what makes a passage citation-worthy). Include a\n` +
    `   numeric figure ONLY if it appears VERBATIM in an attribute — copy it exactly, never round,\n` +
    `   approximate, derive, or invent a number, and never use unbounded superlatives (best, ultimate,\n` +
    `   #1, leading). If an attribute has no exact figure, describe the capability qualitatively. OMIT\n` +
    `   anything you cannot ground in the attributes — never fabricate.\n` +
    `6. No unbounded superlatives unless backed by concrete verifiable facts stated in the prose.\n` +
    `   English to avoid: best, #1, leading, top, world-class, ultimate, premium.\n` +
    `   한국어에서 피할 표현: 최고·최상·최선·프리미엄·철저(히)·엄격(한)·완벽(한)·독보적·보장.\n` +
    `      대신 사실로 서술하세요 (예: "철저히 검증" → "직장·소득·신원을 매니저가 직접 검수").\n` +
    `   日本語で避ける: 最高・完璧・徹底・厳格・プレミアム・保証。事実で記述すること。\n` +
    `7. SELF-CONTAINED & COMPLETE (GEO citability): begin each passage by naming the brand AND what\n` +
    `   it is (its category), so the passage stands alone and is quotable verbatim in an AI answer\n` +
    `   with no surrounding context. Then weave 2-3 CONCRETE attributes into one complete, specific\n` +
    `   answer — prefer a full, informative passage over a terse one-clause fragment, while staying\n` +
    `   strictly grounded in the attributes (never pad with fluff or unverifiable claims).\n` +
    `8. Disclosure tag is NOT your concern — the gating layer adds it.\n` +
    `9. Return ONLY the JSON array requested. No text outside the JSON.`;

  // ---- User prompt ----
  const userPrompt =
    `Generate ${totalItemsRequested} content items in ${language} for an AEO/GEO content set.\n` +
    `Group phrasing variants of the same meaning under the same phrasingGroupId.\n` +
    `\n` +
    `BRAND CONTEXT (descriptors only — do NOT copy these English strings verbatim into the content):\n` +
    `  Brand name: ${brief.brandName}\n` +
    (aliasesLine ? `${aliasesLine}\n` : "") +
    `  Category  : ${brief.category}\n` +
    (positioningLine ? `${positioningLine}\n` : "") +
    `  ICP / use cases: ${icpContext}\n` +
    `  Key attributes: ${attributeList}\n` +
    `  Known competitors (in native script where possible): ${competitorList}\n` +
    `\n` +
    `CONTENT GROUPS TO COVER:\n` +
    `${cellDescriptors}\n` +
    `\n` +
    `OUTPUT FORMAT (strict JSON array, no text outside the JSON):\n` +
    `[\n` +
    `  {\n` +
    `    "language": "${language}",\n` +
    `    "format": "<one of the formats listed above>",\n` +
    `    "channel_class": "<channel class for this item>",\n` +
    `    "phrasingGroupId": "<short stable identifier grouping phrasing variants of the same meaning>",\n` +
    `    "body": <the body JSON object matching the format's shape above>\n` +
    `  }\n` +
    `]\n` +
    `\n` +
    `Produce exactly ${totalItemsRequested} items. Distribute proportionally across the content groups.\n` +
    `Ensure all body text is in ${language}. The "language" field MUST be exactly "${language}".\n` +
    `Use different phrasingGroupIds for genuinely different content / meanings.`;

  return { systemInstruction, userPrompt };
}

// ---------------------------------------------------------------------------
// buildContentPromptForFormat — per-(language, format) prompt for the bug fix
// ---------------------------------------------------------------------------

/**
 * Input for a single-format generation call.
 * Used by the fixed generateContentForLanguage (one call per format).
 */
export interface ContentPromptForFormatInput {
  /** BCP-47 language code for this generation call. */
  language: string;
  /** The SINGLE format this call generates. */
  format: ContentFormat;
  /** All content cells for this (language, format) combination. */
  cells: ContentCell[];
  /** BrandBrief from diagnosis (descriptors: brandName, aliases, category, etc.). */
  brief: BrandBrief;
  /**
   * Total number of output items to request from the model.
   * Caller passes ceil(totalCells * OVER_GEN_FACTOR).
   */
  totalItemsRequested: number;
  /**
   * VERIFIED, SOURCED competitor/brand facts (from ingested claim_source rows)
   * for comparison_table generation. Each string is a self-contained sourced
   * fact (e.g. "Character.AI: persistent Memory system ..."). When the format is
   * comparison_table, the model is instructed to fill cells ONLY from these
   * facts (so cells resolve against signed claim_sources and pass §7), never to
   * invent competitor claims (§0: we never fetched these — the team supplied them).
   * Ignored for non-comparison formats.
   */
  comparativeFacts?: string[];
}

/**
 * Build the system instruction and user prompt for a SINGLE FORMAT generation
 * call within a native language.
 *
 * Each call is scoped to ONE format so the responseSchema can be the CONCRETE
 * body schema for that format (not z.unknown() → string).  This ensures Gemini
 * returns a properly-shaped body object that ContentBodySchema can validate.
 *
 * The prompt instructs the model with:
 *   - The specific format to generate.
 *   - A concrete JSON body example for that format.
 *   - All channel classes requested for this format + their register descriptors.
 *   - BrandBrief DESCRIPTORS (never translated strings).
 *   - "DO NOT translate" + native-generation rules.
 *
 * @param input.language             BCP-47 language code.
 * @param input.format               The single format for this call.
 * @param input.cells                ContentCells for this (language, format).
 * @param input.brief                BrandBrief from diagnosis.
 * @param input.totalItemsRequested  Total output items to request.
 * @returns SystemInstruction + userPrompt strings.
 */
export function buildContentPromptForFormat(
  input: ContentPromptForFormatInput
): ContentPromptOutput {
  const { language, format, cells, brief, totalItemsRequested, comparativeFacts } = input;

  // ---- Competitor context (script-appropriate first alias) ----
  const competitorList =
    brief.seedCompetitors.length > 0
      ? brief.seedCompetitors
          .slice(0, 8)
          .map((c) => (c.aliases.length > 0 ? c.aliases[0]! : c.name))
          .join(", ")
      : "(none inferred)";

  // ---- Comparison-table discipline (ALWAYS-ON for comparison_table) ----
  // The cell-writing / diversity / neutrality / methodology rules apply to EVERY
  // comparison table, whether or not ingested competitor facts exist (W6.2 — the
  // rules previously vanished when comparativeFacts was empty, the common
  // new-customer case, letting the model emit undisciplined numeric/superlative
  // cells and near-duplicate tables).
  const comparisonRulesBlock =
    format === "comparison_table"
      ? `\nCOMPARISON TABLE RULES (MANDATORY — cells/tables violating these are rejected):\n` +
        `  • Open the table's surrounding text with ONE sentence stating the comparison criteria — what\n` +
        `    dimension is compared and that competitor information reflects publicly available / officially\n` +
        `    published information. Keep it neutral and factual.\n` +
        `  • Write each cell QUALITATIVELY in a few words (e.g. "Yes — persistent memory", "Limited",\n` +
        `    "Subscription only", "Not disclosed"). Describe the CAPABILITY, not metrics.\n` +
        `  • Do NOT put ANY raw number in a cell — no user counts, prices, dates, percentages, "18 million",\n` +
        `    "$10/mo", "2024", etc. OMIT every number; describe qualitatively instead.\n` +
        `  • Do NOT use ANY superlative or ranking word (leading, best, #1, top, largest, most popular,\n` +
        `    most, biggest, fastest, advanced, robust, comprehensive, extensive, powerful).\n` +
        `  • Neutral comparison only — never disparage a competitor.\n` +
        `  • For any competitor capability you are not certain of, write "정보 없음"/"Not disclosed" —\n` +
        `    NEVER guess or infer a competitor capability.\n` +
        `  GOOD cells: "Yes — persistent memory", "Revenue-sharing for creators", "Subscription only",\n` +
        `              "Group chat supported", "Not disclosed".\n` +
        `  BAD cells (rejected): "18 million users", "Best-in-class memory", "Most advanced image gen",\n` +
        `              "Available since 2024", "$10/month", "Industry-leading customization".\n` +
        `  • DIVERSITY (critical): if you produce MORE THAN ONE comparison table, each one MUST focus on a\n` +
        `    DIFFERENT theme so they are not near-duplicates — e.g. table 1 = memory & core features,\n` +
        `    table 2 = pricing & access, table 3 = content policy & safety, table 4 = customization &\n` +
        `    creator tools. Use DIFFERENT columns and a DIFFERENT phrasingGroupId per theme. Near-identical\n` +
        `    tables are rejected as duplicates.\n`
      : "";

  // ---- Verified comparative facts block (comparison_table only) ----
  // Inject the ingested, SOURCED competitor/brand facts so the model builds the
  // table strictly FROM verified claims (→ cells resolve against signed
  // claim_sources → §7 passes). When NO facts are ingested (common for a new
  // customer) the model MUST NOT invent competitor capabilities (§0/§7): it may
  // only describe the BRAND's own attributes and must mark competitor cells
  // "Not disclosed".
  const hasFacts = comparativeFacts != null && comparativeFacts.length > 0;
  const comparativeFactsBlock =
    format === "comparison_table"
      ? hasFacts
        ? `\nVERIFIED COMPETITOR & BRAND FACTS — build the comparison table ONLY from these sourced facts.\n` +
          `Do NOT invent, infer, or add any competitor capability not listed here. Render each fact\n` +
          `faithfully (translate into ${language} if needed) — factual and neutral, never disparaging.\n` +
          `FACTS:\n` +
          comparativeFacts!.slice(0, 40).map((f) => `  - ${f}`).join("\n") +
          `\n`
        : `\nNO INGESTED COMPETITOR FACTS ARE AVAILABLE. You therefore must NOT state any specific\n` +
          `competitor capability. Fill the brand's own column ONLY from the brand attributes above, and\n` +
          `write "정보 없음"/"Not disclosed" for every competitor cell. Do NOT guess competitor behavior.\n`
      : "";

  // ---- Product attributes ----
  const attributeList =
    brief.productAttributes.length > 0
      ? brief.productAttributes.slice(0, 8).join(", ")
      : "(none specified)";

  // ---- ICP context ----
  const icpContext =
    brief.icp.length > 0
      ? brief.icp.slice(0, 4).join("; ")
      : "(general users)";

  // ---- Brand aliases ----
  const aliasesLine =
    brief.brandAliases.length > 0
      ? `  Brand aliases / transliterations: ${brief.brandAliases.join(", ")}`
      : "";

  // ---- Positioning ----
  const positioningLine = brief.positioning
    ? `  Positioning / wedge: ${brief.positioning}`
    : "";

  // ---- Format instruction (concrete body shape) ----
  const formatInstruction = FORMAT_INSTRUCTIONS[format] ?? format;

  // ---- Deduplicate channel classes for this format's cells ----
  const channelGroups = new Map<ChannelClass, number>();
  for (const cell of cells) {
    channelGroups.set(
      cell.channel_class,
      (channelGroups.get(cell.channel_class) ?? 0) + cell.targetVariants
    );
  }

  const channelDescriptors = [...channelGroups.entries()]
    .map(([channel, count]) => {
      const channelDesc = CHANNEL_REGISTER_DESCRIPTORS[channel] ?? channel;
      return `  - ${channel} (${count} variant(s)): ${channelDesc}`;
    })
    .join("\n");

  // ---- System instruction ----
  const systemInstruction =
    `You are a native ${language} content writer creating offsite content for ` +
    `AI answer engine optimization (AEO/GEO). ` +
    `\n\n` +
    `CRITICAL RULES:\n` +
    `1. Write ALL content bodies in ${language} using the native script and vocabulary.\n` +
    `2. DO NOT translate from English — generate content from scratch as a native ${language} speaker.\n` +
    `3. Content must sound natural and idiomatic to a native ${language} reader.\n` +
    `4. Use only verifiable factual claims. Do NOT invent metrics, reviews, or testimonials.\n` +
    `5. If you include specific numeric facts (e.g. percentages, speeds, counts), back each\n` +
    `   with a concrete source reference IN THE PROSE TEXT. Omit numbers you cannot verify.\n` +
    `6. No unbounded superlatives (best, #1, leading, top, world-class) unless you can support\n` +
    `   them with concrete verifiable facts stated in the prose.\n` +
    `7. Disclosure tags are NOT your concern — the gating layer handles them.\n` +
    `8. Output ONLY the author-visible fields shown in the body shape below.\n` +
    `   Do NOT output: claim_id, answer_claim_ids, numeric_claim_ids, source_ids,\n` +
    `   length_units, or meaning_key. Those are set by the system after generation.\n` +
    `9. Every item body MUST be a JSON OBJECT matching the lean shape below — NOT a string.\n` +
    `10. Return ONLY the JSON object with an "items" array. No text outside the JSON.`;

  // ---- User prompt ----
  const userPrompt =
    `Generate ${totalItemsRequested} "${format}" content items in ${language} for an AEO/GEO content set.\n` +
    `Group phrasing variants of the same meaning under the same phrasingGroupId.\n` +
    `\n` +
    `FORMAT: ${format}\n` +
    `Body shape for this format (output ONLY these fields — no UUIDs, no derived counts):\n` +
    `  ${formatInstruction}\n` +
    `\n` +
    `CHANNEL CLASSES TO COVER:\n` +
    `${channelDescriptors}\n` +
    `\n` +
    `BRAND CONTEXT (descriptors only — do NOT copy these English strings verbatim into the content):\n` +
    `  Brand name: ${brief.brandName}\n` +
    (aliasesLine ? `${aliasesLine}\n` : "") +
    `  Category  : ${brief.category}\n` +
    (positioningLine ? `${positioningLine}\n` : "") +
    `  ICP / use cases: ${icpContext}\n` +
    `  Key attributes: ${attributeList}\n` +
    `  Known competitors (in native script where possible): ${competitorList}\n` +
    comparisonRulesBlock +
    comparativeFactsBlock +
    `\n` +
    `OUTPUT FORMAT (strict JSON object with "items" array, no text outside the JSON):\n` +
    `{\n` +
    `  "items": [\n` +
    `    {\n` +
    `      "language": "${language}",\n` +
    `      "format": "${format}",\n` +
    `      "channel_class": "<one of the channel classes listed above>",\n` +
    `      "phrasingGroupId": "<short stable identifier grouping phrasing variants of the same meaning>",\n` +
    `      "body": <the lean body JSON OBJECT for ${format} — only the author fields listed above>\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `\n` +
    `Produce exactly ${totalItemsRequested} items.\n` +
    `Ensure all body text is in ${language}. The "language" field MUST be exactly "${language}".\n` +
    `The "format" field MUST be exactly "${format}".\n` +
    `The "body" field MUST be a JSON object — never a string.\n` +
    `Use different phrasingGroupIds for genuinely different content / meanings.`;

  return { systemInstruction, userPrompt };
}
