/**
 * src/content/claimVerify.ts
 *
 * T10 — Deterministic claim verify (resolve+decide+backstop, unit-normalized
 * bound).
 *
 * DESIGN-phase2.md §"Claim Verification (§7#7)" — BACKSTOP + RESOLVE + DECIDE:
 *
 * THREE STAGES (all PURE deterministic — NO LLM):
 *
 * (1) BACKSTOP: independent raw-body scan (superlative lexicon + numeric regex)
 *     over the body text.  Any flagged span whose character range overlaps NO
 *     extracted ClaimRecord → asset routes to needs_human.  This is the recall
 *     backstop: a numeric or superlative the extractor missed CANNOT silently pass.
 *
 * (2) RESOLVE: match each ClaimRecord to a claim_source row by text similarity
 *     (normalized contains/keyword match).  On match, STORE
 *     claim.resolved_source_id = that row's id (structural binding, no substring
 *     stamp).  For numeric claims, also perform a UNIT/SCALE-NORMALIZED bound
 *     compare: the claim's parsed {value,unit,bound} is checked against the
 *     source's stored {numeric_value,numeric_unit,numeric_bound}.
 *
 * (3) DECIDE (pure rule):
 *     - All claims verified         → 'pass'
 *     - Any numeric exceeding bound → 'block'
 *     - Any unresolved superlative/comparative, unsigned customer_attested source,
 *       or backstop-flagged-but-unextracted span → 'needs_human'
 *     - FAIL CLOSED: claims present but extraction empty/failed while backstop
 *       found spans → 'needs_human', NEVER 'pass'.
 *     - Empty asset (no claims, no backstop flags) → 'pass' (nothing to gate).
 *
 * NO auto-pass path trusts an LLM-authored in-asset source.
 * Resolution is ALWAYS against the EXTERNAL claim_source registry.
 *
 * PURE: no I/O, no network, no LLM.  Accepts pre-loaded claim_source rows.
 *
 * Node 22 ESM NodeNext — relative imports use .js extension.
 */

import type { ClaimRecord, ClaimSourceRow } from "./types.js";
import { scanBodyForNumerics } from "./numericDetect.js";

// ---------------------------------------------------------------------------
// Superlative lexicons (per-language, loaded at module init from T01 JSON)
// ---------------------------------------------------------------------------
// We import the JSON files directly (resolveJsonModule = true in tsconfig).
// These are the same files used by verifiableNumbersGate (T11) and the backstop.
// All keys are lower-cased for case-insensitive matching on non-CJK text.
//
// CJK superlatives are matched substring-first (no lowercasing needed).

import enTerms from "../../config/content-terms/en.json" with { type: "json" };
import koTerms from "../../config/content-terms/ko.json" with { type: "json" };
import jaTerms from "../../config/content-terms/ja.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Terminal decision returned by verifyAndDecide() for the asset.
 * Mirrors ContentGateResult.action from types.ts but is PURE (no gate metadata).
 */
export type VerifyDecision = "pass" | "block" | "needs_human";

/**
 * Per-claim verdict after resolve+decide.
 */
export interface ClaimVerdict {
  claim_id: string;
  /** Updated claim record with resolved_source_id and verification set. */
  claim: ClaimRecord;
  decision: "verified" | "block" | "needs_human";
  reason?: string;
}

/**
 * Backstop hit — a span in the raw body flagged by the independent scan.
 */
export interface BackstopHit {
  /** 'superlative' or 'numeric' */
  kind: "superlative" | "numeric";
  /** The matched text. */
  text: string;
  /** Character-offset span [start, end). */
  span: { start: number; end: number };
  /**
   * True if a ClaimRecord covers this span (overlap).
   * False means the extractor missed it → needs_human.
   */
  coveredByExtraction: boolean;
}

/**
 * Result of verifyAndDecide().
 */
