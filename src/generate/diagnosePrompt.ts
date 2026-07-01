/**
 * src/generate/diagnosePrompt.ts
 *
 * PURE prompt builder for BrandBrief inference (T07 / Phase 1).
 *
 * Converts ExtractedSignals (from extractPage.ts) plus an optional industry
 * hint into the system instruction and user prompt that instruct Gemini to
 * infer a BrandBrief from evidence ONLY.
 *
 * Guardrails baked into the prompt text (DESIGN-phase1.md §"URL Diagnosis"):
 *   - Infer ONLY from the provided evidence; never hallucinate.
 *   - Mark low confidence when evidence is sparse.
 *   - Never invent metrics, numbers, or superlatives (§7#2).
 *   - Propose transliteration aliases for non-Latin markets.
 *   - Derive detectedLanguages from hreflang/HTML lang/content evidence.
 *
 * No IO, no imports beyond the shared ExtractedSignals type.
 */

import type { ExtractedSignals } from "./extractPage.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiagnosePromptParts {
  /** System instruction to pass as systemInstruction to generateStructured(). */
  systemInstruction: string;
  /** User-facing prompt containing the extracted signals. */
  userPrompt: string;
}

/**
 * Build the prompt parts for a BrandBrief inference call.
 *
 * @param signals  - Structured signals extracted from the customer URL.
 * @param industry - Optional industry hint (e.g. "ai-companion") from the
 *                   caller.  Used to seed the industryKey field and help
 *                   the model narrow its inference.
 * @returns { systemInstruction, userPrompt } ready for generateStructured().
 *
 * PURE: deterministic given the same inputs; no IO.
 */
export function buildDiagnosePrompt(
  signals: ExtractedSignals,
  industry?: string
): DiagnosePromptParts {
  const systemInstruction = buildSystemInstruction(industry);
  const userPrompt = buildUserPrompt(signals, industry);
  return { systemInstruction, userPrompt };
}

// ---------------------------------------------------------------------------
// System instruction
// ---------------------------------------------------------------------------

