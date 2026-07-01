/**
 * src/billing/pricing.ts
 *
 * PURE pricing function — no IO, no imports from pg/kysely/pino.
 *
 * §11 design: customer price is proportional to questionCount × languageCount
 * (the two cost drivers). This is the BASE price before overage/VAT layering.
 *
 * This module is imported by BOTH the engine (close.ts) and apps/web (billing page)
 * so the exact same price curve is shown to the customer as what gets billed.
 *
 * BUSINESS INPUT NOTE: The tier curve below is a conservative default anchored
 * to the §1 ~₩2,000,000/mo VAT-별도 GPTO-parity tier. The exact multipliers
 * and bucket boundaries MUST be reviewed against actual operating costs before
 * going live with paying customers.
 *
 * Tier logic:
 *   - baseUnit: price per question × language slot per month
 *   - Bucket thresholds (question × language product, i.e. total QxL "cells"):
 *       ≤  50 cells → Starter tier   ₩1,200,000/mo
 *       ≤ 100 cells → Growth tier    ₩2,000,000/mo  (GPTO-parity anchor)
 *       ≤ 200 cells → Scale tier     ₩3,500,000/mo
 *       >  200 cells → Enterprise    ₩3,500,000 + ₩12,000 per additional cell
 *
 * Model/sample multipliers apply AFTER the base bucket, capped at 3× to
 * prevent runaway pricing on heavy configurations.
 */

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface PriceScope {
  /** Number of active questions for this customer. */
  questionCount: number;
  /** Number of active languages for this customer. */
  languageCount: number;
  /** Number of LLM models enabled for this customer. */
  models: number;
  /** Number of samples per question-model-language (§5.3 sampling depth). */
  samples: number;
}

export interface PriceResult {
  /** Base monthly price in KRW (before VAT). */
  baseKrw: number;
  /** The tier name for UI display. */
  tier: 'starter' | 'growth' | 'scale' | 'enterprise';
  /** Breakdown details for display. */
  breakdown: {
    /** Question × language cell count. */
    qxlCells: number;
    /** Cell rate (KRW per cell/mo, within this tier). */
    cellRateKrw: number;
    /** Configuration depth multiplier applied (models × samples ratio). */
    depthMultiplier: number;
  };
}

// ---------------------------------------------------------------------------
// Tier definitions (BUSINESS INPUT — calibrate before production)
// ---------------------------------------------------------------------------

/** Tier boundaries by QxL cell count (questionCount × languageCount). */
const TIERS = [
  { maxCells: 50,  tierName: 'starter'    as const, baseKrw: 1_200_000 },
  { maxCells: 100, tierName: 'growth'     as const, baseKrw: 2_000_000 },
  { maxCells: 200, tierName: 'scale'      as const, baseKrw: 3_500_000 },
] as const;

/** Enterprise base (applied when QxL > 200 cells). */
const ENTERPRISE_BASE_KRW = 3_500_000;

/** Additional cost per enterprise cell beyond 200 (KRW/cell/mo). */
const ENTERPRISE_OVERAGE_KRW_PER_CELL = 12_000;

/**
 * Depth multiplier: a configuration with more models × samples costs more to run.
 * Reference baseline: 5 models × 3 samples = 15 depth units → 1.0×.
 * Capped at 3.0× to prevent runaway costs on heavy configs.
 *
 * BUSINESS INPUT: review these baseline values.
 */
const DEPTH_BASELINE = 15; // 5 models × 3 samples
const DEPTH_MULTIPLIER_CAP = 3.0;

// ---------------------------------------------------------------------------
// Pure pricing function
// ---------------------------------------------------------------------------

/**
 * Compute the base monthly KRW price for a given customer scope.
 *
 * PURE: no IO, safe to import in both engine and apps/web.
 * Returns the same value for the same inputs every time.
 *
 * @param scope - Customer scope (questions, languages, models, samples).
 * @returns PriceResult with baseKrw and breakdown details.
 */
