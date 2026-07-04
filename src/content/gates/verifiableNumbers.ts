/**
 * src/content/gates/verifiableNumbers.ts
 *
 * T11 — verifiableNumbersGate (§7#2): STRUCTURAL check.
 *
 * DESIGN-phase2.md §"THE FIVE GATES":
 *   (a) Per-language superlative lexicon (config/content-terms/<lang>.json,
 *       VENDORED) rejects unbounded superlatives unless the span is a bounded
 *       sourced numeric claim.
 *   (b) Every numeric token in body MUST appear in claims[] as a numeric
 *       ClaimRecord with resolved_source_id; a bare number with no resolved
 *       source = block.
 *
 * NOTE: This gate checks the IN-MEMORY claims[] that have ALREADY gone through
 * claimVerify.ts (resolved_source_id set).  For the initial generation gate fold
 * (before claimExtract/claimVerify run), claims[] will be empty and the backstop
 * in claimVerificationGate will catch bare numerics.  This gate primarily enforces
 * the structural schema invariant: any numeric_claim_ids in AnswerBlock must
 * reference claims with resolved_source_id != null.
 *
 * Superlative check: if ANY superlative term appears in the body text and is NOT
 * covered by a claims[] entry with resolved_source_id != null → BLOCK.
 *
 * Numeric check (AnswerBlock): every claim_id in body.numeric_claim_ids must
 * resolve to a ClaimRecord in claims[] that has resolved_source_id != null.
 *
 * This gate is CHEAP (pure lexicon + structural check, no LLM) and runs EARLY
 * in the fold.
 *
 * PURE: no I/O, no LLM, no network.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import enTerms from "../../../config/content-terms/en.json" with { type: "json" };
import koTerms from "../../../config/content-terms/ko.json" with { type: "json" };
import jaTerms from "../../../config/content-terms/ja.json" with { type: "json" };
import type { ClaimRecord, ContentAsset, ContentGateContext, ContentGateResult } from "../types.js";
import { scanBodyForNumerics } from "../numericDetect.js";

// ---------------------------------------------------------------------------
// Superlative lexicon helpers
// ---------------------------------------------------------------------------

/**
 * Get the superlatives list for a given language.
 * Falls back to English for unsupported languages.
 */
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

/**
 * Check if the given language uses CJK script (substring search, no word boundary).
 */
function isCjkLang(language: string): boolean {
  const lang = language.split("-")[0]?.toLowerCase() ?? "";
  return lang === "ko" || lang === "ja" || lang === "zh";
}

/**
 * Find all superlative hits in a body text for a given language.
 * Returns matched terms.
 */
