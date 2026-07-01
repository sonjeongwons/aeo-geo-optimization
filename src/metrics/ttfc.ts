/**
 * src/metrics/ttfc.ts — Time-To-First-Citation (TTFC) percentile KPI (X23).
 *
 * Measures the latency from when an owned-net asset enters tracking to its
 * first appearance as a citation in an answer-engine response. The caller is
 * responsible for grouping observations by engine before calling computeTtfc;
 * this module is intentionally engine-agnostic.
 *
 * §0-safe: reads engine-output data only — no URL fetching, no network.
 * PURE: no IO, no pg, fully deterministic.
 *
 * DB WIRING DEFERRED: the owned_asset_first_citation table + url_registry join
 * required to populate TtfcObservation from raw response records is not yet
 * implemented. This module accepts pre-shaped observations; the DB-backed
 * adapter (aggregate.ts) will supply them once that wiring lands.
 *
 * Estimation method: Kaplan-Meier (KM) survival analysis with right-censoring.
 * Assets that have not yet been cited are right-censored at (asOfMs −
 * observedSinceMs). We report cumulative-incidence percentiles (F = 1 − S)
 * rather than any mean: citation-latency distributions are heavy-tailed and
 * censored, making the mean undefined / unreliable. Per §7, NULL is returned
 * when a requested percentile is genuinely unreachable given the observed data
 * (i.e. censoring prevents the KM curve from crossing the threshold); we never
 * impute or extrapolate.
 *
 * Reference: nicklafferty AI-visibility-metrics-reference (TTFC definition for
 * owned-asset first-citation latency in AEO/GEO contexts).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One owned-net asset observed for first-citation latency. */
export interface TtfcObservation {
  /** Epoch-ms of the asset's first citation; null if not yet cited. */
  firstCitedAtMs: number | null;
  /** Epoch-ms when tracking of this asset began. */
  observedSinceMs: number;
  /** Epoch-ms of the snapshot / current wall-clock time. */
  asOfMs: number;
}

/** Kaplan-Meier TTFC summary for a cohort of owned-net assets. */
export interface TtfcResult {
  /** Total assets in the cohort (after dropping invalid observations). */
  n: number;
  /** Assets with a confirmed first citation (uncensored). */
  events: number;
  /** Assets not yet cited as of asOfMs (right-censored). */
  censored: number;
  /**
   * 50th-percentile TTFC in milliseconds via KM cumulative incidence.
   * null when the KM curve never reaches F ≥ 0.5 due to censoring.
   */
  medianMs: number | null;
  /**
   * 75th-percentile TTFC in milliseconds via KM cumulative incidence.
   * null when the KM curve never reaches F ≥ 0.75 due to censoring.
   */
  p75Ms: number | null;
  /**
   * 90th-percentile TTFC in milliseconds via KM cumulative incidence.
   * null when the KM curve never reaches F ≥ 0.90 due to censoring.
   */
  p90Ms: number | null;
  /**
   * Plain-language summary of censoring burden and estimation caveats.
   * Intentionally does NOT report a mean (undefined / unreliable for
   * heavy-tailed, right-censored survival data; §7).
   */
  note: string;
}

// ---------------------------------------------------------------------------
// KM implementation
// ---------------------------------------------------------------------------

/**
 * Kaplan-Meier cumulative-incidence percentile.
 *
 * Computes F(t) = 1 − S(t) where S is the KM survival estimate:
 *   S(t_i) = S(t_{i-1}) × (1 − d_i / n_i)
 * with d_i = events at time t_i, n_i = subjects at risk just before t_i
 * (i.e. those with duration ≥ t_i).
 *
 * Returns the smallest distinct event time t where F(t) ≥ p, or null when no
 * such t exists (the curve is censored below p — the honest answer).
 *
 * @param durations  Array of (timeMs, event) pairs. timeMs must be ≥ 0 and
 *   finite; event=true means an observed citation; event=false means censored.
 * @param p  Percentile in the open interval (0, 1).
 * @throws RangeError when p ≤ 0 or p ≥ 1.
 */