function buildSystemInstruction(industry?: string): string {
  const industryHint = industry
    ? `The caller suspects the industry is "${industry}" — use this as a starting point for industryKey but correct it if the evidence strongly suggests otherwise.`
    : `Infer the industryKey from the page content; emit a lowercase-hyphenated slug (e.g. "ai-companion", "kbeauty", "b2b-saas").`;

  return `You are a precise brand-intelligence analyst for an AEO/GEO measurement service.

Your task: analyse the page signals provided by the user and infer a BrandBrief JSON object.

STRICT EVIDENCE RULES (obey without exception):
1. Infer ONLY from the evidence supplied below — do not inject facts you know from pre-training unless they are unambiguous aliases/transliterations of a name that appears in the evidence.
2. Mark confidence low (< 0.4) when the page is a JS shell, has minimal text, or the evidence is ambiguous.
3. NEVER invent metrics, market-share numbers, performance claims, or superlatives (e.g. "best", "leading", "fastest"). If the page says "fastest" you may quote it, but do not add such claims yourself.
4. For non-Latin brand/competitor names, propose transliteration aliases (e.g. Japanese エモーラ, Korean 에모라) ONLY if they are derivable from the page content or are standard romanisation rules; otherwise leave brandAliases minimal.
5. Competitors are inferred from LLM knowledge and page signals — NEVER fabricated; keep seedCompetitors to 3–8 plausible entries.

LANGUAGE DETECTION:
- Derive detectedLanguages from hreflang link tags (each distinct lang is evidence), the HTML lang attribute, and visible non-English text blocks.
- Assign weight 1.0 to the primary language (most hreflang entries or the html[lang]).
- Other languages receive weight proportional to the number of hreflang entries (e.g. 8 hreflang pages → 8/total share).
- Always include at least one language entry (default to "en" with weight 1.0 and rationale "no hreflang found; defaulting to English").

INDUSTRY KEY:
${industryHint}

CATEGORY (REQUIRED, never empty):
- "category" MUST be a non-empty, concise human-readable product/service category (e.g. "AI companion app", "AI skin-analysis web app").
- When page evidence is SPARSE OR ABSENT (e.g. industry-only diagnosis with no URL), derive "category" — and likewise the generic, NON-factual descriptive fields icp / productAttributes / positioning — from the industry hint itself. These descriptive category/use-case fields are NOT metrics or superlatives, so deriving them from the industry is allowed; rule 3 (no invented numbers/superlatives) still applies in full, and set confidence low (< 0.4) to reflect the thin evidence.

OUTPUT FORMAT:
Return a single JSON object matching the BrandBrief schema. Arrays are [] when empty; confidence is a float [0, 1]. brandName, category and industryKey must each be NON-EMPTY strings.`;
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

function buildUserPrompt(signals: ExtractedSignals, industry?: string): string {
  const parts: string[] = [];

  parts.push("## PAGE SIGNALS");
  parts.push("");

  // Title
  if (signals.title) {
    parts.push(`**Page title:** ${signals.title}`);
  }

  // Meta description
  if (signals.metaDescription) {
    parts.push(`**Meta description:** ${signals.metaDescription}`);
  }

  // Open Graph
  const ogEntries = Object.entries(signals.ogMeta);
  if (ogEntries.length > 0) {
    parts.push("**Open Graph metadata:**");
    for (const [key, val] of ogEntries) {
      parts.push(`  og:${key}: ${val}`);
    }
  }

  // Twitter Card
  const twEntries = Object.entries(signals.twitterMeta);
  if (twEntries.length > 0) {
    parts.push("**Twitter Card metadata:**");
    for (const [key, val] of twEntries) {
      parts.push(`  twitter:${key}: ${val}`);
    }
  }

  // HTML lang attribute
  if (signals.htmlLang) {
    parts.push(`**HTML lang attribute:** ${signals.htmlLang}`);
  }

  // hreflang entries
  if (signals.hreflang.length > 0) {
    const hreflangLines = signals.hreflang
      .slice(0, 30)
      .map((e) => `  ${e.lang}: ${e.href}`)
      .join("\n");
    parts.push(`**hreflang alternate links (${signals.hreflang.length} total):**\n${hreflangLines}`);
  }

  // JSON-LD entities
  if (signals.jsonLd.length > 0) {
    parts.push("**JSON-LD entities:**");
    for (const entity of signals.jsonLd) {
      const fields: string[] = [`type: ${entity.type}`];
      if (entity.name) fields.push(`name: ${entity.name}`);
      if (entity.description) fields.push(`description: ${entity.description.slice(0, 300)}`);
      if (entity.sameAs && entity.sameAs.length > 0)
        fields.push(`sameAs: ${entity.sameAs.slice(0, 5).join(", ")}`);
      parts.push(`  { ${fields.join("; ")} }`);
    }
  }

  // Headings
  if (signals.headings.length > 0) {
    const headingLines = signals.headings
      .slice(0, 15)
      .map((h) => `  • ${h}`)
      .join("\n");
    parts.push(`**Page headings (h1–h3):**\n${headingLines}`);
  }

  // Navigation links
  if (signals.navLinks.length > 0) {
    const navLines = signals.navLinks
      .slice(0, 20)
      .map((l) => `  • ${l}`)
      .join("\n");
    parts.push(`**Navigation links:**\n${navLines}`);
  }

  // Body text
  if (signals.bodyText) {
    const excerpt = signals.bodyText.slice(0, 4_000);
    parts.push(`**Body text excerpt (up to 4 000 chars):**\n${excerpt}`);
  }

  // Optional industry hint
  if (industry) {
    parts.push("");
    parts.push(`**Caller-supplied industry hint:** ${industry}`);
  }

  // Degrade note for empty pages
  const isEmpty =
    !signals.title &&
    !signals.metaDescription &&
    !signals.bodyText &&
    signals.headings.length === 0 &&
    signals.jsonLd.length === 0;

  if (isEmpty) {
    parts.push("");
    parts.push(
      "**NOTE:** The page returned no extractable content (likely a JavaScript shell or empty page). " +
        "Set confidence to a low value (< 0.3) and infer as much as possible from the URL alone or the industry hint if provided."
    );
  }

  parts.push("");
  parts.push("Based on the signals above, return the BrandBrief JSON.");

  return parts.join("\n");
}
