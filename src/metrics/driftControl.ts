/**
 * src/metrics/driftControl.ts — W7: Difference-in-Differences (DiD) drift-control estimator.
 *
 * PURPOSE
 * -------
 * AEO/GEO content campaigns are measured in a world where the underlying answer-engine
 * ecosystem is also shifting — engines update their ranking logic, competitors publish
 * new content, and overall citation rates change over time. Without a control cohort,
 * a simple "before → after" comparison on our targeted queries conflates three things:
 *   (a) genuine content-driven improvement,
 *   (b) ecosystem-wide drift that lifts everyone,
 *   (c) noise.
 *
 * MEASUREMENT INTEGRITY CONTROL COHORT
 * A HOLDOUT cohort is a set of queries our content engine has NEVER optimized for.
 * Measuring the holdout before and after the same campaign window gives a clean read
 * on how much of any change was caused by the ecosystem moving, not by our work.
 *
 * DiD ESTIMATOR
 * The classic Difference-in-Differences (DiD) design (Card & Krueger 1994;
 * Angrist & Pischke, "Mostly Harmless Econometrics", 2009) isolates treatment:
 *
 *   targetedDelta  = pTargetedAfter − pTargetedBefore     (total change, targeted)
 *   ecosystemDrift = pHoldoutAfter  − pHoldoutBefore      (drift, estimated by holdout)
 *   netEffect      = targetedDelta  − ecosystemDrift       (content treatment effect)
 *
 * DEFERRED INTEGRATION
 * This module is the PURE ESTIMATOR only. The companion integrations that are
 * DEFERRED for Phase 1:
 *   - Holdout panel selection (which queries are permanently in the holdout set and
 *     protected from being targeted — requires a DB-level cohort assignment flag).
 *   - Per-cycle measurement wiring (scheduler must collect holdout measurements in
 *     the same run window as the targeted measurements).
 *
 * HONESTY (§7)
 * The holdout delta IS the ecosystem drift and must be REPORTED, never hidden.
 * When the holdout rises as much as the targeted cohort, there is no content effect
 * to claim. This module flags low power and never overstates.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single before/after proportion cell: hits successes out of n trials. */
export interface Cell {
  hits: number;
  n: number;
}