export function kmPercentile(
  durations: ReadonlyArray<{ timeMs: number; event: boolean }>,
  p: number,
): number | null {
  if (p <= 0 || p >= 1) {
    throw new RangeError(`kmPercentile: p must be in (0, 1), got ${p}`);
  }

  if (durations.length === 0) return null;

  // Collect distinct event times.
  const eventTimes = Array.from(
    new Set(
      durations
        .filter((d) => d.event && Number.isFinite(d.timeMs))
        .map((d) => d.timeMs),
    ),
  ).sort((a, b) => a - b);

  if (eventTimes.length === 0) return null;

  const total = durations.length;
  let survival = 1.0;

  for (const t of eventTimes) {
    // n_i: number at risk just before t (those with duration >= t).
    const atRisk = durations.filter((d) => d.timeMs >= t).length;
    // d_i: number of events exactly at t.
    const events = durations.filter((d) => d.event && d.timeMs === t).length;

    if (atRisk === 0) continue;

    survival *= 1 - events / atRisk;

    const F = 1 - survival;
    // Compare with a tolerance: F is built by repeated subtraction, so an F that
    // is mathematically equal to p can land just below it in IEEE-754 (e.g.
    // 1-(1-1/10)=0.09999999999999998 < 0.1), which would violate the documented
    // "smallest t with F(t) >= p" contract and drop/shift an exact percentile
    // (sweep v9 Z5). 1e-9 is far below any meaningful percentile resolution, so
    // the genuinely-censored (F stays below p) null case is preserved.
    if (F >= p - 1e-9) return t;
  }

  // The curve never crossed the threshold.
  void total; // kept for clarity; atRisk logic handles it
  return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute KM-based TTFC percentile KPIs for a cohort of owned-net assets.
 *
 * Observation rules:
 * - If firstCitedAtMs is non-null AND ≥ observedSinceMs → uncensored event;
 *   duration = firstCitedAtMs − observedSinceMs.
 * - Otherwise → right-censored; duration = max(0, asOfMs − observedSinceMs).
 * - Observations with non-finite inputs, or where asOfMs < observedSinceMs
 *   and there is no event, are silently dropped as invalid.
 *
 * @param observations  Read-only array of per-asset observations.
 */
export function computeTtfc(
  observations: readonly TtfcObservation[],
): TtfcResult {
  const durations: Array<{ timeMs: number; event: boolean }> = [];

  for (const obs of observations) {
    const { firstCitedAtMs, observedSinceMs, asOfMs } = obs;

    // Validate finite inputs.
    if (!Number.isFinite(observedSinceMs) || !Number.isFinite(asOfMs)) {
      continue;
    }
    if (firstCitedAtMs !== null && !Number.isFinite(firstCitedAtMs)) {
      continue;
    }

    if (firstCitedAtMs !== null && firstCitedAtMs >= observedSinceMs) {
      // Uncensored event.
      durations.push({ timeMs: firstCitedAtMs - observedSinceMs, event: true });
    } else {
      // Right-censored. Drop if asOfMs < observedSinceMs (observation window invalid).
      if (asOfMs < observedSinceMs) continue;
      durations.push({
        timeMs: Math.max(0, asOfMs - observedSinceMs),
        event: false,
      });
    }
  }

  const n = durations.length;
  const events = durations.filter((d) => d.event).length;
  const censored = n - events;

  const censoredFraction = n > 0 ? censored : 0;

  let medianMs: number | null = null;
  let p75Ms: number | null = null;
  let p90Ms: number | null = null;

  if (events > 0) {
    medianMs = kmPercentile(durations, 0.5);
    p75Ms = kmPercentile(durations, 0.75);
    p90Ms = kmPercentile(durations, 0.9);
  }

  const note =
    events === 0
      ? `${censoredFraction}/${n} assets not yet cited — no events observed; all percentiles are null. ` +
        `The arithmetic mean is intentionally omitted: citation-latency data is heavy-tailed and right-censored, making the mean unreliable.`
      : `${censoredFraction}/${n} assets not yet cited (right-censored). ` +
        `Percentiles via Kaplan-Meier cumulative incidence; null = KM curve did not reach that threshold (censoring limits inference). ` +
        `The arithmetic mean is intentionally omitted: citation-latency data is heavy-tailed and right-censored, making the mean unreliable.`;

  return { n, events, censored, medianMs, p75Ms, p90Ms, note };
}
