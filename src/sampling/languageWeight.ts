/**
 * Language weighting and selection — DESIGN.md §5.3 / sampling design.
 *
 * Languages are ordered by weight (descending), then clamped to
 * `budget.max_languages`.  When trimming, we drop the LOWEST-priority
 * language first (deterministic lowest-first trim).
 *
 * For BASELINE runs, we include all PRIORITY languages regardless of
 * budget.max_languages (the spec says "baseline includes priority languages,
 * not English-only").  "Priority" = languages with weight > 1.0, or, if
 * none have weight > 1.0, all languages.
 *
 * Pure, no IO.
 */

import type { CustomerLanguage, LanguageCode } from "../domain/types.js";

// ---------------------------------------------------------------------------
// sortByWeight
// ---------------------------------------------------------------------------

/**
 * Sort a list of CustomerLanguage records by weight descending.
 * Ties are broken deterministically by language code ascending.
 */
export function sortByWeight(languages: CustomerLanguage[]): CustomerLanguage[] {
  return [...languages].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.language.localeCompare(b.language);
  });
}

// ---------------------------------------------------------------------------
// selectLanguages — operating cycle
// ---------------------------------------------------------------------------

/**
 * Select languages for an OPERATING cycle.
 *
 * 1. Sort by weight descending (lowest-first trim = take the TOP N).
 * 2. Clamp to `maxLanguages`.
 *
 * @param languages     Customer language records (from customer_language table).
 * @param maxLanguages  Budget cap (budget.max_languages).
 * @returns             Selected language codes, ordered by weight descending.
 */
export function selectLanguages(
  languages: CustomerLanguage[],
  maxLanguages: number
): LanguageCode[] {
  const sorted = sortByWeight(languages);
  // Take the top N (highest weight first); this is "lowest-priority trim".
  const selected = sorted.slice(0, maxLanguages);
  return selected.map((l) => l.language);
}

// ---------------------------------------------------------------------------
// selectBaselineLanguages — baseline run
// ---------------------------------------------------------------------------

/**
 * Select languages for a BASELINE run.
 *
 * Per DESIGN §5.3 note: "Baseline includes the customer's PRIORITY LANGUAGES
 * (not English-only)."
 *
 * Priority languages = languages with above-average weight OR weight >= 1.0.
 * If ALL languages have weight = 1.0 (uniform), return ALL of them (up to
 * maxLanguages) so the baseline is always multilingual.
 *
 * @param languages     Customer language records.
 * @param maxLanguages  Soft cap; baseline INCLUDES all priority languages
 *                      even if > maxLanguages.  Hard cap at total language count.
 * @returns             Selected language codes for the baseline run.
 */
export function selectBaselineLanguages(
  languages: CustomerLanguage[],
  maxLanguages: number
): LanguageCode[] {
  if (languages.length === 0) return [];

  const sorted = sortByWeight(languages);
  const maxWeight = sorted[0]?.weight ?? 1.0;
  const minWeight = sorted[sorted.length - 1]?.weight ?? 1.0;

  // If all weights are equal, include all languages (they are all "priority").
  if (maxWeight === minWeight) {
    return sorted.slice(0, Math.max(maxLanguages, 1)).map((l) => l.language);
  }

  // Priority = weight above the median weight, with a minimum of 1 language.
  // We consider "priority" to be languages with weight > 1.0 (the default).
  const priorityThreshold = 1.0;
  const priority = sorted.filter((l) => l.weight >= priorityThreshold);

  if (priority.length === 0) {
    // Fall back: take the single highest-weight language.
    return [sorted[0]!.language];
  }

  // Take priority languages; ensure at least 1 even if none meet threshold.
  return priority.map((l) => l.language);
}

// ---------------------------------------------------------------------------
// WeightedLanguageSelection (return type for callers)
// ---------------------------------------------------------------------------

export interface WeightedLanguageSelection {
  /** Ordered by weight descending. */
  selected: LanguageCode[];
  /** How many languages were trimmed due to budget cap. */
  trimmedCount: number;
}

/**
 * Full selection with metadata for plan.ts.
 */
export function selectLanguagesWithMeta(
  languages: CustomerLanguage[],
  maxLanguages: number,
  isBaseline: boolean
): WeightedLanguageSelection {
  if (isBaseline) {
    const selected = selectBaselineLanguages(languages, maxLanguages);
    return {
      selected,
      trimmedCount: Math.max(0, languages.length - selected.length),
    };
  }

  const selected = selectLanguages(languages, maxLanguages);
  return {
    selected,
    trimmedCount: Math.max(0, languages.length - selected.length),
  };
}