export interface VerifyResult {
  /** Terminal asset decision. */
  decision: VerifyDecision;
  /**
   * Updated ClaimRecord[] with resolved_source_id and verification set.
   * Ordering is preserved from the input claims[].
   */
  claims: ClaimRecord[];
  /** Per-claim verdicts for audit/gate_report. */
  verdicts: ClaimVerdict[];
  /** Backstop scan hits (for gate_report). */
  backstopHits: BackstopHit[];
  /**
   * Human-readable summary reason for the terminal decision.
   * Used by the gate to populate ContentGateResult.reason.
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Superlative lexicon helpers
// ---------------------------------------------------------------------------

/**
 * Build a combined superlative set for a language.
 * For non-CJK languages the terms are lower-cased for case-insensitive matching.
 * For CJK (ja/ko) they are left as-is (substring match).
 */
function buildSuperlativeSet(language: string): readonly string[] {
  const lang = language.split("-")[0]?.toLowerCase() ?? "";
  switch (lang) {
    case "ko":
      return koTerms.superlatives;
    case "ja":
      return jaTerms.superlatives;
    // All other languages: use English list + lower-case for CI matching
    default:
      return enTerms.superlatives.map((s) => s.toLowerCase());
  }
}

/**
 * Check whether the body text contains a superlative from the lexicon.
 * Returns an array of BackstopHit items (one per match found).
 *
 * CJK languages use substring search; Latin scripts use case-insensitive
 * word-boundary search via a simple approach.
 */
function scanBodyForSuperlatives(
  bodyText: string,
  language: string
): Array<{ text: string; span: { start: number; end: number } }> {
  const hits: Array<{ text: string; span: { start: number; end: number } }> = [];
  const superlatives = buildSuperlativeSet(language);
  const lang = language.split("-")[0]?.toLowerCase() ?? "";
  const isCjk = lang === "ko" || lang === "ja" || lang === "zh";

  for (const term of superlatives) {
    if (isCjk) {
      // Substring search — CJK has no word boundaries
      let idx = 0;
      while (true) {
        const pos = bodyText.indexOf(term, idx);
        if (pos === -1) break;
        hits.push({ text: term, span: { start: pos, end: pos + term.length } });
        idx = pos + 1;
      }
    } else {
      // Case-insensitive search on lower-cased body
      const lowerBody = bodyText.toLowerCase();
      let idx = 0;
      while (true) {
        const pos = lowerBody.indexOf(term, idx);
        if (pos === -1) break;
        // Word boundary check: the char before and after must be non-alpha or edge
        const before = pos > 0 ? lowerBody[pos - 1] : " ";
        const after =
          pos + term.length < lowerBody.length
            ? lowerBody[pos + term.length]
            : " ";
        const beforeOk = before === undefined || !/[a-z0-9#]/.test(before);
        const afterOk = after === undefined || !/[a-z0-9-]/.test(after);
        if (beforeOk && afterOk) {
          hits.push({
            text: bodyText.slice(pos, pos + term.length),
            span: { start: pos, end: pos + term.length },
          });
        }
        idx = pos + 1;
      }
    }
  }

  return hits;
}

// scanBodyForNumerics is imported from numericDetect.ts (GB-01 fix).
// The shared implementation handles: NFKC normalization, \p{Nd} with u flag
// for Devanagari/Arabic-Indic digits, CJK numeral characters (一二三…万),
// fullwidth digits (FullWidth ５ → normalized to 5), and per-language
// number-word lexicons.  It is re-exported here so callers can use the
// language-aware version; the local invocation below passes the language arg.

// ---------------------------------------------------------------------------
// Unit normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a numeric value to a canonical unit for comparison.
 * Currently handles:
 *   - Percentage (%, percent): value as-is
 *   - Multiplier (x, times): value as-is
 *   - Large number suffixes: k=1000, m/million=1e6, b/billion=1e9
 *
 * Returns {value: number, unit: string (canonical)} or null if
 * the units are incompatible (cannot compare).
 */
function normalizeNumeric(
  value: number,
  unit: string
): { value: number; canonicalUnit: string } | null {
  const u = unit.trim().toLowerCase();

  // Percentage family
  if (u === "%" || u === "percent") {
    return { value, canonicalUnit: "%" };
  }

  // Multiplier family: "x", "times"
  if (u === "x" || u === "times") {
    return { value, canonicalUnit: "x" };
  }

  // Large number suffixes. Only SCALE on unambiguous forms. The bare single
  // letters "m" and "b" are dangerously ambiguous (m = months/minutes/meters
  // OR million; b = billion OR ...), and the unit string is free-form
  // LLM-parsed text — silently scaling "6 m" (months) to 6,000,000 corrupts the
  // comparison. Fail closed: ambiguous bare m/b → null (incompatible →
  // needs_human), never a miscompared magnitude (SOTA v5 self-audit X4).
  if (u === "k" || u === "thousand") {
    return { value: value * 1_000, canonicalUnit: "count" };
  }
  if (u === "million") {
    return { value: value * 1_000_000, canonicalUnit: "count" };
  }
  if (u === "billion") {
    return { value: value * 1_000_000_000, canonicalUnit: "count" };
  }
  if (u === "m" || u === "b") {
    return null; // ambiguous magnitude-vs-unit — fail closed
  }

  // Currency — canonicalize KRW aliases so a claim written in Korean "원" binds
  // to a source stored as "KRW" (the ASCII unit). Korean fee/salary facts
  // (참가비 50,000원, 연봉 7천만원) are numeric §7 claims; without this the claim
  // unit "원" ≠ source "krw" made them INCOMPATIBLE → never bound → the
  // verifiableNumbers gate blocked the page. Korean myriad currency units are
  // scaled (만원 = 10^4 KRW, 억원 = 10^8 KRW) so either value form matches.
  if (u === "원" || u === "krw" || u === "won" || u === "₩") {
    return { value, canonicalUnit: "krw" };
  }
  if (u === "천원") return { value: value * 1_000, canonicalUnit: "krw" };
  if (u === "만원") return { value: value * 10_000, canonicalUnit: "krw" };
  if (u === "억원") return { value: value * 100_000_000, canonicalUnit: "krw" };
  // USD aliases (parallel hygiene for $-denominated sources).
  if (u === "$" || u === "usd" || u === "dollar" || u === "dollars") {
    return { value, canonicalUnit: "usd" };
  }

  // Generic count / bare number (ms, s, users, stars, etc.)
  return { value, canonicalUnit: u };
}

/**
 * Check whether a claim's numeric value is WITHIN the bound stated by a
 * claim_source row, after unit/scale normalization.
 *
 * Rules (DESIGN-phase2.md §"Claim Verification"):
 *   source.bound = 'exact'   → claim.value must equal source.value (±1%)
 *   source.bound = 'upTo'    → claim.value must be <= source.value  (e.g. claim "30%" vs source "up to 50%" → PASS; claim "60%" → BLOCK)
 *   source.bound = 'atLeast' → claim.value must be >= source.value
 *
 * Returns:
 *   - 'within'     — claim is within the source bound
 *   - 'exceeds'    → should BLOCK
 *   - 'incompatible' — units cannot be compared; route to needs_human
 */
export function checkNumericBound(
  claimValue: number,
  claimUnit: string,
  sourceValue: number,
  sourceUnit: string,
  sourceBound: "exact" | "upTo" | "atLeast"
): "within" | "exceeds" | "incompatible" {
  const normClaim = normalizeNumeric(claimValue, claimUnit);
  const normSource = normalizeNumeric(sourceValue, sourceUnit);

  if (normClaim === null || normSource === null) {
    return "incompatible";
  }

  // Units must be the same canonical unit to compare
  if (normClaim.canonicalUnit !== normSource.canonicalUnit) {
    return "incompatible";
  }

  const cv = normClaim.value;
  const sv = normSource.value;

  switch (sourceBound) {
    case "exact": {
      // Allow ±1% tolerance for floating point, with an absolute floor so a
      // zero-valued source ("0% downtime", "zero defects") doesn't collapse the
      // relative tolerance to 0 and block on float drift (SOTA v5 self-audit X5).
      const tolerance = Math.max(Math.abs(sv) * 0.01, 1e-9);
      return Math.abs(cv - sv) <= tolerance ? "within" : "exceeds";
    }
    case "upTo":
      // Claim says "30%", source says "up to 50%" → 30 <= 50 → within
      // Claim says "60%", source says "up to 50%" → 60 > 50 → exceeds
      return cv <= sv ? "within" : "exceeds";
    case "atLeast":
      // Claim says "2x", source says "at least 1.5x" → 2 >= 1.5 → within
      return cv >= sv ? "within" : "exceeds";
  }
}

// ---------------------------------------------------------------------------
// Span overlap helper
// ---------------------------------------------------------------------------

/**
 * Check if two character-offset spans overlap.
 * [a1, a2) overlaps [b1, b2) iff a1 < b2 && b1 < a2.
 */
function spansOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean {
  return a.start < b.end && b.start < a.end;
}

// ---------------------------------------------------------------------------
// Claim text matching against claim_source registry
// ---------------------------------------------------------------------------

/**
 * Find the best matching claim_source row for a given ClaimRecord.
 *
 * GB-04 fix: for numeric/comparative claims, require UNIT COMPATIBILITY as a
 * precondition of binding so a claim about "50% faster onboarding" is never
 * bound to a source about "50% off price" even if both share keyword overlap.
 *
 * Matching strategy (deterministic, no embedding/LLM):
 * 1. Normalize both texts (lower-case, trim).
 * 2. For numeric claims: filter candidate sources to those whose canonical unit
 *    matches the claim's canonical unit.  A unit-mismatched source is skipped
 *    even on exact text match.
 * 3. Exact match (on unit-compatible candidates) → highest confidence.
 * 4. Contains match: source claim_text is contained in record claim_text, or vice versa.
 * 5. Keyword overlap: at least TWO-THIRDS (raised from ½) of the source's
 *    significant words appear in the claim, applied to unit-compatible candidates only.
 * 6. Among candidates meeting any criterion, prefer the one whose stored
 *    numeric_value is consistent with the claim value; tie-break by stable
 *    insertion order (id lexicographic sort for determinism).
 *
 * Returns the best matching row, or null.
 */
function findMatchingSource(
  claim: ClaimRecord,
  sources: ClaimSourceRow[]
): ClaimSourceRow | null {
  const claimNorm = claim.claim_text.toLowerCase().trim();
  const claimWords = tokenize(claimNorm);

  // For numeric claims, derive the canonical unit of the claim so we can
  // pre-filter sources to unit-compatible candidates only.
  let claimCanonicalUnit: string | null = null;
  if (claim.claim_kind === "numeric" && claim.numeric !== undefined) {
    const normResult = normalizeNumeric(claim.numeric.value, claim.numeric.unit);
    if (normResult !== null) {
      claimCanonicalUnit = normResult.canonicalUnit;
    }
  }

  // Score candidates; pick the best one.
  // Score values: 3=exact, 2=contains, 1=keyword-overlap, 0=no match.
  let bestSource: ClaimSourceRow | null = null;
  let bestScore = -1;

  // Sort sources by id for stable insertion-order-independent tie-breaking.
  const sortedSources = [...sources].sort((a, b) => a.id.localeCompare(b.id));

  for (const src of sortedSources) {
    // GB-04: unit compatibility precondition for numeric claims.
    if (claim.claim_kind === "numeric" && claimCanonicalUnit !== null) {
      if (src.numeric_unit !== null) {
        const srcNorm = normalizeNumeric(
          parseFloat(src.numeric_value ?? "0"),
          src.numeric_unit
        );
        if (srcNorm === null || srcNorm.canonicalUnit !== claimCanonicalUnit) {
          // Incompatible unit — skip this source entirely for numeric claims.
          continue;
        }
      } else if (src.claim_kind === "numeric") {
        // Source is numeric but has no unit — cannot establish compatibility.
        continue;
      }
    }

    const srcNorm = src.claim_text.toLowerCase().trim();
    let score = 0;

    // Exact match
    if (claimNorm === srcNorm) {
      score = 3;
    } else if (claimNorm.includes(srcNorm) || srcNorm.includes(claimNorm)) {
      // Contains match
      score = 2;
    } else {
      // Keyword overlap — require >= 2/3 of source's significant words in claim
      // (raised from 0.5 to reduce false bindings on lexically similar claims).
      const srcWords = tokenize(srcNorm);
      if (srcWords.length > 0) {
        const overlap = srcWords.filter((w) => wordPresentIn(w, claimWords));
        // W1.10: require a DISTINCTIVE overlap word — a 2/3 overlap made only of
        // generic domain nouns (서비스/회원/service…) must not bind.
        if (overlap.length / srcWords.length >= 2 / 3 && overlap.some((w) => !isGenericNoun(w))) {
          score = 1;
        }
      }
      // §7-safe recall for SHORT paraphrased cells (comparison_table): a claim is
      // grounded BY a verified source when >= 2/3 of the CLAIM's significant words
      // appear in that (longer) source. The other direction above fails when the
      // cell is a terse paraphrase of a verbose source fact. Scoped to
      // capability/comparative kinds with a minimum claim length so a fabricated
      // or generic capability still binds to NOTHING (the words must really be
      // present in a signed source). Score stays 1 (lowest) — exact/contains win.
      if (
        score === 0 &&
        srcWords.length > 0 &&
        (claim.claim_kind === "capability" || claim.claim_kind === "comparative") &&
        claimWords.length >= 4
      ) {
        const claimInSrc = claimWords.filter((w) => wordPresentIn(w, srcWords));
        // W1.10: same distinctive-overlap requirement in the claim⊆source direction.
        if (claimInSrc.length / claimWords.length >= 2 / 3 && claimInSrc.some((w) => !isGenericNoun(w))) {
          score = 1;
        }
      }
    }

    // POLARITY GUARD (SOTA v4 self-audit fix): a lexical-overlap match must NOT
    // bind when the claim and source DISAGREE in polarity — e.g. claim "X does
    // not support Y" must never bind to source "X supports Y" (that would
    // false-verify a contradiction). Drop such matches → the claim resolves to
    // no source → needs_human (fail-closed §7).
    if (score > 0 && !polarityAgrees(claimNorm, srcNorm)) {
      score = 0;
    }

    if (score > bestScore) {
      bestScore = score;
      bestSource = src;
    }
  }

  return bestScore > 0 ? bestSource : null;
}

// Negation cues by language (en/ko/ja) — the engine is multilingual, so an
// English-only list would silently no-op on ko/ja and leave the bug live there.
const NEGATION_CUES: RegExp[] = [
  // English
  /\b(?:not|no|never|without|none|neither|nor|lacks?|lacking|unable|cannot|can't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|wouldn't|n't|fails? to|free of|absence of)\b/i,
  // Korean (negation morphemes/words)
  /(?:없|않|못하|못 |아니|불가|불가능|미지원|지원하지)/,
  // Japanese
  /(?:ない|ません|なし|不可|できない|対応していない)/,
];

/**
 * True when `claim` and `source` AGREE in polarity (both affirmative or both
 * negated). A polarity DISAGREEMENT means the source does NOT support the claim
 * (e.g. claim "X does not support Y" vs source "X supports Y"), so a lexical
 * overlap match must NOT bind — fixing a §7 false-verify (SOTA v4 self-audit).
 * Conservative: judged on PRESENCE of any negation cue in each text (XOR).
 */
function polarityAgrees(claimNorm: string, srcNorm: string): boolean {
  const claimNeg = NEGATION_CUES.some((re) => re.test(claimNorm));
  const srcNeg = NEGATION_CUES.some((re) => re.test(srcNorm));
  return claimNeg === srcNeg;
}

/**
 * Tokenize text into significant words (strip stopwords and punctuation).
 */
function tokenize(text: string): string[] {
  const stopwords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been",
    "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "up", "about", "into", "through", "during", "before", "after",
    "and", "but", "or", "so", "if", "as", "than", "that", "this",
    "we", "our", "you", "your", "it", "its", "has", "have", "had",
  ]);
  // Unicode-aware: keep letters (incl. Hangul/Kana/CJK + accented Latin) and
  // numbers, strip only punctuation/symbols. The prior [^a-z0-9] class deleted
  // ALL non-ASCII, so CJK claims tokenized to [] and the keyword-overlap tier
  // (incl. the capability/comparative 2/3 recall path) was dead for ko/ja — a
  // ko-only customer's capability claims could never bind via overlap. \p{L}
  // keeps CJK/accented letters; ASCII behavior is unchanged (a-z0-9 ⊂ \p{L}\p{N}).
  return text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopwords.has(w));
}

