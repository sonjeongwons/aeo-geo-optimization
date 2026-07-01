/**
 * src/generate/questionGuards.ts
 *
 * PURE deterministic gate fold for generated questions (T12).
 *
 * Mirrors the Phase 0 runGates pattern but scoped to DraftQuestion filtering
 * rather than judgment downgrading.  No IO, no LLM calls; fully testable.
 *
 * Rules (§7 guardrails):
 *   1. NON-LEADING / BRAND-STUFFING: reject any question containing the brand
 *      name or any brand alias UNLESS intentType === 'brand'.  Brand-leading
 *      forms corrupt SMR measurement by biasing the signal upward (§7#1).
 *   2. SUPERLATIVE / UNVERIFIABLE CLAIM: reject questions containing
 *      superlative or marketing-claim phrasing (best, #1, most, greatest,
 *      unmatched, unrivalled, unrivaled, top-rated, leading, etc.) regardless
 *      of intentType.  §7#2 (verified numbers only; questions carry no claims).
 *   3. MARKETING COPY: reject overt promotional / advertisement-style phrasing.
 *   4. CLOSED FORM (YES/NO): reject questions whose expected answer is purely
 *      yes or no.  These are not useful SMR probes.
 *   5. KEYWORD SALAD: reject questions that are a bare comma-/slash-separated
 *      keyword list unless tagged as a deliberate keyword-style variant
 *      (phrasingGroupId ends with ':kw').
 *
 * Exports:
 *   applyQuestionGuards(questions, brand, brandAliases) -> GuardResult
 *   type GuardResult  { kept: DraftQuestion[];  rejected: RejectedQuestion[] }
 *   type RejectedQuestion { question: DraftQuestion; reason: string }
 */

import type { DraftQuestion } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A question that was rejected by the guard fold with a reason. */
export interface RejectedQuestion {
  question: DraftQuestion;
  reason: string;
}