export function priceForScope(scope: PriceScope): PriceResult {
  const { questionCount, languageCount, models, samples } = scope;

  // Guard: clamp to minimums (a customer with 0 active questions/languages = ₩0)
  if (questionCount <= 0 || languageCount <= 0) {
    return {
      baseKrw: 0,
      tier: 'starter',
      breakdown: {
        qxlCells: 0,
        cellRateKrw: 0,
        depthMultiplier: 1.0,
      },
    };
  }

  const qxlCells = questionCount * languageCount;

  // 1. Find the tier by QxL cell count.
  const matchedTier = TIERS.find((t) => qxlCells <= t.maxCells);

  let tierName: 'starter' | 'growth' | 'scale' | 'enterprise';
  let baseBucketKrw: number;
  let cellRateKrw: number;

  if (matchedTier) {
    tierName = matchedTier.tierName;
    baseBucketKrw = matchedTier.baseKrw;
    // Cell rate = bucket total ÷ max cells in this tier (for display)
    cellRateKrw = Math.round(matchedTier.baseKrw / matchedTier.maxCells);
  } else {
    // Enterprise: base + overage per additional cell
    tierName = 'enterprise';
    const overageCells = qxlCells - 200;
    baseBucketKrw = ENTERPRISE_BASE_KRW + overageCells * ENTERPRISE_OVERAGE_KRW_PER_CELL;
    cellRateKrw = ENTERPRISE_OVERAGE_KRW_PER_CELL;
  }

  // 2. Apply depth multiplier (models × samples vs. baseline).
  //    Clamp to [1.0, DEPTH_MULTIPLIER_CAP].
  const depthUnits = Math.max(1, models) * Math.max(1, samples);
  const rawMultiplier = depthUnits / DEPTH_BASELINE;
  const depthMultiplier = Math.min(Math.max(rawMultiplier, 1.0), DEPTH_MULTIPLIER_CAP);

  // 3. Apply the depth multiplier to the bucket price, then round to nearest ₩1,000.
  const rawKrw = baseBucketKrw * depthMultiplier;
  const baseKrw = Math.round(rawKrw / 1000) * 1000;

  return {
    baseKrw,
    tier: tierName,
    breakdown: {
      qxlCells,
      cellRateKrw,
      depthMultiplier,
    },
  };
}

// ---------------------------------------------------------------------------
// VAT and FX helpers (used by close.ts for invoice line items)
// Single source of truth: these constants are imported by BOTH close.ts and
// the billing page so they can never diverge.
// ---------------------------------------------------------------------------

/** Korea VAT rate: 10% (§1 'VAT 별도'). */
export const KR_VAT_RATE = 0.1;

/**
 * Default USD → KRW exchange rate.
 * BUSINESS INPUT: replace with a live rate from an FX API in production.
 * This value (~1,350 KRW/USD) is typical as of mid-2025; calibrate before launch.
 * Exported here (pure module) so both close.ts and apps/web billing page share
 * the exact same constant — never inline 1350 in page code.
 */
export const DEFAULT_FX_RATE_KRW_PER_USD = 1350;

/**
 * Margin multiplier applied to the USD provider cost when billing overage.
 * 3.0× means we charge the customer 3× our raw provider cost for overage usage.
 * BUSINESS INPUT: review against actual cost structure + desired margin.
 * Exported here (pure module) so both close.ts and apps/web billing page share
 * the exact same constant — never inline 3 in page code.
 */
export const OVERAGE_MARGIN_MULTIPLIER = 3.0;

/**
 * Compute VAT amount for a KRW base (exclusive VAT, §1 'VAT 별도').
 * Returns the VAT component (NOT the total).
 */
export function computeVat(baseKrw: number): number {
  return Math.round(baseKrw * KR_VAT_RATE);
}

/**
 * Convert USD amount to KRW using the given exchange rate.
 * BUSINESS INPUT: the FX rate must be supplied by the close job (from a live feed
 * or a configured rate). This function is pure; the rate is injected.
 *
 * @param usd     - USD amount (raw provider cost from llm_call ledger).
 * @param fxRate  - KRW per 1 USD (e.g. 1350.0 for ₩1,350/USD).
 * @returns       KRW equivalent, rounded to nearest ₩1.
 */
export function usdToKrw(usd: number, fxRate: number): number {
  return Math.round(usd * fxRate);
}

/**
 * Apply a margin multiplier to a KRW amount.
 * Used by close.ts to add margin on top of provider cost (overage billing).
 *
 * @param costKrw  - Raw provider cost in KRW.
 * @param margin   - Margin multiplier > 1.0 (e.g. 3.0 = 3× the provider cost).
 * @returns        KRW amount with margin, rounded to nearest ₩1.
 *
 * BUSINESS INPUT: the margin rate must be configured. Default 3.0× is conservative.
 */
export function applyMargin(costKrw: number, margin = OVERAGE_MARGIN_MULTIPLIER): number {
  return Math.round(costKrw * margin);
}
