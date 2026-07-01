/**
 * Density tier resolution — per DESIGN.md §5.3 / SPEC.md §5.3.
 *
 * DESIGN:
 *   core      → every cycle, full N = 5 samples
 *   secondary → biweekly, N = 3 samples  (rotation cursor decides which slice is "due")
 *   longtail  → monthly,  N = 3 samples, cheap-model-only
 *
 * Pure, no IO.
 */

import type { DensityTier } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sample depths per tier. */
export const SAMPLES_BY_TIER: Record<DensityTier, number> = {
  core: 5,
  secondary: 3,
  longtail: 3,
};

/**
 * How many cycles elapse between consecutive runs of each tier.
 *   core      = every cycle  (cycle_period = 1)
 *   secondary = biweekly     (cycle_period = 2, meaning every 2nd cycle)
 *   longtail  = monthly      (cycle_period = 4, ~4 weeks)
 *
 * The rotation cursor tracks `last_cycle_index` and computes due-ness from
 * `(currentCycleIndex - last_cycle_index) >= period`.
 */
export const CYCLE_PERIOD_BY_TIER: Record<DensityTier, number> = {
  core: 1,
  secondary: 2,
  longtail: 4,
};

// ---------------------------------------------------------------------------
// DensityConfig — per tier
// ---------------------------------------------------------------------------

export interface TierConfig {
  tier: DensityTier;
  /** Number of samples per work-unit for this tier. */
  nSamples: number;
  /** Cycle period — how many operating cycles between runs. */
  cyclePeriod: number;
  /** If true, ONLY the cheap monitor model may be used for this tier. */
  cheapModelOnly: boolean;
}

export const TIER_CONFIGS: Record<DensityTier, TierConfig> = {
  core: {
    tier: "core",
    nSamples: SAMPLES_BY_TIER.core,
    cyclePeriod: CYCLE_PERIOD_BY_TIER.core,
    cheapModelOnly: false,
  },
  secondary: {
    tier: "secondary",
    nSamples: SAMPLES_BY_TIER.secondary,
    cyclePeriod: CYCLE_PERIOD_BY_TIER.secondary,
    cheapModelOnly: false,
  },
  longtail: {
    tier: "longtail",
    nSamples: SAMPLES_BY_TIER.longtail,
    cyclePeriod: CYCLE_PERIOD_BY_TIER.longtail,
    cheapModelOnly: true,
  },
};

// ---------------------------------------------------------------------------
// isDue — is a given tier due on this cycle?
// ---------------------------------------------------------------------------

/**
 * Returns true if a question of `tier` is due to be sampled on `currentCycleIndex`.
 *
 * @param tier              The density tier of the question.
 * @param currentCycleIndex Global monotonic cycle counter (0-based, persisted in rotation_state).
 * @param lastCycleIndex    The cycle index when this tier was last sampled (-1 = never).
 *
 * Core is always due.  Secondary / longtail are due when the gap ≥ their period.
 */
export function isDue(
  tier: DensityTier,
  currentCycleIndex: number,
  lastCycleIndex: number
): boolean {
  const config = TIER_CONFIGS[tier];
  if (tier === "core") return true;
  const gap = currentCycleIndex - lastCycleIndex;
  return gap >= config.cyclePeriod;
}

// ---------------------------------------------------------------------------
// Baseline sampling override
// ---------------------------------------------------------------------------

/**
 * For baseline runs (free diagnostic), the tier config is simplified:
 *   - All tiers are "due" (single one-shot run).
 *   - Sample depth reduced to N = 3 for all tiers (cost-conscious baseline).
 *   - No cheap-model restriction (baseline uses the standard flash model).
 */
export const BASELINE_N_SAMPLES = 3;

export function baselineTierConfig(tier: DensityTier): TierConfig {
  return {
    tier,
    nSamples: BASELINE_N_SAMPLES,
    cyclePeriod: 1,
    cheapModelOnly: false,
  };
}