// CJK codepoint ranges (Hangul, Kana, CJK ideographs). Used to apply
// agglutination-aware stem matching ONLY to CJK tokens — Latin tokens keep
// exact-match semantics so English word-overlap behavior is unchanged.
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

/**
 * True if two tokens should be treated as the same significant word.
 *
 * Exact match always counts. For CJK tokens, ALSO count a stem/inflection match:
 * Korean is a suffixing/agglutinative language, so a source noun stem ("공간",
 * "회원", "검수", "서비스") appears in claims as "공간에서", "회원들이", "검수하여",
 * "서비스입니다". The ASCII tokenizer treated these as different words, so the
 * 2/3 keyword-overlap tier was unreachable for paraphrased Korean claims (they
 * fell through to needs_human even when semantically identical to a signed
 * source). We count a match when the shorter token is a >= 2-char PREFIX of the
 * longer (stem-at-start — exactly the Korean noun+particle shape). Bounded to
 * CJK + a 2-char floor so it never spuriously binds unrelated 1-char fragments.
 */
function wordMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (CJK_RE.test(a) && CJK_RE.test(b)) {
    // Shared STEM: Korean inflects nouns by suffixing particles, so paraphrases
    // differ at the tail on BOTH sides ("외모를"↔"외모에", "매니저가"↔"매니저의").
    // Neither is a prefix of the other, but they share the meaningful stem. Count
    // a match when the longest common prefix is >= 2 chars — a 2-char Korean stem
    // is a real morpheme, while a 1-char overlap ("직장"↔"직업" → "직") is not, so
    // this stays specific. The 2/3 word-overlap threshold + polarity guard bound
    // any residual false binding.
    let i = 0;
    const max = Math.min(a.length, b.length);
    while (i < max && a[i] === b[i]) i++;
    if (i >= 2) return true;
  }
  return false;
}