/** Result of the guard fold. */
export interface GuardResult {
  kept: DraftQuestion[];
  rejected: RejectedQuestion[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a string for fuzzy matching: NFC, lowercase, collapse whitespace.
 * Does NOT strip punctuation — we need whole-word matching.
 */
function normalise(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a brand-name matcher for a single alias string.
 *
 * For pure ASCII aliases we use a regex with \b word boundaries.
 * For non-ASCII aliases (CJK, Korean, Japanese kana, etc.) word-boundary
 * semantics don't apply because \b only works at ASCII word/non-word
 * transitions.  Instead, we return a simple substring-contains predicate
 * (any occurrence of the alias in the text means the brand name is present).
 * CJK aliases are long and specific enough that a substring match is correct.
 */
type Matcher = { test: (text: string) => boolean };

function buildNameMatcher(alias: string): Matcher {
  if (/^[\x00-\x7F]+$/.test(alias)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`\\b${escaped}\\b`, 'i');
    return rx;
  }
  // Non-ASCII: substring match (case-insensitive via normalised comparisons).
  const lower = alias.toLowerCase();
  return {
    test(text: string): boolean {
      return text.toLowerCase().includes(lower);
    },
  };
}

/**
 * Superlative / unverifiable claim patterns (§7#2).
 * English-centric list; the guardrail for non-English questions relies on
 * the prompt forbidding superlatives — the deterministic check here catches
 * LLM slippage in the most common surface forms.
 */
const SUPERLATIVE_PATTERNS: RegExp[] = [
  /\bbest\b/i,
  /(?<!\w)#\s*1(?!\w)/i,          // "#1" — \b does not work before '#'
  /\bnumber\s*[–-]?\s*one\b/i,
  /\bno\.\s*1\b/i,
  /\bmost\b/i,
  /\bgreatest\b/i,
  /\bunmatched\b/i,
  /\bunrivall?ed\b/i,
  /\btop[\s-]rated\b/i,
  /\btop[\s-]performing\b/i,
  /\bleading\b/i,           // "the leading app" → marketing claim
  /\bworld[\s-]class\b/i,
  /\bpeerless\b/i,
  /\bincomparable\b/i,
  /\bsuperior\b/i,
  /\bultimate\b/i,
  /\bpremier\b/i,
];

/**
 * Marketing / promotional copy patterns.
 * These surface when the LLM confuses questions with ad copy.
 */
const MARKETING_COPY_PATTERNS: RegExp[] = [
  /\btry\s+(it|now|today|free)\b/i,
  /\bsign\s+up\s+(now|today|free)\b/i,
  /\bget\s+started\s+(now|today|free)\b/i,
  /\bdownload\s+(now|today|free)\b/i,
  /\bfree\s+trial\b/i,
  /\bclaim\s+your\b/i,
  /\bexclusive\s+offer\b/i,
  /\blimited[\s-]time\b/i,
  /\bdiscount\b/i,
  /\bpromo\b/i,
  /\bcoupon\b/i,
];

/**
 * Closed-form yes/no question patterns.
 * Targets English; detects questions where expected answer is purely yes/no.
 */
const CLOSED_FORM_PATTERNS: RegExp[] = [
  /^(is|are|was|were|does|do|did|has|have|had|can|could|will|would|should|shall|may|might|must)\s+/i,
  /^(isn't|aren't|wasn't|weren't|doesn't|don't|didn't|hasn't|haven't|hadn't|can't|couldn't|won't|wouldn't|shouldn't)\s+/i,
];

/**
 * Keyword-salad heuristic: 3+ comma- or slash-separated tokens with no
 * verb or question word.  Short list, no trailing question mark.
 */
const QUESTION_WORDS = /\b(what|when|where|who|whom|whose|which|why|how|tell|explain|describe|compare|list|recommend|suggest|find|show)\b/i;
const KEYWORD_SALAD_PATTERN = /^[^?!.]*(?:[,/]\s*[^\s,/][^,/]*)(?:[,/]\s*[^\s,/][^,/]*){2,}[^?]*$/;

// ---------------------------------------------------------------------------
// Gate implementations
// ---------------------------------------------------------------------------

/**
 * Gate 1 — Brand-leading / non-leading guard.
 *
 * Rejects questions containing the brand name or any alias when intentType
 * is NOT 'brand'.  This prevents brand-stuffing outside brand-intent cells.
 *
 * If intentType IS 'brand', naming the brand is legitimate (e.g. "is EMORA free").
 */
function applyBrandLeadingGate(
  question: DraftQuestion,
  brandNameMatchers: Matcher[],
): string | null {
  // Brand-intent questions: brand naming is allowed.
  if (question.intentType === 'brand') {
    return null;
  }

  const text = question.text;
  for (const matcher of brandNameMatchers) {
    if (matcher.test(text)) {
      return `brand-leading: question contains brand name/alias in non-brand intent (${question.intentType})`;
    }
  }
  return null;
}

/**
 * Gate 2 — Superlative / unverifiable claim guard.
 *
 * Rejects any question containing superlative or marketing-claim language.
 * Applied regardless of intentType — even brand-intent questions should ask
 * neutral probes, not make claims.
 */
function applySuperlativeGate(question: DraftQuestion): string | null {
  const text = question.text;
  for (const rx of SUPERLATIVE_PATTERNS) {
    if (rx.test(text)) {
      return `superlative-claim: question contains unverifiable superlative/claim phrasing`;
    }
  }
  return null;
}

/**
 * Gate 3 — Marketing copy guard.
 *
 * Rejects overt promotional phrasing that has no place in SMR probe questions.
 */
function applyMarketingCopyGate(question: DraftQuestion): string | null {
  const text = question.text;
  for (const rx of MARKETING_COPY_PATTERNS) {
    if (rx.test(text)) {
      return `marketing-copy: question reads like advertising copy`;
    }
  }
  return null;
}

/**
 * Gate 4 — Closed-form yes/no guard.
 *
 * Rejects questions whose expected answer is purely yes or no.  These are
 * not useful SMR probes because they do not elicit brand mentions.
 *
 * Note: this heuristic is English-centric.  Non-English closed forms not
 * caught here are instead suppressed by the native generation prompt.
 * False-positives on genuine comparison questions that start with "does" (e.g.
 * "does EMORA support offline mode?") are accepted — they are brand-intent
 * questions and caught by Gate 1 anyway if the brand appears.  Non-brand
 * "does X compare to Y?" closed forms are legitimately rejected here.
 */
function applyClosedFormGate(question: DraftQuestion): string | null {
  const text = question.text.trim();
  for (const rx of CLOSED_FORM_PATTERNS) {
    if (rx.test(text)) {
      return `closed-form: yes/no question is not a useful SMR probe`;
    }
  }
  return null;
}

/**
 * Gate 5 — Keyword-salad guard.
 *
 * Rejects questions that are bare comma-/slash-separated keyword lists with
 * no interrogative or verb structure.  Exception: if the phrasingGroupId ends
 * with ':kw', the question is a deliberate keyword-style variant and is kept.
 */
function applyKeywordSaladGate(question: DraftQuestion): string | null {
  // Deliberate keyword variant — opt out of this gate.
  if (question.phrasingGroupId.endsWith(':kw')) {
    return null;
  }

  const text = question.text.trim();

  // If it has a question word / verb, it has structure — not salad.
  if (QUESTION_WORDS.test(text)) {
    return null;
  }

  if (KEYWORD_SALAD_PATTERN.test(text)) {
    return `keyword-salad: question is a bare keyword list with no interrogative structure`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply all question guardrail gates to a list of DraftQuestions.
 *
 * @param questions    - Generated DraftQuestions to filter.
 * @param brandName    - Canonical brand name (used for brand-leading check).
 * @param brandAliases - Additional brand alias strings (transliterations, etc.).
 * @returns GuardResult with kept[] and rejected[{question, reason}] arrays.
 *
 * Pure, deterministic, no IO.
 */
export function applyQuestionGuards(
  questions: DraftQuestion[],
  brandName: string,
  brandAliases: string[] = [],
): GuardResult {
  // Build matchers for all brand name forms once.
  const allBrandForms = [brandName, ...brandAliases].filter((s) => s.length > 0);
  // For ASCII aliases: normalise + word-boundary regex.
  // For non-ASCII aliases: pass the original form (CJK chars normalise to themselves).
  const brandNameMatchers = allBrandForms.map((form) => {
    const isAscii = /^[\x00-\x7F]+$/.test(form);
    return buildNameMatcher(isAscii ? normalise(form) : form);
  });

  const kept: DraftQuestion[] = [];
  const rejected: RejectedQuestion[] = [];

  for (const question of questions) {
    // Apply gates in order; first rejection wins (mirrors runGates short-circuit).
    const reason =
      applyBrandLeadingGate(question, brandNameMatchers) ??
      applySuperlativeGate(question) ??
      applyMarketingCopyGate(question) ??
      applyClosedFormGate(question) ??
      applyKeywordSaladGate(question);

    if (reason !== null) {
      rejected.push({ question, reason });
    } else {
      kept.push(question);
    }
  }

  return { kept, rejected };
}
