/**
 * Rotation cursor for density tiering — DESIGN.md §5.3 / sampling design.
 *
 * The `rotation_state` table persists per-(customer, density_tier) the
 * `last_cycle_index` so:
 *  - No ISO-week-modulo tricks (would cause starvation on catch-up cycles).
 *  - Every secondary/longtail question eventually runs (no starvation).
 *  - A slice of secondary questions rotates each biweekly cycle so every
 *    question is covered without running the full set every time.
 *
 * This module is PURE (no DB IO).  The caller (plan.ts / repo.ts) reads and
 * writes rotation_state rows and passes the values here for computation.
 */

import type { DensityTier } from "../domain/types.js";
import { CYCLE_PERIOD_BY_TIER } from "./density.js";

// ---------------------------------------------------------------------------
// RotationState (mirrors the rotation_state table row)
// ---------------------------------------------------------------------------

export interface RotationState {
  customerId: string;
  densityTier: DensityTier;
  /** Last cycle index at which this tier was scheduled. -1 = never run. */
  lastCycleIndex: number;
}

// ---------------------------------------------------------------------------
// isRotationDue
// ---------------------------------------------------------------------------

/**
 * Returns true when a tier is due given the current monotonic cycle index.
 *
 * @param currentCycleIndex  Monotonic counter (starts at 0, incremented per operating cycle).
 * @param state              The persisted rotation state for this (customer, tier) pair.
 */
export function isRotationDue(
  currentCycleIndex: number,
  state: RotationState
): boolean {
  const period = CYCLE_PERIOD_BY_TIER[state.densityTier];
  const gap = currentCycleIndex - state.lastCycleIndex;
  return gap >= period;
}

// ---------------------------------------------------------------------------
// advanceRotation — pure next-state calculation
// ---------------------------------------------------------------------------

/**
 * Returns the next RotationState after a tier has been scheduled.
 * The caller must persist this to rotation_state.
 */
export function advanceRotation(
  currentCycleIndex: number,
  state: RotationState
): RotationState {
  return {
    ...state,
    lastCycleIndex: currentCycleIndex,
  };
}

// ---------------------------------------------------------------------------
// selectRotatedSlice — biweekly / monthly sub-sampling
// ---------------------------------------------------------------------------

/**
 * For secondary (biweekly) and longtail (monthly) tiers, we do NOT run ALL
 * questions every time the tier is "due" — that would defeat the cost savings.
 * Instead, we rotate through slices so that OVER MULTIPLE CYCLES every
 * question gets covered.
 *
 * Slice selection is deterministic:
 *   sliceIndex = floor((currentCycleIndex / period)) % numSlices
 *
 * The caller splits the sorted question list into `numSlices` equal parts and
 * picks the slice at `sliceIndex`.
 *
 * @param currentCycleIndex  Monotonic cycle counter.
 * @param tier               The density tier.
 * @param numSlices          How many equal slices to divide the question list into.
 *                           Typically 2 for secondary (biweekly) and 4 for longtail.
 * @returns  0-based index of the slice to run this cycle.
 */
export function selectSliceIndex(
  currentCycleIndex: number,
  tier: DensityTier,
  numSlices: number
): number {
  if (numSlices <= 1) return 0;
  const period = CYCLE_PERIOD_BY_TIER[tier];
  return Math.floor(currentCycleIndex / period) % numSlices;
}

/**
 * Split an array into `numSlices` equal parts and return the slice at `sliceIndex`.
 * The last slice absorbs any remainder items.
 *
 * @param items       The full sorted list of items to rotate through.
 * @param numSlices   Number of equal partitions (>= 1).
 * @param sliceIndex  0-based index of the partition to return (0 ≤ idx < numSlices).
 */
export function pickSlice<T>(
  items: T[],
  numSlices: number,
  sliceIndex: number
): T[] {
  if (numSlices <= 1 || items.length === 0) return items;

  const size = Math.ceil(items.length / numSlices);
  const start = sliceIndex * size;
  const end = Math.min(start + size, items.length);
  return items.slice(start, end);
}

// ---------------------------------------------------------------------------
// DEFAULT_NUM_SLICES — recommended slice counts per tier
// ---------------------------------------------------------------------------

export const DEFAULT_NUM_SLICES: Record<DensityTier, number> = {
  core: 1,       // core runs every cycle — no slicing
  secondary: 2,  // 2 slices × 2-week period = every question covered monthly
  longtail: 4,   // 4 slices × 4-week period = every question covered every ~16 weeks
};