/** True if `word` matches any token in `list` (exact or CJK-stem, per wordMatch). */
function wordPresentIn(word: string, list: string[]): boolean {
  return list.some((w) => wordMatch(word, w));
}

/**
 * Generic, capability-neutral domain nouns (W1.10). These appear in almost every
 * claim/source of a given domain, so a 2/3 keyword overlap made up ONLY of these
 * would false-VERIFY an unrelated capability (e.g. an infinite-memory claim
 * binding to an image-generation source purely because both say "서비스"/
 * "service"). The overlap must therefore include >= 1 DISTINCTIVE (non-generic)
 * word. Matched via wordMatch so CJK inflections (서비스입니다 → 서비스) count.
 */
const GENERIC_DOMAIN_NOUNS: readonly string[] = [
  // Korean
  "서비스", "회원", "공간", "기능", "시스템", "플랫폼", "제공", "이용", "사용", "고객", "업체", "업계",
  // Japanese
  "サービス", "会員", "機能", "システム", "プラットフォーム", "提供", "利用", "顧客",
  // English
  "service", "services", "platform", "system", "feature", "features", "user", "users", "customer", "customers",
];

/** True when `word` is a generic capability-neutral domain noun. */
function isGenericNoun(word: string): boolean {
  return GENERIC_DOMAIN_NOUNS.some((g) => wordMatch(word, g));
}

