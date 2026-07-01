/**
 * JudgeVerdict Zod schema — SINGLE source of truth for:
 *   1. Gemini responseSchema (forced JSON, temp 0)
 *   2. Runtime validation of LLM judge output
 *   3. TypeScript type (inferred)
 *
 * DESIGN.md §5.4 / "judge contract":
 *   { brand_mentioned, brand_rank|null, sentiment, competitors_found[{name,rank}], evidence }
 *
 * Pure — no pg, no @google/genai imports.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const CompetitorFoundSchema = z.object({
  name: z.string(),
  rank: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      "1-based ordinal of this competitor's first occurrence among {brand ∪ tracked competitors} by character offset. Null if not found in the answer."
    ),
});

const EvidenceSchema = z.object({
  quote: z
    .string()
    .describe("Verbatim or alias-normalized span from the answer_text that mentions the brand."),
  start: z
    .number()
    .int()
    .nonnegative()
    .describe("Character offset (inclusive) of the span start in answer_text."),
  end: z
    .number()
    .int()
    .positive()
    .describe("Character offset (exclusive) of the span end in answer_text."),
});

// ---------------------------------------------------------------------------
// JudgeVerdict — the canonical judge output
// ---------------------------------------------------------------------------

/**
 * DESIGN §5.4 four-state judge:
 * - brand_mentioned: whether the brand appears in the answer
 * - brand_rank: 1-based ordinal among {brand ∪ tracked competitors} by first offset
 * - sentiment: positive | neutral | negative (never fabricated; null if not mentioned)
 * - competitors_found: all tracked competitors found and their ranks
 * - evidence: the located span (REQUIRED when brand_mentioned=true; null otherwise)
 */
export const JudgeVerdictSchema = z.object({
  brand_mentioned: z
    .boolean()
    .describe("True if the brand (or any of its aliases) appears in the answer."),

  brand_rank: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      "1-based ordinal rank of the brand's FIRST occurrence among {brand ∪ tracked competitors} " +
        "ordered by character offset. Null when brand_mentioned=false."
    ),

  sentiment: z
    .enum(["positive", "neutral", "negative"])
    .nullable()
    .describe(
      "Sentiment toward the brand expressed in the answer. Null when brand_mentioned=false. " +
        "Never fabricate sentiment when it is ambiguous — use 'neutral'."
    ),

  competitors_found: z
    .array(CompetitorFoundSchema)
    .describe(
      "All tracked competitors found in the answer with their 1-based ranks. " +
        "Only the tracked competitor set (not all named entities)."
    ),

  evidence: EvidenceSchema.nullable().describe(
    "Located span that verifies brand_mentioned=true. " +
      "MUST be non-null when brand_mentioned=true; null when brand_mentioned=false. " +
      "Alias/NFC-normalized matching is acceptable (not strict verbatim)."
  ),

  // -------------------------------------------------------------------------
  // Citation channel (hi-end audit MUST #2). A MENTION is the brand named in
  // prose; a CITATION is the brand presented as a clickable/linked SOURCE
  // (markdown [text](url), an HTML anchor, or an explicit "Source:"/footnote
  // attribution). The engine sells citations but historically measured only
  // mentions — these OPTIONAL fields make the citation channel a first-class,
  // separately-aggregated signal (SMR_citation) without breaking any legacy
  // verdict literal (all three are optional; absence ⇒ no citation).
  // -------------------------------------------------------------------------
  citation_present: z
    .boolean()
    .optional()
    .describe(
      "True ONLY when the brand appears as a clickable/linked SOURCE or explicit " +
        "attribution (markdown link, HTML anchor, or 'Source:'/footnote), NOT merely " +
        "named in prose. A citation is a strict subset of a mention. Omit/false when the " +
        "brand is only mentioned."
    ),

  citation_url: z
    .string()
    .nullable()
    .optional()
    .describe(
      "The URL the brand is linked as/to when citation_present=true (the href or " +
        "the cited source URL). Null when there is no citation or the link has no URL."
    ),

  citation_quote: z
    .string()
    .nullable()
    .optional()
    .describe(
      "The anchor text or attribution span that constitutes the citation (e.g. the " +
        "linked text). Null when citation_present=false. Must be a substring of the answer."
    ),

  // -------------------------------------------------------------------------
  // Recommendation channel (SOTA v2 R1). A RECOMMENDATION is the answer
  // AFFIRMATIVELY ADVISING the brand (a "best/top/recommended" list item, or a
  // recommend-verb whose object is the brand), a strict subset of a mention and
  // commercially distinct from a citation (a brand can be cited yet NOT
  // recommended). OPTIONAL so legacy verdict literals stay valid.
  // -------------------------------------------------------------------------
  recommendation_present: z
    .boolean()
    .optional()
    .describe(
      "True ONLY when the answer AFFIRMATIVELY recommends/advises the brand " +
        "(brand in a 'best/top/recommended' list item, or an affirmative recommend-verb " +
        "whose object is the brand) and is NOT negated/hedged. Conservative: omit when unsure."
    ),
  recommendation_quote: z
    .string()
    .nullable()
    .optional()
    .describe(
      "The span (list item or sentence) that constitutes the recommendation. " +
        "Null when recommendation_present=false. Must be a substring of the answer."
    ),
});

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

