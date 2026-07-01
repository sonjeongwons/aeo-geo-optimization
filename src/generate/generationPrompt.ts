/**
 * src/generate/generationPrompt.ts
 *
 * PURE: Per-language native-generation prompt builder.
 *
 * DESIGN-phase1.md §"Multilingual Pipeline (§6)" / §"Question Model & Generation" step 3:
 *   - Passes intent DESCRIPTORS (intentType, funnelStage, brand, category, wedge,
 *     script-appropriate competitor names) — NEVER English question strings.
 *   - Instructs the model to write idiomatic questions that a native speaker of
 *     the target language would type into an AI assistant.
 *   - Explicitly FORBIDS translation from English.
 *
 * No IO, no LLM calls. Deterministic for identical inputs.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import type { BrandBrief, IntentCell } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerationPromptInput {
  /** BCP-47 language code for this generation call. */
  language: string;
  /** Intent cells for this language (all cells share the same language). */
  cells: IntentCell[];
  /** The diagnosed brand brief (provides brand, category, wedge, competitors). */
  brief: BrandBrief;
  /**
   * Total number of phrasing variants to generate across ALL cells for this language.
   * Callers should pass ceil(totalCellTargets * OVER_GEN_FACTOR).
   */
  totalVariantsRequested: number;
}

export interface GenerationPromptOutput {
  systemInstruction: string;
  userPrompt: string;
}

// ---------------------------------------------------------------------------
// Human-readable labels for intent types
// ---------------------------------------------------------------------------

const INTENT_LABELS: Record<string, string> = {
  brand: 'Brand intent (questions that include the brand name and ask about it directly)',
  category: 'Category intent (questions about the product category, not naming the brand)',
  comparison: 'Comparison intent (questions comparing the brand or category to alternatives)',
  alternative: 'Alternative intent (questions asking for alternatives or substitutes)',
  useCase: 'Use-case intent (questions about specific use cases, problems, or jobs-to-be-done)',
  attribute: 'Attribute intent (questions about a specific product feature or attribute)',
};

const FUNNEL_LABELS: Record<string, string> = {
  awareness: 'Awareness stage (user is discovering the category; broad, exploratory questions)',
  consideration: 'Consideration stage (user is evaluating options; comparison and research questions)',
  decision: 'Decision stage (user is close to committing; specific, action-oriented questions)',
};

// ---------------------------------------------------------------------------
// buildGenerationPrompt — main export
// ---------------------------------------------------------------------------

/**
 * Build the system instruction and user prompt for a native multilingual
 * question-generation call.
 *
 * @param input.language              BCP-47 language code for this call.
 * @param input.cells                 IntentCells for this language.
 * @param input.brief                 BrandBrief from diagnosis.
 * @param input.totalVariantsRequested Total phrasing variants to produce.
 * @returns SystemInstruction + userPrompt strings ready for generateStructured().
 */
export function buildGenerationPrompt(input: GenerationPromptInput): GenerationPromptOutput {
  const { language, cells, brief, totalVariantsRequested } = input;

  // ---- Competitor context (script-appropriate names, first alias when available) ----
  const competitorList =
    brief.seedCompetitors.length > 0
      ? brief.seedCompetitors
          .slice(0, 8) // cap at 8 so prompt stays bounded
          .map((c) => {
            const displayName = c.aliases.length > 0 ? c.aliases[0]! : c.name;
            return displayName;
          })
          .join(', ')
      : '(none inferred)';

  // ---- ICP/use-case context ----
  const icpContext =
    brief.icp.length > 0 ? brief.icp.slice(0, 4).join('; ') : '(general users)';

  // ---- Intent cell descriptors (never English question strings) ----
  const cellDescriptors = cells
    .map((cell, idx) => {
      const intentLabel = INTENT_LABELS[cell.intentType] ?? cell.intentType;
      const funnelLabel = FUNNEL_LABELS[cell.funnelStage] ?? cell.funnelStage;
      return (
        `Intent group ${idx + 1}:\n` +
        `  Intent type: ${intentLabel}\n` +
        `  Funnel stage: ${funnelLabel}\n` +
        `  Target questions: ${cell.targetCount}`
      );
    })
    .join('\n\n');

  // ---- System instruction ----
  const systemInstruction =
    `You are a native ${language} speaker and market research expert. ` +
    `Your task is to generate questions that REAL users of AI assistants (such as ChatGPT, ` +
    `Gemini, Perplexity, or Claude) would naturally type in ${language}. ` +
    `\n\n` +
    `CRITICAL RULES:\n` +
    `1. Write ONLY in ${language}. Use the native script and vocabulary (e.g. Japanese in ` +
    `   hiragana/katakana/kanji, Korean in Hangul, Chinese in the appropriate script, Arabic ` +
    `   in Arabic script, etc.).\n` +
    `2. DO NOT translate from English. Generate questions from scratch as a native speaker.\n` +
    `3. Questions must sound NATURAL and IDIOMATIC in ${language}, not like translations.\n` +
    `4. Each question must be a genuine information-seeking query a real user would type.\n` +
    `5. AVOID brand-leading questions for non-brand intents (do not start non-brand ` +
    `   questions with the brand name).\n` +
    `6. AVOID marketing copy, superlatives, unverifiable claims, or yes/no closed forms.\n` +
    `7. Include phrasing VARIANTS: question form, keyword-style, imperative form, ` +
    `   with/without year, head-term/long-tail — so multiple surface forms cover each intent.\n` +
    `8. Return ONLY the JSON structure requested. No explanatory text outside JSON.`;

  // ---- User prompt ----
  const userPrompt =
    `Generate ${totalVariantsRequested} questions in ${language} for an AI-visibility study. ` +
    `Group them by phrasingGroupId so phrasing variants of the same intent share one group.\n` +
    `\n` +
    `BRAND CONTEXT (for seeding — do NOT mention the brand in non-brand questions):\n` +
    `  Brand name: ${brief.brandName}\n` +
    (brief.brandAliases.length > 0
      ? `  Brand aliases: ${brief.brandAliases.join(', ')}\n`
      : '') +
    `  Category: ${brief.category}\n` +
    (brief.positioning ? `  Positioning / wedge: ${brief.positioning}\n` : '') +
    `  Target users / ICP: ${icpContext}\n` +
    (brief.productAttributes.length > 0
      ? `  Key product attributes: ${brief.productAttributes.slice(0, 6).join(', ')}\n`
      : '') +
    `  Known competitors: ${competitorList}\n` +
    `\n` +
    `INTENT GROUPS TO COVER:\n` +
    `${cellDescriptors}\n` +
    `\n` +
    `OUTPUT FORMAT (strict JSON, no text outside the JSON):\n` +
    `{\n` +
    `  "questions": [\n` +
    `    {\n` +
    `      "text": "<question in ${language}>",\n` +
    `      "intentType": "<one of: brand|category|comparison|alternative|useCase|attribute>",\n` +
    `      "funnelStage": "<one of: awareness|consideration|decision>",\n` +
    `      "phrasingGroupId": "<short string grouping variants of the same intent, e.g. group-1>"\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `\n` +
    `Produce exactly the ${totalVariantsRequested} questions. Distribute them ` +
    `proportionally across the intent groups listed above. ` +
    `Group phrasing variants of the same intent under the same phrasingGroupId. ` +
    `Use different phrasingGroupIds for genuinely different intents.`;

  return { systemInstruction, userPrompt };
}