/** Full DiD result returned by computeDriftControl. */
export interface DriftControlResult {
  /** pAfter − pBefore for the targeted (treatment) cohort. */
  targetedDelta: number;
  /** pAfter − pBefore for the holdout cohort — this IS the ecosystem drift. */
  ecosystemDrift: number;
  /** DiD net content effect = targetedDelta − ecosystemDrift. */
  netEffect: number;
  /** Normal-approximation 95% CI for netEffect. Lives in [−2, 2]. */
  ci95: { lower: number; upper: number };
  /**
   * True when any of the four cells has n < minN (default 30).
   * Low-n cells produce wide CIs that can easily bracket zero even when the
   * true effect is large — interpret with caution.
   */
  lowPower: boolean;
  /**
   * Plain-English interpretation (§7 honesty). States the ecosystem drift
   * explicitly. Prepends a caution when lowPower is true.
   */
  note: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Guard hits into [0, n]; rate = hits/n (0 when n=0). */
function rate(cell: Cell): number {
  if (cell.n === 0) return 0;
  return cell.hits / cell.n;
}

/**
 * Variance for a proportion cell. The raw Wald variance p̂(1−p̂)/n is identically
 * 0 at the boundary rates p̂∈{0,1}, which would collapse the DiD CI to a falsely
 * exact [0,0] regardless of n (sweep v9 Z4 — same failure mode as judgeDebias v7
 * Z4). At a saturated cell use the Agresti-Coull adjusted variance so the CI
 * stays non-degenerate; otherwise the standard Wald variance. Zero only at n=0.
 */
function varProp(cell: Cell): number {
  if (cell.n === 0) return 0;
  if (cell.hits === 0 || cell.hits === cell.n) {
    const pAdj = (cell.hits + 2) / (cell.n + 4);
    return (pAdj * (1 - pAdj)) / (cell.n + 4);
  }
  const p = rate(cell);
  return (p * (1 - p)) / cell.n;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateCell(cell: Cell, label: string): void {
  if (!isFinite(cell.hits) || !isFinite(cell.n)) {
    throw new RangeError(`${label}: hits and n must be finite numbers`);
  }
  if (cell.n < 0) {
    throw new RangeError(`${label}: n must be >= 0, got ${cell.n}`);
  }
  if (cell.hits < 0) {
    throw new RangeError(`${label}: hits must be >= 0, got ${cell.hits}`);
  }
  if (cell.hits > cell.n) {
    throw new RangeError(
      `${label}: hits (${cell.hits}) must be <= n (${cell.n})`
    );
  }
}

// ---------------------------------------------------------------------------
// Core estimator
// ---------------------------------------------------------------------------

/**
 * Compute a Difference-in-Differences drift-controlled content effect estimate.
 *
 * @param input  - Four cells: targeted and holdout cohorts, before and after.
 * @param opts   - minN: low-power threshold (default 30); z: CI z-score (default 1.96).
 * @returns      DriftControlResult with targetedDelta, ecosystemDrift, netEffect,
 *               ci95, lowPower, and an honest note string.
 */
export function computeDriftControl(
  input: {
    targetedBefore: Cell;
    targetedAfter: Cell;
    holdoutBefore: Cell;
    holdoutAfter: Cell;
  },
  opts?: { minN?: number; z?: number }
): DriftControlResult {
  const minN = opts?.minN ?? 30;
  const z = opts?.z ?? 1.96;

  // Validate opts
  if (!isFinite(z) || z <= 0) {
    throw new RangeError(`z must be a positive finite number, got ${z}`);
  }
  if (!Number.isInteger(minN) || minN < 1) {
    throw new RangeError(`minN must be an integer >= 1, got ${minN}`);
  }

  // Validate cells
  validateCell(input.targetedBefore, "targetedBefore");
  validateCell(input.targetedAfter, "targetedAfter");
  validateCell(input.holdoutBefore, "holdoutBefore");
  validateCell(input.holdoutAfter, "holdoutAfter");

  // Point estimates
  const pTB = rate(input.targetedBefore);
  const pTA = rate(input.targetedAfter);
  const pHB = rate(input.holdoutBefore);
  const pHA = rate(input.holdoutAfter);

  const targetedDelta = pTA - pTB;
  const ecosystemDrift = pHA - pHB;
  const netEffect = targetedDelta - ecosystemDrift;

  // Variance: Var(netEffect) = Var(pTA) + Var(pTB) + Var(pHA) + Var(pHB)
  // (cells are independent; sign flips cancel in variance)
  const totalVar =
    varProp(input.targetedAfter) +
    varProp(input.targetedBefore) +
    varProp(input.holdoutAfter) +
    varProp(input.holdoutBefore);

  const halfWidth = z * Math.sqrt(totalVar);
  const ci95 = {
    lower: Math.max(-2, netEffect - halfWidth),
    upper: Math.min(2, netEffect + halfWidth),
  };

  // Low-power flag: any cell below minN threshold
  const anyEmptyCell =
    input.targetedBefore.n === 0 ||
    input.targetedAfter.n === 0 ||
    input.holdoutBefore.n === 0 ||
    input.holdoutAfter.n === 0;

  const lowPower =
    anyEmptyCell ||
    input.targetedBefore.n < minN ||
    input.targetedAfter.n < minN ||
    input.holdoutBefore.n < minN ||
    input.holdoutAfter.n < minN;

  // Build honest note
  const fmt = (v: number): string =>
    (v >= 0 ? "+" : "") + v.toFixed(4);

  const ciStr = `95% CI [${fmt(ci95.lower)}, ${fmt(ci95.upper)}]`;
  let note =
    `Targeted ${fmt(targetedDelta)}, ecosystem drift ${fmt(ecosystemDrift)}` +
    ` (from holdout cohort), net content effect ${fmt(netEffect)} (${ciStr}).`;

  if (anyEmptyCell) {
    note =
      "Caution: one or more cells has n=0 — estimates are unreliable. " + note;
  } else if (lowPower) {
    note =
      `Caution: one or more cells has n < ${minN} — low statistical power; CI is wide. ` +
      note;
  }

  return {
    targetedDelta,
    ecosystemDrift,
    netEffect,
    ci95,
    lowPower,
    note,
  };
}