function findSuperlativeHits(
  text: string,
  language: string
): string[] {
  const superlatives = getSuperlatives(language);
  const isCjk = isCjkLang(language);
  const hits: string[] = [];

  if (isCjk) {
    // Substring search — no word boundaries in CJK
    for (const term of superlatives) {
      if (text.includes(term)) {
        hits.push(term);
      }
    }
  } else {
    // Case-insensitive word-boundary search
    const lowerText = text.toLowerCase();
    for (const term of superlatives) {
      const lowerTerm = term.toLowerCase();
      let idx = 0;
      while (true) {
        const pos = lowerText.indexOf(lowerTerm, idx);
        if (pos === -1) break;
        const before = pos > 0 ? lowerText[pos - 1] : " ";
        const after =
          pos + lowerTerm.length < lowerText.length
            ? lowerText[pos + lowerTerm.length]
            : " ";
        const beforeOk = before === undefined || !/[a-z0-9#]/.test(before);
        const afterOk = after === undefined || !/[a-z0-9-]/.test(after);
        if (beforeOk && afterOk) {
          hits.push(term);
          break; // count each superlative term once per text
        }
        idx = pos + 1;
      }
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Body text extraction
// ---------------------------------------------------------------------------

/**
 * Extract all text from a content asset body for superlative scanning.
 * Also returns all text-bearing strings (for nested JSON-LD the json field is
 * extracted by jsonLdShapeGate; here we only check prose content types).
 */
function extractBodyText(asset: ContentAsset): string {
  const body = asset.body;
  switch (body.content_type) {
    case "definition":
      return body.text;

    case "answer_block":
      return body.text;

    case "faq":
      return body.rows.map((r) => `${r.q} ${r.a}`).join(" ");

    case "comparison": {
      const cols = body.columns.join(" ");
      const rows = body.rows
        .map((r) => `${r.entity} ${r.cells.map((c) => c.value).join(" ")}`)
        .join(" ");
      return `${cols} ${rows}`;
    }

    case "case_study":
      return `${body.situation} ${body.action} ${body.result}`;

    case "jsonld":
      // JSON-LD superlative/numeric checks are handled by jsonLdShapeGate.
      // Here we do a quick scan of the serialized JSON to catch obvious cases.
      try {
        return JSON.stringify(body.json);
      } catch {
        return "";
      }
  }
}

// ---------------------------------------------------------------------------
// Numeric claim_id resolution check (AnswerBlock structural invariant)
// ---------------------------------------------------------------------------

/**
 * For AnswerBlock bodies: every claim_id in numeric_claim_ids must reference
 * a ClaimRecord in claims[] with resolved_source_id != null.
 *
 * Returns list of unresolved claim_ids (empty = all resolved).
 */
function findUnresolvedNumericClaimIds(
  asset: ContentAsset
): string[] {
  if (asset.body.content_type !== "answer_block") {
    return [];
  }

  const numericClaimIds = asset.body.numeric_claim_ids;
  if (numericClaimIds.length === 0) {
    return [];
  }

  // Build a map from claim_id to ClaimRecord for fast lookup
  const claimMap = new Map<string, ClaimRecord>(
    asset.claims.map((c) => [c.claim_id, c])
  );

  const unresolved: string[] = [];
  for (const claimId of numericClaimIds) {
    const claim = claimMap.get(claimId);
    if (claim === undefined) {
      // claim_id referenced in numeric_claim_ids but not in claims[] → unresolved
      unresolved.push(claimId);
    } else if (claim.resolved_source_id === null) {
      // claim exists but has no source binding → unresolved
      unresolved.push(claimId);
    }
  }

  return unresolved;
}

// ---------------------------------------------------------------------------
// verifiableNumbersGate
// ---------------------------------------------------------------------------

/**
 * verifiableNumbersGate (§7#2)
 *
 * STRUCTURAL gate — no LLM, no I/O.
 *
 * Blocks:
 * 1. Any superlative term found in the body that is NOT covered by a verified
 *    ClaimRecord with resolved_source_id != null.
 * 2. AnswerBlock: any claim_id in numeric_claim_ids that does not resolve to a
 *    ClaimRecord with resolved_source_id != null.
 *
 * NOTE: On first generation (before claimExtract/claimVerify), claims[] will
 * be empty.  This gate will block AnswerBlocks with numeric_claim_ids (correct —
 * the structural invariant requires sources BEFORE passing).  For definition/faq/
 * comparison/case_study/jsonld bodies, the superlative scan is the primary check.
 */
export const verifiableNumbersGate = {
  name: "verifiableNumbersGate",
  phase: "content" as const,

  apply(ctx: ContentGateContext): ContentGateResult {
    const { asset } = ctx;
    const bodyText = extractBodyText(asset);

    // ---- Superlative check ----
    const superlativeHits = findSuperlativeHits(bodyText, asset.language);
    if (superlativeHits.length > 0) {
      // Check if each superlative hit is covered by a resolved ClaimRecord.
      // A superlative is "covered" if ANY claim in claims[] has resolved_source_id != null
      // AND its claim_text contains (or is contained by) the superlative term.
      // If no claims at all → all superlatives are unbounded.
      // §7 INVARIANT (W1.1 P2): treating any resolved_source_id as "covered" is
      // safe ONLY because claimVerificationGate runs LAST and re-derives the
      // terminal verdict. W1.1 now persists resolved_source_id on needs_human/
      // rejected claims too, so if W1.2 reorders the binder earlier this MUST
      // become isClaimVerified(c) (verification==='verified') — see claimVerify.ts.
      const verifiedClaims = asset.claims.filter(
        (c) => c.resolved_source_id !== null
      );

      const unboundedSuperlatives: string[] = [];
      for (const term of superlativeHits) {
        const covered = verifiedClaims.some(
          (c) =>
            c.claim_text.toLowerCase().includes(term.toLowerCase()) ||
            term.toLowerCase().includes(c.claim_text.toLowerCase())
        );
        if (!covered) {
          unboundedSuperlatives.push(term);
        }
      }

      if (unboundedSuperlatives.length > 0) {
        return {
          action: "block",
          gate: "verifiableNumbersGate",
          reason:
            `Unbounded superlative(s) found with no verified source: ` +
            `[${unboundedSuperlatives.map((s) => `"${s}"`).join(", ")}]. ` +
            `§7#2: superlatives must be bounded by a verified sourced claim.`,
        };
      }
    }

    // ---- AnswerBlock numeric claim binding check ----
    const unresolvedNumericIds = findUnresolvedNumericClaimIds(asset);
    if (unresolvedNumericIds.length > 0) {
      return {
        action: "block",
        gate: "verifiableNumbersGate",
        reason:
          `AnswerBlock.numeric_claim_ids references ${unresolvedNumericIds.length} ` +
          `claim(s) without a resolved source: [${unresolvedNumericIds.join(", ")}]. ` +
          `§7#2: every numeric token must resolve to a verified claim_source row.`,
      };
    }

    // ---- GB-02: Script-aware body scan for ALL content types ----
    // Run the Unicode-aware numeric scanner over the full body text and require
    // that every detected numeric token be covered by a claims[] entry with
    // claim_kind='numeric' AND resolved_source_id != null.
    // This makes §7#2's bare-number rule a structural BLOCK gate independent
    // of the paid claim extractor, and catches numbers in all scripts
    // (CJK numerals, Arabic-Indic, Devanagari, fullwidth, number-words).
    const numericHits = scanBodyForNumerics(bodyText, asset.language);
    if (numericHits.length > 0) {
      const resolvedNumericClaims = asset.claims.filter(
        (c) => c.claim_kind === "numeric" && c.resolved_source_id !== null
      );

      const bareNumerics: string[] = [];
      for (const hit of numericHits) {
        // A numeric token is "covered" if a resolved numeric claim's span
        // overlaps the token's span.
        const covered = resolvedNumericClaims.some(
          (c) =>
            c.span.start < hit.span.end && hit.span.start < c.span.end
        );
        if (!covered) {
          bareNumerics.push(hit.text);
        }
      }

      if (bareNumerics.length > 0) {
        return {
          action: "block",
          gate: "verifiableNumbersGate",
          reason:
            `Bare numeric token(s) detected in body without a resolved claim_source: ` +
            `[${bareNumerics.map((n) => `"${n}"`).join(", ")}]. ` +
            `§7#2: every numeric token in any script must resolve to a verified claim_source row.`,
        };
      }
    }

    return {
      action: "pass",
      gate: "verifiableNumbersGate",
    };
  },
} satisfies {
  name: string;
  phase: "content";
  apply(ctx: ContentGateContext): ContentGateResult;
};
