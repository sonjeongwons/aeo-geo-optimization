/**
 * src/content/gates/jsonLdShape.ts
 *
 * T11 — jsonLdShapeGate (content_type='jsonld' only): structural JSON-LD
 * validation + re-run superlative and numeric checks over nested text.
 *
 * DESIGN-phase2.md §"JSON-LD":
 *   jsonLdShapeGate (folded in only for content_type='jsonld'):
 *   - Structurally asserts required @context/@type/required-fields.
 *   - Asserts the deferred-url token shape (url:{deferred:true,role:'owned_hub'}).
 *   - RE-RUNS the verifiableNumbers superlative lexicon + numeric-resolution check
 *     over the NESTED JSON-LD strings (articleBody/acceptedAnswer/description)
 *     so a 'best-in-class' or unsourced number cannot sneak into structured data
 *     after the prose gate pass.
 *
 * Acceptance criteria (from phase2-tasks.json T11):
 *   - jsonLdShape blocks a 'best-in-class' string inside articleBody.
 *
 * Gate is a NOP for non-jsonld assets (immediately passes).
 *
 * PURE: no I/O, no LLM, no network.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import { z } from "zod";
import enTerms from "../../../config/content-terms/en.json" with { type: "json" };
import koTerms from "../../../config/content-terms/ko.json" with { type: "json" };
import jaTerms from "../../../config/content-terms/ja.json" with { type: "json" };
import { DeferredUrlSchema, JsonLdSchema } from "../types.js";
import type { ContentGateContext, ContentGateResult } from "../types.js";
import { scanBodyForNumerics } from "../numericDetect.js";

// ---------------------------------------------------------------------------
// Superlative lexicon (same as verifiableNumbers.ts)
// ---------------------------------------------------------------------------

function getSuperlatives(language: string): readonly string[] {
  const lang = language.split("-")[0]?.toLowerCase() ?? "";
  switch (lang) {
    case "ko":
      return koTerms.superlatives;
    case "ja":
      return jaTerms.superlatives;
    default:
      return enTerms.superlatives;
  }
}

function isCjkLang(language: string): boolean {
  const lang = language.split("-")[0]?.toLowerCase() ?? "";
  return lang === "ko" || lang === "ja" || lang === "zh";
}

/**
 * Check if text contains any superlative terms.
 * Returns matched terms (first occurrence of each).
 */