// ---------------------------------------------------------------------------
// Extract text from ContentBody for backstop scanning
// ---------------------------------------------------------------------------

/**
 * Get a flat text representation of any content body for the backstop scan.
 * Must be FAST and deterministic (no parsing libraries).
 */
function extractTextForBackstop(body: unknown): string {
  if (body === null || typeof body !== "object") {
    return String(body ?? "");
  }
  const b = body as Record<string, unknown>;
  const contentType = b["content_type"] as string | undefined;

  switch (contentType) {
    case "definition":
    case "answer_block":
      return String(b["text"] ?? "");

    case "faq": {
      const rows = b["rows"];
      if (!Array.isArray(rows)) return "";
      return rows
        .map((r: unknown) => {
          if (r !== null && typeof r === "object") {
            const row = r as Record<string, unknown>;
            return `${String(row["q"] ?? "")} ${String(row["a"] ?? "")}`;
          }
          return "";
        })
        .join(" ");
    }

    case "comparison": {
      const cols = b["columns"];
      const rows = b["rows"];
      const colStr = Array.isArray(cols)
        ? cols.map((c: unknown) => String(c)).join(" ")
        : "";
      const rowStr = Array.isArray(rows)
        ? rows
            .map((r: unknown) => {
              if (r !== null && typeof r === "object") {
                const row = r as Record<string, unknown>;
                const cells = row["cells"];
                const cellStr = Array.isArray(cells)
                  ? cells
                      .map((c: unknown) => {
                        if (c !== null && typeof c === "object") {
                          return String(
                            (c as Record<string, unknown>)["value"] ?? ""
                          );
                        }
                        return "";
                      })
                      .join(" ")
                  : "";
                return `${String(row["entity"] ?? "")} ${cellStr}`;
              }
              return "";
            })
            .join(" ")
        : "";
      return `${colStr} ${rowStr}`.trim();
    }

    case "case_study":
      return [
        String(b["situation"] ?? ""),
        String(b["action"] ?? ""),
        String(b["result"] ?? ""),
      ].join(" ");

    case "jsonld": {
      const json = b["json"];
      try {
        return JSON.stringify(json ?? {});
      } catch {
        return "";
      }
    }

    default: {
      try {
        return JSON.stringify(b);
      } catch {
        return "";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// verifyAndDecide — main export
// ---------------------------------------------------------------------------

/**
 * Run the BACKSTOP + RESOLVE + DECIDE stages for a single asset.
 *
 * DESIGN-phase2.md §"Claim Verification (§7#7)":
 *
 * BACKSTOP  — independent raw-body scan (superlative + numeric regex).
 *             Any flagged span not covered by an extracted ClaimRecord → needs_human.
 *
 * RESOLVE   — match each ClaimRecord to a claim_source row; store resolved_source_id;
 *             for numeric claims, check unit-normalized bound.
 *
 * DECIDE    — pure rule:
 *   - all verified                        → 'pass'
 *   - any numeric exceeds bound           → 'block'
 *   - any unresolved superlative/comparative,
 *     unsigned customer_attested source,
 *     OR backstop-flagged-but-unextracted → 'needs_human'
 *   - FAIL CLOSED: claims present + extraction empty/failed + backstop found spans
 *                                          → 'needs_human'
 *   - No claims + no backstop flags        → 'pass'
 *
 * PURE: no I/O, no LLM. Callers supply pre-loaded claim_source rows.
 *
 * @param body         Asset body (unknown — duck-typed to text for backstop).
 * @param language     BCP-47 language code (drives superlative lexicon).
 * @param claims       Extracted ClaimRecord[] from claimExtract.ts (may be []).
 * @param sources      All claim_source rows for the customer.
 * @param extractionFailed  True when claimExtract returned ok:false.
 * @returns VerifyResult — never throws.
 */
/**
 * A claim is trustworthy-bound ONLY when it resolved to a source AND was
 * verified. Since W1.1 persists `resolved_source_id` even on `needs_human` and
 * `rejected` claims (previously discarded), a `resolved_source_id !== null`
 * check alone no longer implies "safe to surface" on a re-gate. The cheap
 * structural gates currently rely on `resolved_source_id !== null` and are
 * §7-safe ONLY because claimVerificationGate runs LAST and re-derives the
 * terminal verdict every fold. When W1.2 reorders/relaxes that ordering, those
 * gates MUST switch their "covered" predicate to this helper so honesty does
 * not depend on gate order (adversarial-review W1.1 P2).
 */
export function isClaimVerified(claim: ClaimRecord): boolean {
  return claim.resolved_source_id !== null && claim.verification === "verified";
}

export function verifyAndDecide(opts: {
  body: unknown;
  language: string;
  claims: ClaimRecord[];
  sources: ClaimSourceRow[];
  extractionFailed?: boolean;
}): VerifyResult {
  const {
    body,
    language,
    claims,
    sources,
    extractionFailed = false,
  } = opts;

  // ---- Stage 1: BACKSTOP SCAN ----------------------------------------
  const bodyText = extractTextForBackstop(body);

  const superlativeRawHits = scanBodyForSuperlatives(bodyText, language);
  const numericRawHits = scanBodyForNumerics(bodyText, language);

  // Build BackstopHit[] — mark whether each hit is covered by an extracted claim
  const backstopHits: BackstopHit[] = [];

  for (const hit of superlativeRawHits) {
    const covered = claims.some((c) => spansOverlap(c.span, hit.span));
    backstopHits.push({
      kind: "superlative",
      text: hit.text,
      span: hit.span,
      coveredByExtraction: covered,
    });
  }

  for (const hit of numericRawHits) {
    const covered = claims.some((c) => spansOverlap(c.span, hit.span));
    backstopHits.push({
      kind: "numeric",
      text: hit.text,
      span: hit.span,
      coveredByExtraction: covered,
    });
  }

  // Determine if any backstop hit was NOT covered by extraction
  const uncoveredHits = backstopHits.filter((h) => !h.coveredByExtraction);
  const hasUncoveredBackstop = uncoveredHits.length > 0;

  // ---- FAIL CLOSED: extraction failed but backstop found spans ----------
  // If extraction failed (ok:false) AND backstop found any numeric/superlative
  // spans in the body → needs_human.  NEVER auto-pass.
  if (extractionFailed && backstopHits.length > 0) {
    return {
      decision: "needs_human",
      claims: [...claims],
      verdicts: claims.map((c) => ({
        claim_id: c.claim_id,
        claim: c,
        decision: "needs_human",
        reason: "Extraction failed; backstop found unverified spans",
      })),
      backstopHits,
      reason: `Extraction failed and backstop detected ${backstopHits.length} unverified span(s) — fail closed`,
    };
  }

  // ---- No claims + no backstop flags → trivially pass ------------------
  if (claims.length === 0 && backstopHits.length === 0) {
    return {
      decision: "pass",
      claims: [...claims],
      verdicts: [],
      backstopHits: [],
    };
  }

  // ---- No claims but backstop found spans --------------------------------
  // This covers: extractionFailed=false but claims=[] while backstop found hits.
  // (Extractor returned empty but body has numeric/superlative content.)
  if (claims.length === 0 && backstopHits.length > 0) {
    return {
      decision: "needs_human",
      claims: [...claims],
      verdicts: [],
      backstopHits,
      reason: `No extracted claims but backstop detected ${backstopHits.length} span(s) — fail closed`,
    };
  }

  // ---- Stage 2: RESOLVE + Stage 3: DECIDE per claim --------------------
  const updatedClaims: ClaimRecord[] = [];
  const verdicts: ClaimVerdict[] = [];
  let hasBlock = false;
  let hasNeedsHuman = false;

  for (const claim of claims) {
    // Match to claim_source registry
    const matchedSource = findMatchingSource(claim, sources);

    if (matchedSource === null) {
      // No source row found
      if (
        claim.claim_kind === "superlative" ||
        claim.claim_kind === "comparative"
      ) {
        // Superlative/comparative with NO source → never auto-pass
        const updated: ClaimRecord = {
          ...claim,
          resolved_source_id: null,
          verification: "needs_human",
        };
        updatedClaims.push(updated);
        verdicts.push({
          claim_id: claim.claim_id,
          claim: updated,
          decision: "needs_human",
          reason: `${claim.claim_kind} claim has no matching claim_source row`,
        });
        hasNeedsHuman = true;
      } else if (claim.claim_kind === "numeric") {
        // Unresolved numeric claim — needs human to attach a source
        const updated: ClaimRecord = {
          ...claim,
          resolved_source_id: null,
          verification: "needs_human",
        };
        updatedClaims.push(updated);
        verdicts.push({
          claim_id: claim.claim_id,
          claim: updated,
          decision: "needs_human",
          reason: "Numeric claim has no matching claim_source row",
        });
        hasNeedsHuman = true;
      } else {
        // capability claim with no source → needs human (cannot auto-verify)
        const updated: ClaimRecord = {
          ...claim,
          resolved_source_id: null,
          verification: "needs_human",
        };
        updatedClaims.push(updated);
        verdicts.push({
          claim_id: claim.claim_id,
          claim: updated,
          decision: "needs_human",
          reason: "Capability claim has no matching claim_source row",
        });
        hasNeedsHuman = true;
      }
      continue;
    }

    // Source found — check sign-off for customer_attested rows
    if (
      matchedSource.source_kind === "customer_attested" &&
      matchedSource.verified_by === null
    ) {
      // Unsigned customer_attested → needs_human (not yet signed off)
      const updated: ClaimRecord = {
        ...claim,
        resolved_source_id: matchedSource.id,
        verification: "needs_human",
      };
      updatedClaims.push(updated);
      verdicts.push({
        claim_id: claim.claim_id,
        claim: updated,
        decision: "needs_human",
        reason: `Source row ${matchedSource.id} is customer_attested but not yet signed off (verified_by=null)`,
      });
      hasNeedsHuman = true;
      continue;
    }

    // Source found and is either signed or public_url/third_party_doc.
    // For numeric claims, perform unit-normalized bound check.
    if (claim.claim_kind === "numeric" && claim.numeric !== undefined) {
      const srcNumericValue = matchedSource.numeric_value;
      const srcNumericUnit = matchedSource.numeric_unit;
      const srcNumericBound = matchedSource.numeric_bound;

      if (
        srcNumericValue === null ||
        srcNumericUnit === null ||
        srcNumericBound === null
      ) {
        // Source has no numeric payload for a numeric claim → needs_human
        const updated: ClaimRecord = {
          ...claim,
          resolved_source_id: matchedSource.id,
          verification: "needs_human",
        };
        updatedClaims.push(updated);
        verdicts.push({
          claim_id: claim.claim_id,
          claim: updated,
          decision: "needs_human",
          reason: `Source row ${matchedSource.id} has no numeric payload for a numeric claim`,
        });
        hasNeedsHuman = true;
        continue;
      }

      // Perform unit-normalized bound check
      const sourceNumericValueNum = parseFloat(srcNumericValue);
      if (isNaN(sourceNumericValueNum)) {
        const updated: ClaimRecord = {
          ...claim,
          resolved_source_id: matchedSource.id,
          verification: "needs_human",
        };
        updatedClaims.push(updated);
        verdicts.push({
          claim_id: claim.claim_id,
          claim: updated,
          decision: "needs_human",
          reason: `Source row ${matchedSource.id} numeric_value is not a valid number: ${srcNumericValue}`,
        });
        hasNeedsHuman = true;
        continue;
      }

      const boundResult = checkNumericBound(
        claim.numeric.value,
        claim.numeric.unit,
        sourceNumericValueNum,
        srcNumericUnit,
        srcNumericBound
      );

      if (boundResult === "exceeds") {
        // Numeric claim exceeds the stated bound → BLOCK
        const updated: ClaimRecord = {
          ...claim,
          resolved_source_id: matchedSource.id,
          verification: "rejected",
        };
        updatedClaims.push(updated);
        verdicts.push({
          claim_id: claim.claim_id,
          claim: updated,
          decision: "block",
          reason: `Numeric claim ${claim.numeric.value}${claim.numeric.unit} exceeds source bound (${srcNumericBound} ${sourceNumericValueNum}${srcNumericUnit})`,
        });
        hasBlock = true;
        continue;
      }

      if (boundResult === "incompatible") {
        // Cannot compare units → needs_human
        const updated: ClaimRecord = {
          ...claim,
          resolved_source_id: matchedSource.id,
          verification: "needs_human",
        };
        updatedClaims.push(updated);
        verdicts.push({
          claim_id: claim.claim_id,
          claim: updated,
          decision: "needs_human",
          reason: `Incompatible units: claim="${claim.numeric.unit}" vs source="${srcNumericUnit}"`,
        });
        hasNeedsHuman = true;
        continue;
      }

      // boundResult === 'within' → verified
      const updated: ClaimRecord = {
        ...claim,
        resolved_source_id: matchedSource.id,
        verification: "verified",
      };
      updatedClaims.push(updated);
      verdicts.push({
        claim_id: claim.claim_id,
        claim: updated,
        decision: "verified",
        reason: `Numeric claim within source bound (${srcNumericBound} ${sourceNumericValueNum}${srcNumericUnit})`,
      });
      continue;
    }

    // Non-numeric claim with a matched, signed/verified source → verified
    const updated: ClaimRecord = {
      ...claim,
      resolved_source_id: matchedSource.id,
      verification: "verified",
    };
    updatedClaims.push(updated);
    verdicts.push({
      claim_id: claim.claim_id,
      claim: updated,
      decision: "verified",
    });
  }

  // ---- Derive terminal decision ----------------------------------------
  // Precedence: block > needs_human > pass
  // Also apply backstop: any uncovered span forces needs_human
  if (hasUncoveredBackstop) {
    hasNeedsHuman = true;
  }

  let decision: VerifyDecision;
  let reasonText: string | null = null;

  if (hasBlock) {
    decision = "block";
    const blockVerdicts = verdicts.filter((v) => v.decision === "block");
    reasonText = blockVerdicts.map((v) => v.reason).filter(Boolean).join("; ");
  } else if (hasNeedsHuman) {
    decision = "needs_human";
    const nhVerdicts = verdicts.filter((v) => v.decision === "needs_human");
    const backstopReasons = uncoveredHits.map(
      (h) => `Backstop detected uncovered ${h.kind} "${h.text}"`
    );
    reasonText = [...nhVerdicts.map((v) => v.reason).filter(Boolean), ...backstopReasons]
      .join("; ");
  } else {
    decision = "pass";
  }

  const baseResult = {
    decision,
    claims: updatedClaims,
    verdicts,
    backstopHits,
  };

  if (reasonText !== null && reasonText.length > 0) {
    return { ...baseResult, reason: reasonText };
  }
  return baseResult;
}