// ---------------------------------------------------------------------------
// zodToGeminiSchema
// ---------------------------------------------------------------------------

/**
 * Converts the JudgeVerdict Zod schema to a JSON Schema object suitable for
 * Gemini's `responseSchema` field in forced-JSON mode.
 *
 * Only covers the subset of Zod types used in JudgeVerdict (object, string,
 * number, boolean, enum, array, nullable, .describe()).
 *
 * Returns a plain JS object — no Gemini imports (pure domain layer).
 */
export function zodToGeminiSchema(
  schema: z.ZodTypeAny
): Record<string, unknown> {
  return _convertZod(schema);
}

type JsonSchemaObject = Record<string, unknown>;

function _convertZod(schema: z.ZodTypeAny): JsonSchemaObject {
  // Unwrap ZodOptional / ZodNullable
  if (schema instanceof z.ZodNullable) {
    const inner = _convertZod(schema.unwrap());
    // Gemini JSON Schema: represent nullable as anyOf or add "nullable: true"
    // Gemini's responseSchema supports a "nullable" boolean extension.
    return { ...inner, nullable: true };
  }

  if (schema instanceof z.ZodOptional) {
    return _convertZod(schema.unwrap());
  }

  // Unwrap ZodDefault — a `.default(x)` field's wire type is its INNER type.
  // Without this, `z.array(...).default([])` fell through to the string fallback,
  // so Gemini emitted a plain string (or CSV) instead of an array and the strict
  // BrandBriefSchema.safeParse rejected it (PARSE_FAILED). Affects every structured
  // call whose schema has a defaulted field.
  if (schema instanceof z.ZodDefault) {
    return _convertZod(schema._def.innerType as z.ZodTypeAny);
  }

  // Unwrap ZodEffects (.refine / .superRefine / .transform) to its base schema.
  if (schema instanceof z.ZodEffects) {
    return _convertZod(schema._def.schema as z.ZodTypeAny);
  }

  const description: string | undefined = schema.description;

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchemaObject> = {};
    const required: string[] = [];

    for (const [key, val] of Object.entries(shape)) {
      properties[key] = _convertZod(val);
      // Required unless the field is optional or has a default (Gemini may omit it).
      if (!(val instanceof z.ZodOptional) && !(val instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    const result: JsonSchemaObject = {
      type: "object",
      properties,
    };
    if (required.length > 0) result["required"] = required;
    if (description) result["description"] = description;
    return result;
  }

  if (schema instanceof z.ZodArray) {
    const result: JsonSchemaObject = {
      type: "array",
      items: _convertZod(schema.element),
    };
    if (description) result["description"] = description;
    return result;
  }

  if (schema instanceof z.ZodEnum) {
    const result: JsonSchemaObject = {
      type: "string",
      enum: schema.options as string[],
    };
    if (description) result["description"] = description;
    return result;
  }

  // ZodLiteral — a single fixed value (e.g. a discriminated-union tag like
  // content_type: z.literal('definition_sentence')). Without this case it fell
  // to the fallback and Gemini returned {} for the discriminator, failing the
  // strict union parse. Emit a single-value enum so Gemini must echo the literal.
  if (schema instanceof z.ZodLiteral) {
    const val = (schema as z.ZodLiteral<unknown>).value;
    const t = typeof val === "number" ? "number" : typeof val === "boolean" ? "boolean" : "string";
    const result: JsonSchemaObject = { type: t, enum: [val] };
    if (description) result["description"] = description;
    return result;
  }

  if (schema instanceof z.ZodBoolean) {
    const result: JsonSchemaObject = { type: "boolean" };
    if (description) result["description"] = description;
    return result;
  }

  if (schema instanceof z.ZodString) {
    const result: JsonSchemaObject = { type: "string" };
    if (description) result["description"] = description;
    return result;
  }

  if (schema instanceof z.ZodNumber) {
    // Check for integer refinements
    const checks = (schema as z.ZodNumber)._def.checks as Array<{
      kind: string;
    }>;
    const isInt = checks.some((c) => c.kind === "int");
    const result: JsonSchemaObject = { type: isInt ? "integer" : "number" };
    if (description) result["description"] = description;
    return result;
  }

  // Fallback — should not be reached for JudgeVerdict or any concrete content schema.
  // Emitting type:"object" instead of type:"string" is safer: a z.unknown()/z.any()
  // field in a responseSchema should not force Gemini to serialize an arbitrary
  // object as a string.  The PRIMARY fix is per-format concrete schemas in
  // generateContentForLanguage.ts; this is a defensive backstop.
  return { type: "object" };
}
