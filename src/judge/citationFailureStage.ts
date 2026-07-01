/**
 * src/judge/citationFailureStage.ts — deterministic CITATION-FAILURE-STAGE
 * classifier for the AEO/GEO platform.
 *
 * PURPOSE
 * -------
 * Given already-captured Gemini grounding metadata for ONE answer, classify the
 * EARLIEST stage at which a TARGET domain dropped out of the retrieval→citation
 * funnel. Three of the four failure stages are fully deterministic on the boolean
 * signals that the engine ships with every answer. The fourth stage ("extraction")
 * depends on an optional `absorptionWeight` signal that is produced by a sibling
 * feature (not yet universally available); when the signal is absent, the
 * classifier returns "none" rather than guessing.
 *
 * §0-SAFE: this module reads only engine-returned metadata passed in by the
 * caller — it never fetches any URL, never reads from pg, and has no IO.
 *
 * CITATION-FUNNEL STAGES (in precedence order, earliest-drop-out wins):
 *
 *   retrieval  : target domain was never retrieved (not in fetchedDomains), AND
 *                brand was NOT mentioned in answer text.
 *   attribution: target domain was never retrieved (not in fetchedDomains), BUT
 *                the brand WAS mentioned in answer text — the model "knew" the
 *                brand via training/context but did not ground it.
 *   reranking  : target domain was fetched but NOT cited (lost the citation slot
 *                during the model's internal ranking/selection step).
 *   extraction : target domain was cited but its absorptionWeight ≤ threshold —
 *                the citation exists yet contributes negligible support weight.
 *                ONLY asserted when absorptionWeight is provided; when undefined,
 *                falls through to "none".
 *   none       : target domain was cited and either (a) absorptionWeight is above
 *                the threshold, or (b) absorptionWeight is not available.
 *
 * TRUTH TABLE
 * -----------
 * fetched  cited  absorptionWeight          brandMentioned  → stage
 * -------  -----  -------------------------  --------------  --------
 * false    —      —                          false           retrieval
 * false    —      —                          true            attribution
 * true     false  —                          —               reranking
 * true     true   provided AND ≤ threshold   —               extraction
 * true     true   provided AND > threshold   —               none
 * true     true   undefined                  —               none
 *
 * NOTE: "attribution" is strictly the not-fetched+brand-mentioned case. The
 * reranking stage (fetched but not cited) does NOT branch on brandMentioned
 * because the brand-in-text signal is less diagnostic once a domain was actually
 * retrieved — the interesting gap is at the reranking/selection step.
 *
 * Reference: machinerelations.ai/research/content-structure-ai-citation-rates-2026
 */

/** The six possible outcomes of the citation-failure-stage classifier. */
export type CitationFailureStage =
  | "retrieval"
  | "reranking"
  | "extraction"
  | "attribution"
  | "none"
  | "unknown";

/**
 * Input bundle for one (targetDomain, answer) pair.
 *
 * fetchedDomains and citedDomains are already-computed registrable-domain arrays
 * from GroundingGap (src/judge/groundingGap.ts) — the caller is responsible for
 * building them from the grounding metadata before invoking this function.
 */
export interface FailureStageInput {
  /** Registrable domain under analysis, e.g. "emora.ai". */
  targetDomain: string;
  /** All registrable domains the model fetched (from groundingChunks). */
  fetchedDomains: string[];
  /** Subset of fetchedDomains that were actually cited (from groundingSupports). */
  citedDomains: string[];
  /** True when the brand name was found in the answer text (caller-supplied). */
  brandMentioned: boolean;
  /**
   * Optional absorption/support weight of the target domain's citation, in [0,1].
   * When present and ≤ extractionThreshold the stage is "extraction".
   * When absent, the extraction stage is NEVER asserted — falls through to "none".
   */
  absorptionWeight?: number;
}

/** Options that tune classifier thresholds. */
export interface ClassifyOptions {
  /**
   * Minimum absorptionWeight for a citation to count as "contributing".
   * Below or at this threshold → "extraction" failure.
   * Disclosed heuristic default: 0.05.
   */
  extractionThreshold?: number;
}

/** Heuristic default for the extraction threshold. */
const DEFAULT_EXTRACTION_THRESHOLD = 0.05;

/**
 * Classify the EARLIEST citation-failure stage for one (target, answer) pair.
 *
 * Precedence (see module doc truth table):
 *   1. not fetched + brand NOT mentioned → "retrieval"
 *   2. not fetched + brand mentioned     → "attribution"
 *   3. fetched + not cited               → "reranking"
 *   4. cited + absorptionWeight provided AND ≤ threshold → "extraction"
 *   5. cited + (absorptionWeight undefined OR > threshold) → "none"
 *
 * Returns "unknown" only if the inputs are internally contradictory in a way
 * that prevents classification (e.g., targetDomain appears in citedDomains but
 * NOT in fetchedDomains — data integrity violation).
 */
export function classifyCitationFailureStage(
  input: FailureStageInput,
  opts?: ClassifyOptions,
): CitationFailureStage {
  const threshold = opts?.extractionThreshold ?? DEFAULT_EXTRACTION_THRESHOLD;

  const { targetDomain, fetchedDomains, citedDomains, brandMentioned } = input;

  const isFetched = fetchedDomains.includes(targetDomain);
  const isCited = citedDomains.includes(targetDomain);

  // Integrity guard: cited without fetched is a data anomaly.
  if (isCited && !isFetched) return "unknown";

  // Step 1 & 2: not retrieved at all.
  if (!isFetched) {
    return brandMentioned ? "attribution" : "retrieval";
  }

  // Step 3: retrieved but not selected for citation.
  if (!isCited) return "reranking";

  // Steps 4 & 5: cited — check extraction signal.
  if (input.absorptionWeight !== undefined) {
    return input.absorptionWeight <= threshold ? "extraction" : "none";
  }

  // absorptionWeight not available → cannot assert extraction failure.
  return "none";
}

/** Per-stage counts over a collection of answers. */
export interface FailureStageHistogram {
  retrieval: number;
  reranking: number;
  extraction: number;
  attribution: number;
  none: number;
  unknown: number;
  total: number;
}

/**
 * Aggregate a flat array of per-answer stages into a histogram.
 * `total` equals `stages.length`.
 */
export function aggregateFailureStages(stages: CitationFailureStage[]): FailureStageHistogram {
  const hist: FailureStageHistogram = {
    retrieval: 0,
    reranking: 0,
    extraction: 0,
    attribution: 0,
    none: 0,
    unknown: 0,
    total: stages.length,
  };
  for (const s of stages) {
    hist[s] += 1;
  }
  return hist;
}
