/**
 * Shared brand_rank semantics module (DESIGN.md "domain/rank.ts").
 *
 * PINNED RULE (identical in judge prompt AND rule fallback — this is the
 * canonical single source of truth for rank semantics):
 *
 *   rank = 1-based ordinal of the entity's FIRST textual occurrence among
 *   {brand} ∪ {tracked competitors} ordered by character offset.
 *   NOT "all named entities" — only the tracked entity set.
 *   TIE-BREAK (apply in this exact order):
 *     1. Earlier character offset of the entity's earliest-matching alias wins.
 *     2. If two entities share the SAME earliest alias offset, break ties
 *        alphabetically by entity canonical name (localeCompare ascending).
 *   This tie-break is stated byte-identically in RANK_RULE_DOCSTRING (the judge
 *   prompt) and implemented in computeRank / computeAllRanks below.
 *
 * rank-agreement.test.ts asserts that the judge prompt rule and computeRank
 * produce IDENTICAL ranks on the same fixtures, making Visibility
 * (Σ(1/rank)/N) provenance-independent.
 *
 * Pure — no IO, no pg, no @google/genai.
 */

// ---------------------------------------------------------------------------
// Canonical rank rule doc-string
// Reused verbatim in the judge prompt so the LLM and this function agree.
// ---------------------------------------------------------------------------

export const RANK_RULE_DOCSTRING = `\
Brand rank rule (apply IDENTICALLY for all entities):

rank = the 1-based ordinal position of an entity's FIRST occurrence in the answer
text, where all tracked entities (the brand AND every tracked competitor) are sorted
by the character offset of their earliest appearance.

Steps:
  1. For each tracked entity (brand + competitors), find the character offset of its
     FIRST occurrence (using any of its canonical name or aliases, NFC-normalized,
     case-insensitive). Take the EARLIEST offset among all aliases for that entity.
  2. Sort the found entities by that offset ascending.
  3. TIE-BREAK (MUST apply in this exact order for determinism):
       a. Earlier alias offset wins (step 2 already handles this).
       b. If two entities have the SAME earliest offset, the entity whose matching
          alias starts at the smaller offset wins (same as step 2).
       c. If offsets are truly equal (two aliases from different entities overlap at
          the same position), break ties alphabetically by the entity's CANONICAL
          NAME (Unicode code-point / localeCompare order, ascending).
  4. Assign rank 1 to the earliest, rank 2 to the second, etc.
  5. If an entity does not appear in the text, its rank is null (absent).
  6. Only the tracked entity set counts — untracked named entities are ignored.

Example: answer = "Replika is popular, but EMORA has better memory, and Character.AI
  is large." with brand=EMORA, competitors=[Character.AI, Replika]
  → Replika offset 0, EMORA offset ~25, Character.AI offset ~50
  → Replika rank=1, EMORA rank=2, Character.AI rank=3.

Tie-break example: if both EntityA and EntityB first appear at offset 10, the one
  whose canonical name sorts earlier alphabetically gets the lower rank number.
`;

// ---------------------------------------------------------------------------
// Entity descriptor
// ---------------------------------------------------------------------------

export interface RankedEntity {
  name: string;
  /** All name variants (canonical name + aliases), NFC-normalized. */
  aliases: string[];
}

// ---------------------------------------------------------------------------
// computeRank
// ---------------------------------------------------------------------------

/**
 * Find the 1-based rank of `brand` (identified by any alias) among the full
 * tracked entity set (`entities` = brand + competitors).
 *
 * @param answerText  The raw answer text (may be null → returns null).
 * @param entities    All tracked entities including the brand itself.
 *                    The brand entry MUST be present in this list.
 * @param brandName   The canonical name of the brand (matches an entry in `entities`).
 * @returns 1-based rank of the brand, or null if the brand is not found.
 *
 * Pure, deterministic, no side effects.
 */
export function computeRank(
  answerText: string | null | undefined,
  entities: RankedEntity[],
  brandName: string
): number | null {
  if (!answerText) return null;

  // Build a list of {entityName, firstOffset} for all entities that appear.
  const appearances: Array<{ name: string; firstOffset: number }> = [];

  for (const entity of entities) {
    const offset = findFirstOffset(answerText, entity.aliases);
    if (offset !== null) {
      appearances.push({ name: entity.name, firstOffset: offset });
    }
  }

  if (appearances.length === 0) return null;

  // Sort by firstOffset ascending; break ties alphabetically by name.
  appearances.sort((a, b) => {
    if (a.firstOffset !== b.firstOffset) return a.firstOffset - b.firstOffset;
    return a.name.localeCompare(b.name);
  });

  // Find the brand's position (1-based).
  const idx = appearances.findIndex((e) => e.name === brandName);
  if (idx === -1) return null;

  return idx + 1;
}

/**
 * Find the first character offset of any alias in `answerText`.
 * Matching is NFC-normalized, case-insensitive, diacritic-aware.
 *
 * Returns the smallest offset among all aliases, or null if none match.
 */
export function findFirstOffset(
  answerText: string,
  aliases: string[]
): number | null {
  const normalizedAnswer = normalizeForMatch(answerText);
  let best: number | null = null;

  for (const alias of aliases) {
    const normalizedAlias = normalizeForMatch(alias);
    if (!normalizedAlias) continue;

    const idx = normalizedAnswer.indexOf(normalizedAlias);
    if (idx !== -1) {
      if (best === null || idx < best) {
        best = idx;
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Normalisation helper (shared by evidence.ts and ruleFallback.ts)
// ---------------------------------------------------------------------------

/**
 * NFC-normalize + lower-case + basic diacritic fold.
 * Used in rank computation AND evidence verification so alias-matching is
 * consistent across the judge pipeline.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    // Fold typographic apostrophes (U+2019 ’, U+2018 ‘, U+02BC ʼ) to ASCII '
    // so negation/verb regexes written with straight apostrophes ("isn't",
    // "don't") match curly-apostrophe model output (SOTA v5 self-audit X6).
    // Safe to fold here: this runs AFTER recommendation.ts's stripQuoted, which
    // uses the curly forms as paired quote delimiters on the RAW text.
    .replace(/[’‘ʼ]/g, "'")
    // Strip combining diacritical marks (U+0300–U+036F) after NFD decomposition
    // then re-compose. This handles é→e, ü→u, etc. for transliterated brand names.
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC");
}

// ---------------------------------------------------------------------------
// computeAllRanks (convenience for rule fallback & judge prompt)
// ---------------------------------------------------------------------------

/**
 * Compute ranks for ALL entities (brand + competitors) in a single pass.
 * Returns a Map from entity canonical name to 1-based rank (absent = not in map).
 *
 * Used by ruleFallback.ts to populate competitors_found ranks and brand_rank
 * in a single O(n * m) scan.
 */
export function computeAllRanks(
  answerText: string | null | undefined,
  entities: RankedEntity[]
): Map<string, number> {
  const ranks = new Map<string, number>();
  if (!answerText) return ranks;

  const appearances: Array<{ name: string; firstOffset: number }> = [];

  for (const entity of entities) {
    const offset = findFirstOffset(answerText, entity.aliases);
    if (offset !== null) {
      appearances.push({ name: entity.name, firstOffset: offset });
    }
  }

  appearances.sort((a, b) => {
    if (a.firstOffset !== b.firstOffset) return a.firstOffset - b.firstOffset;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < appearances.length; i++) {
    const entry = appearances[i];
    if (entry !== undefined) {
      ranks.set(entry.name, i + 1);
    }
  }

  return ranks;
}