function findSuperlativesInText(text: string, language: string): string[] {
  const superlatives = getSuperlatives(language);
  const isCjk = isCjkLang(language);
  const hits: string[] = [];

  if (isCjk) {
    for (const term of superlatives) {
      if (text.includes(term)) {
        hits.push(term);
      }
    }
  } else {
    const lowerText = text.toLowerCase();
    for (const term of superlatives) {
      const lowerTerm = term.toLowerCase();
      const pos = lowerText.indexOf(lowerTerm);
      if (pos === -1) continue;
      const before = pos > 0 ? lowerText[pos - 1] : " ";
      const after =
        pos + lowerTerm.length < lowerText.length
          ? lowerText[pos + lowerTerm.length]
          : " ";
      const beforeOk = before === undefined || !/[a-z0-9#]/.test(before);
      const afterOk = after === undefined || !/[a-z0-9-]/.test(after);
      if (beforeOk && afterOk) {
        hits.push(term);
      }
    }
  }

  return hits;
}

/**
 * Check if text contains bare numeric tokens (without resolved source).
 * Returns matched token strings.
 *
 * GB-01 fix: delegates to the shared script-aware detector so fullwidth digits,
 * CJK numeral chars, Arabic-Indic digits, and number-words are all caught.
 */
function findNumericsInText(text: string, language = "en"): string[] {
  return scanBodyForNumerics(text, language).map((h) => h.text);
}

// ---------------------------------------------------------------------------
// Extract nested text strings from a JSON-LD object
// ---------------------------------------------------------------------------

/**
 * Extract all string values from a nested JSON-LD object for scanning.
 * We specifically target the fields that may contain user-visible text:
 * - articleBody (Article)
 * - description (Organization)
 * - text (Answer.text in FAQPage acceptedAnswer)
 * - name (Question.name in FAQPage)
 * - headline (Article)
 * - knowsAbout[] (Organization)
 * - alternateName[] (Organization)
 *
 * We also recursively stringify any string values we encounter to catch
 * superlatives in deeply nested fields.
 */
function extractNestedStrings(obj: unknown, depth = 0): string[] {
  if (depth > 10) return []; // Prevent infinite recursion
  if (typeof obj === "string") return [obj];
  if (obj === null || typeof obj !== "object") return [];

  const results: string[] = [];

  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...extractNestedStrings(item, depth + 1));
    }
  } else {
    const record = obj as Record<string, unknown>;
    // Skip the @context, @type, url, sameAs (these are schema/URL fields, not prose)
    const skipKeys = new Set(["@context", "@type", "url", "sameAs", "deferred", "role"]);
    for (const [key, value] of Object.entries(record)) {
      if (skipKeys.has(key)) continue;
      if (typeof value === "string") {
        results.push(value);
      } else if (typeof value === "object" && value !== null) {
        results.push(...extractNestedStrings(value, depth + 1));
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Required fields check per @type
// ---------------------------------------------------------------------------

/**
 * Check that an Organization JSON-LD has the minimum required fields.
 */
const RequiredOrganizationFields = ["@context", "@type", "name", "url"] as const;

/**
 * Check that an Article JSON-LD has the minimum required fields.
 */
const RequiredArticleFields = [
  "@context",
  "@type",
  "headline",
  "articleBody",
  "inLanguage",
  "datePublished",
] as const;

/**
 * Check that a FAQPage JSON-LD has the minimum required fields.
 */
const RequiredFaqPageFields = ["@context", "@type", "mainEntity"] as const;

// ---------------------------------------------------------------------------
// jsonLdShapeGate
// ---------------------------------------------------------------------------

/**
 * jsonLdShapeGate
 *
 * Runs ONLY for content_type='jsonld' assets.
 * Immediately passes all non-jsonld assets (NOP).
 *
 * Checks:
 * 1. JsonLdSchema parse: validates @context/@type/required fields + deferred-url token.
 * 2. Per-type required fields (belt-and-suspenders beyond the zod schema).
 * 3. deferred-url: Organization.url must be a DeferredUrl token.
 * 4. Superlative scan over nested text strings → BLOCK.
 * 5. Numeric token scan over nested text strings → BLOCK (bare numerics in JSON-LD).
 *    NOTE: bare numerics in JSON-LD text are blocked outright because JSON-LD
 *    structured data has no claims[] binding mechanism for them.
 */
export const jsonLdShapeGate = {
  name: "jsonLdShapeGate",
  phase: "content" as const,

  apply(ctx: ContentGateContext): ContentGateResult {
    const { asset } = ctx;

    // NOP for non-jsonld assets
    if (asset.body.content_type !== "jsonld") {
      return { action: "pass", gate: "jsonLdShapeGate" };
    }

    const jsonLdBody = asset.body;
    const jsonLdObject = jsonLdBody.json;

    // ---- Check 1: Validate against JsonLdSchema ----
    const schemaResult = JsonLdSchema.safeParse(jsonLdObject);
    if (!schemaResult.success) {
      const issues = schemaResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return {
        action: "block",
        gate: "jsonLdShapeGate",
        reason: `JSON-LD schema validation failed: ${issues}`,
      };
    }

    const parsedJsonLd = schemaResult.data;
    const atType = parsedJsonLd["@type"];

    // ---- Check 2: Per-type required fields ----
    const rawObj = jsonLdObject as Record<string, unknown>;

    if (atType === "Organization") {
      const missingFields = RequiredOrganizationFields.filter(
        (f) => !(f in rawObj)
      );
      if (missingFields.length > 0) {
        return {
          action: "block",
          gate: "jsonLdShapeGate",
          reason: `Organization JSON-LD missing required fields: [${missingFields.join(", ")}]`,
        };
      }

      // ---- Check 3: Organization.url must be a DeferredUrl token ----
      const urlField = rawObj["url"];
      const deferredParse = DeferredUrlSchema.safeParse(urlField);
      if (!deferredParse.success) {
        return {
          action: "block",
          gate: "jsonLdShapeGate",
          reason:
            `Organization.url must be a deferred-url token {deferred:true, role:'owned_hub'} ` +
            `(the owned hub URL is resolved by Phase 3 IaC — §0). ` +
            `Got: ${JSON.stringify(urlField)}`,
        };
      }
    } else if (atType === "Article") {
      const missingFields = RequiredArticleFields.filter(
        (f) => !(f in rawObj)
      );
      if (missingFields.length > 0) {
        return {
          action: "block",
          gate: "jsonLdShapeGate",
          reason: `Article JSON-LD missing required fields: [${missingFields.join(", ")}]`,
        };
      }
    } else if (atType === "FAQPage") {
      const missingFields = RequiredFaqPageFields.filter(
        (f) => !(f in rawObj)
      );
      if (missingFields.length > 0) {
        return {
          action: "block",
          gate: "jsonLdShapeGate",
          reason: `FAQPage JSON-LD missing required fields: [${missingFields.join(", ")}]`,
        };
      }
    }

    // ---- Check 4 + 5: Superlative + numeric scan over nested text ----
    const nestedStrings = extractNestedStrings(parsedJsonLd);
    const allText = nestedStrings.join(" ");

    // Superlative scan
    const superlativeHits = findSuperlativesInText(allText, asset.language);
    if (superlativeHits.length > 0) {
      return {
        action: "block",
        gate: "jsonLdShapeGate",
        reason:
          `Superlative term(s) detected inside JSON-LD structured data: ` +
          `[${superlativeHits.map((s) => `"${s}"`).join(", ")}]. ` +
          `§7#2: superlatives in JSON-LD text are blocked (structured data cannot carry unbounded claims).`,
      };
    }

    // Numeric scan — bare numerics in JSON-LD text are always blocked because
    // JSON-LD structured data has no claims[] binding mechanism.
    // GB-01: use the shared script-aware scanner (handles CJK, fullwidth, etc.).
    // GB-03: the `|| numericToken.length <= 2` escape hatch is REMOVED — tokens
    // like '9%', '5x', '#1' are factual unbounded claims and must resolve to a
    // verified source regardless of their character length.
    const numericHits = findNumericsInText(allText, asset.language);
    if (numericHits.length > 0) {
      // Check if any resolved claim text contains the token.
      const resolvedClaims = asset.claims.filter(
        (c) => c.resolved_source_id !== null
      );

      const uncoveredNumerics: string[] = [];
      for (const numericToken of numericHits) {
        // A token is "covered" if a resolved claim's claim_text includes it.
        const covered = resolvedClaims.some((c) =>
          c.claim_text.includes(numericToken)
        );
        if (!covered) {
          uncoveredNumerics.push(numericToken);
        }
      }

      if (uncoveredNumerics.length > 0) {
        return {
          action: "block",
          gate: "jsonLdShapeGate",
          reason:
            `Bare numeric token(s) in JSON-LD text without verified source: ` +
            `[${uncoveredNumerics.map((n) => `"${n}"`).join(", ")}]. ` +
            `§7#2: numeric tokens in JSON-LD structured data must resolve to a verified claim_source.`,
        };
      }
    }

    return { action: "pass", gate: "jsonLdShapeGate" };
  },
} satisfies {
  name: string;
  phase: "content";
  apply(ctx: ContentGateContext): ContentGateResult;
};

// ---------------------------------------------------------------------------
// Re-export for barrel convenience
// ---------------------------------------------------------------------------

export type { ContentGateResult };
