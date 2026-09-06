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
import type { ClaimRecord, ClaimSourceRow, ContentAsset, ContentGateContext, ContentGateResult } from "../types.js";
import { scanBodyForNumerics, type NumericHit } from "../numericDetect.js";

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
 * CJK superlative false-positive guard (W1.7). A superlative term found by
 * substring search may actually be a fragment of a DIFFERENT, non-superlative
 * lexeme, OR part of a specific THIRD-PARTY PROPER NOUN rather than a
 * self-praising claim about the customer's own service. We stay
 * §7-conservative: only the clearly-non-superlative continuations/precedents
 * below are excused; a genuine superlative claim (e.g. 완벽하게, 최고) still
 * trips. Scoped exceptions:
 *   - 최대한  ("as much as possible" — an adverb, not a brand claim)
 *   - 최대 <number>  (a bounded quantifier, e.g. "최대 50%" — the NUMBER is still
 *     verified by the numeric path; the bare word is not a superlative).
 *   - 유튜브 프리미엄 / 유튜브 뮤직 프리미엄 — Google's product name (YouTube
 *     Premium), a fixed third-party proper noun a subscription reseller must
 *     name to describe what it resells — not a claim that the customer's OWN
 *     service is "premium". Any OTHER use of 프리미엄 (e.g. bare "프리미엄
 *     서비스") still trips.
 */
function isCjkSuperlativeException(term: string, before: string, after: string): boolean {
  if (term === "최대") {
    if (after.startsWith("한")) return true; // 최대한
    if (/^\s*\d/.test(after)) return true; // 최대 50% (bounded quantifier)
  }
  if (term === "프리미엄") {
    const trimmedBefore = before.trimEnd();
    if (trimmedBefore.endsWith("유튜브") || trimmedBefore.endsWith("뮤직")) return true; // 유튜브 (뮤직) 프리미엄
  }
  return false;
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
    // Substring search — no word boundaries in CJK — but skip occurrences that
    // are a known non-superlative continuation (W1.7).
    for (const term of superlatives) {
      let from = 0;
      let matched = false;
      while (true) {
        const pos = text.indexOf(term, from);
        if (pos === -1) break;
        const before = text.slice(Math.max(0, pos - 10), pos);
        const after = text.slice(pos + term.length);
        if (!isCjkSuperlativeException(term, before, after)) {
          matched = true;
          break;
        }
        from = pos + 1;
      }
      if (matched) hits.push(term);
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
// Cheap coverage against the customer's claim_source registry
//
// asset.claims (the LLM-extracted, per-asset ClaimRecord[]) is EMPTY at this
// point in the fold — claimExtract only runs inside claimVerificationGate,
// which is LAST and is SKIPPED once any earlier gate already blocked (see
// contentGate.ts "COST SHORT-CIRCUIT"). So a superlative/number that IS
// already in the customer's verified claim_source table (ctx.claimSources —
// populated from the DB at generation time, no LLM call) was being blocked
// here with no chance for the real verifier to ever see it.
//
// This is a $0, deterministic, conservative widening: it can only make the
// cheap gate MORE PERMISSIVE (let more assets reach claimVerificationGate),
// never less — a false "covered" here still has to survive the real paid
// verifier, which remains the authoritative §7 check. It does not weaken
// enforcement; it stops prematurely discarding content the paid gate would
// have accepted anyway.
// ---------------------------------------------------------------------------

/** A claim_source row counts as a usable cheap-gate source once it's signed. */
function isVerifiedSource(c: ClaimSourceRow): boolean {
  return c.verified_by !== null;
}

/**
 * True if `term` is covered by any verified claim_source row's claim_text
 * (same "contains either way" rule already used for asset.claims below).
 */
function isSuperlativeCoveredBySource(term: string, claimSources: ClaimSourceRow[]): boolean {
  const lowerTerm = term.toLowerCase();
  return claimSources.some(
    (c) =>
      isVerifiedSource(c) &&
      (c.claim_text.toLowerCase().includes(lowerTerm) || lowerTerm.includes(c.claim_text.toLowerCase()))
  );
}

/**
 * Korean multiplier suffixes that immediately follow a bare Arabic-digit run
 * with NO space (e.g. "6만원", "7천만원") — checked longest-first so a
 * compound like 천만 (10^7) isn't mis-read as 천 (10^3) + a stray 만.
 * scanBodyForNumerics only detects the digit span itself: 만/억/천/백 are
 * Hangul syllables, not the CJK ideographs (一二三...万億) its
 * CJK_NUMERAL_REGEX matches, so "6만" was previously detected as bare "6" —
 * a real number a fortiori different from any claim_source expressed as
 * 60000. This is the "7천만 partial detection" gap documented in
 * reference-korean-claim-binding.md; fixed here (not in numericDetect.ts
 * itself, to keep this change scoped to the coverage check rather than the
 * widely-shared scanner and its span/offset contract).
 */
const HANGUL_MULTIPLIERS: ReadonlyArray<readonly [string, number]> = [
  ["천만", 10_000_000],
  ["백만", 1_000_000],
  ["만", 10_000],
  ["억", 100_000_000],
  ["천", 1_000],
  ["백", 100],
];

function hangulMultiplierAfter(text: string): number {
  for (const [suffix, mult] of HANGUL_MULTIPLIERS) {
    if (text.startsWith(suffix)) return mult;
  }
  return 1;
}

/**
 * Parse the numeric value out of a detected token (e.g. "28", "24", "5%",
 * "9,900원" → 28, 24, 5, 9900; "6" immediately followed by "만원" in the body
 * → 60000) and check it against any verified numeric claim_source row's
 * numeric_value. Value-only match (no unit/context) — deliberately simple
 * since claimVerificationGate remains the precise, context-aware backstop
 * for anything this misses or mismatches.
 */
function isNumericCoveredBySource(hit: NumericHit, bodyText: string, claimSources: ClaimSourceRow[]): boolean {
  const match = hit.text.replace(/[,，]/g, "").match(/\d+(\.\d+)?/);
  if (!match) return false;
  let hitValue = Number(match[0]);
  if (Number.isNaN(hitValue)) return false;
  const after = bodyText.slice(hit.span.end, hit.span.end + 2);
  hitValue *= hangulMultiplierAfter(after);
  return claimSources.some((c) => {
    if (!isVerifiedSource(c) || c.claim_kind !== "numeric" || c.numeric_value === null) return false;
    const srcValue = Number(c.numeric_value);
    return !Number.isNaN(srcValue) && srcValue === hitValue;
  });
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
    const { asset, claimSources } = ctx;
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
        const covered =
          verifiedClaims.some(
            (c) =>
              c.claim_text.toLowerCase().includes(term.toLowerCase()) ||
              term.toLowerCase().includes(c.claim_text.toLowerCase())
          ) || isSuperlativeCoveredBySource(term, claimSources);
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
        // overlaps the token's span, OR its value matches a verified numeric
        // claim_source row directly (see isNumericCoveredBySource above).
        const covered =
          resolvedNumericClaims.some(
            (c) => c.span.start < hit.span.end && hit.span.start < c.span.end
          ) || isNumericCoveredBySource(hit, bodyText, claimSources);
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
