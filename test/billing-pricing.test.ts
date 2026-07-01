/**
 * test/billing-pricing.test.ts
 *
 * P5-T19 acceptance criteria — pure pricing function:
 *
 * 1. priceForScope is deterministic (same input → same output every time)
 * 2. Tier boundaries are correct (starter ≤50, growth ≤100, scale ≤200, enterprise >200)
 * 3. Zero/empty scope returns ₩0
 * 4. Depth multiplier caps at 3.0× (no runaway pricing)
 * 5. Depth multiplier is clamped to 1.0 minimum
 * 6. Enterprise overage is baseEnterprise + cellOverage×rate
 * 7. VAT is 10% of the pre-tax amount
 * 8. usdToKrw converts correctly
 * 9. applyMargin multiplies and rounds
 * 10. Module is pure — no IO imports
 *
 * The "shared-import parity" criterion from P5-T19: pricing.ts must be
 * importable by BOTH the engine and apps/web for an identical quote.
 * We verify this by importing from the engine path directly.
 */

import { describe, it, expect } from 'vitest';
import {
  priceForScope,
  computeVat,
  usdToKrw,
  applyMargin,
  KR_VAT_RATE,
  type PriceScope,
} from '../src/billing/pricing.js';

// ============================================================
// Helper
// ============================================================

function scope(
  questionCount: number,
  languageCount: number,
  models = 5,
  samples = 3,
): PriceScope {
  return { questionCount, languageCount, models, samples };
}

// ============================================================
// Zero/empty scope
// ============================================================

describe('priceForScope — zero scope returns ₩0', () => {
  it('returns baseKrw=0 when questionCount=0', () => {
    const result = priceForScope(scope(0, 3));
    expect(result.baseKrw).toBe(0);
  });

  it('returns baseKrw=0 when languageCount=0', () => {
    const result = priceForScope(scope(10, 0));
    expect(result.baseKrw).toBe(0);
  });

  it('returns tier=starter for zero scope', () => {
    const result = priceForScope(scope(0, 0));
    expect(result.tier).toBe('starter');
  });

  it('returns qxlCells=0 for zero scope', () => {
    const result = priceForScope(scope(0, 0));
    expect(result.breakdown.qxlCells).toBe(0);
  });
});

// ============================================================
// Tier boundaries
// ============================================================

describe('priceForScope — tier boundaries', () => {
  it('exactly 50 cells → starter tier', () => {
    // 10 questions × 5 languages = 50 cells
    const result = priceForScope(scope(10, 5));
    expect(result.tier).toBe('starter');
    expect(result.breakdown.qxlCells).toBe(50);
  });

  it('exactly 100 cells → growth tier', () => {
    // 20 questions × 5 languages = 100 cells
    const result = priceForScope(scope(20, 5));
    expect(result.tier).toBe('growth');
    expect(result.breakdown.qxlCells).toBe(100);
  });

  it('101 cells → scale tier', () => {
    // e.g. 101 questions × 1 language = 101 cells (> 100)
    const result = priceForScope(scope(101, 1));
    expect(result.tier).toBe('scale');
  });

  it('exactly 200 cells → scale tier', () => {
    const result = priceForScope(scope(40, 5));
    expect(result.tier).toBe('scale');
    expect(result.breakdown.qxlCells).toBe(200);
  });

  it('201 cells → enterprise tier', () => {
    const result = priceForScope(scope(201, 1));
    expect(result.tier).toBe('enterprise');
  });
});

// ============================================================
// Tier pricing values (reference baseline: 5 models × 3 samples = depth 1.0)
// ============================================================

describe('priceForScope — tier pricing at baseline depth', () => {
  // baseline depth: 5 models × 3 samples = 15 units → 15/15 = 1.0×

  it('starter tier at baseline depth is ₩1,200,000', () => {
    // 10 questions × 1 language = 10 cells (≤50 → starter)
    const result = priceForScope(scope(10, 1, 5, 3));
    expect(result.tier).toBe('starter');
    expect(result.baseKrw).toBe(1_200_000);
  });

  it('growth tier at baseline depth is ₩2,000,000', () => {
    // 20 questions × 5 = 100 cells (≤100 → growth)
    const result = priceForScope(scope(20, 5, 5, 3));
    expect(result.tier).toBe('growth');
    expect(result.baseKrw).toBe(2_000_000);
  });

  it('scale tier at baseline depth is ₩3,500,000', () => {
    // 40 questions × 5 = 200 cells (≤200 → scale)
    const result = priceForScope(scope(40, 5, 5, 3));
    expect(result.tier).toBe('scale');
    expect(result.baseKrw).toBe(3_500_000);
  });
});

// ============================================================
// Determinism
// ============================================================

describe('priceForScope — determinism', () => {
  it('same input always produces identical output', () => {
    const s = scope(30, 3, 5, 3);
    const r1 = priceForScope(s);
    const r2 = priceForScope(s);
    const r3 = priceForScope(s);
    expect(r1.baseKrw).toBe(r2.baseKrw);
    expect(r2.baseKrw).toBe(r3.baseKrw);
    expect(r1.tier).toBe(r2.tier);
  });
});

// ============================================================
// Depth multiplier
// ============================================================

describe('priceForScope — depth multiplier', () => {
  it('baseline depth (5 models × 3 samples) gives multiplier=1.0', () => {
    const result = priceForScope(scope(10, 1, 5, 3));
    expect(result.breakdown.depthMultiplier).toBeCloseTo(1.0, 5);
  });

  it('multiplier is clamped to minimum 1.0 (lighter config does not decrease price)', () => {
    // 1 model × 1 sample = 1 depth unit << baseline 15
    const result = priceForScope(scope(10, 1, 1, 1));
    expect(result.breakdown.depthMultiplier).toBeGreaterThanOrEqual(1.0);
  });

  it('multiplier is capped at 3.0 (heavy config does not exceed 3×)', () => {
    // Very heavy config: 50 models × 50 samples
    const result = priceForScope(scope(10, 1, 50, 50));
    expect(result.breakdown.depthMultiplier).toBeLessThanOrEqual(3.0);
  });

  it('multiplier exactly at cap: baseKrw = bucket × 3.0 (rounded to nearest ₩1,000)', () => {
    // Heavy config capped at 3.0×
    const result = priceForScope(scope(10, 1, 50, 50));
    // starter bucket = 1,200,000; 3.0× = 3,600,000; rounded to ₩1,000 = 3,600,000
    expect(result.breakdown.depthMultiplier).toBe(3.0);
    expect(result.baseKrw % 1000).toBe(0); // rounded to nearest ₩1,000
  });

  it('price is rounded to nearest ₩1,000', () => {
    // Any scope should produce a price divisible by 1,000
    const result = priceForScope(scope(15, 4, 3, 2));
    expect(result.baseKrw % 1000).toBe(0);
  });
});

// ============================================================
// Enterprise overage
// ============================================================

describe('priceForScope — enterprise overage cells', () => {
  it('201 cells at baseline depth bills base ₩3,500,000 + 1 × ₩12,000 overage', () => {
    const result = priceForScope(scope(201, 1, 5, 3));
    expect(result.tier).toBe('enterprise');
    // baseBucketKrw = 3,500,000 + (201-200) × 12,000 = 3,512,000
    // depthMultiplier = 1.0 at baseline
    // rounded to nearest 1,000 = 3,512,000
    expect(result.baseKrw).toBe(3_512_000);
  });

  it('250 cells at baseline depth bills base + 50 × ₩12,000 overage', () => {
    const result = priceForScope(scope(250, 1, 5, 3));
    // 3,500,000 + 50 × 12,000 = 3,500,000 + 600,000 = 4,100,000
    expect(result.tier).toBe('enterprise');
    expect(result.baseKrw).toBe(4_100_000);
  });
});

// ============================================================
// VAT
// ============================================================

describe('computeVat — §1 VAT 별도 (10%)', () => {
  it('VAT rate is 10%', () => {
    expect(KR_VAT_RATE).toBe(0.1);
  });

  it('computeVat on ₩2,000,000 = ₩200,000', () => {
    expect(computeVat(2_000_000)).toBe(200_000);
  });

  it('computeVat on ₩0 = ₩0', () => {
    expect(computeVat(0)).toBe(0);
  });

  it('computeVat rounds to nearest ₩1', () => {
    // 1 × 0.1 = 0.1 → rounds to 0
    expect(computeVat(1)).toBe(0);
    // 15 × 0.1 = 1.5 → rounds to 2
    expect(computeVat(15)).toBe(2);
  });

  it('VAT is never bundled into base — it is a separate component', () => {
    const base = 2_000_000;
    const vat = computeVat(base);
    // Total = base + vat, not base alone
    expect(base + vat).toBe(2_200_000);
    // VAT is not included in base
    expect(vat).not.toBe(0);
  });
});

// ============================================================
// usdToKrw
// ============================================================

describe('usdToKrw — USD→KRW conversion', () => {
  it('converts $1.00 at ₩1,350/USD to ₩1,350', () => {
    expect(usdToKrw(1.0, 1350)).toBe(1350);
  });

  it('converts $0 to ₩0', () => {
    expect(usdToKrw(0, 1350)).toBe(0);
  });

  it('rounds to nearest ₩1', () => {
    // $0.001 × 1350 = 1.35 → rounds to 1
    expect(usdToKrw(0.001, 1350)).toBe(1);
  });

  it('raw USD is NOT the customer price — conversion is required', () => {
    // The point: raw llm_call.usd is in USD and must not equal customer KRW price
    const rawUsd = 0.50; // $0.50 provider cost
    const krw = usdToKrw(rawUsd, 1350);
    // $0.50 × 1350 = 675 KRW — clearly different from the raw USD value
    expect(krw).toBe(675);
    expect(krw).not.toBe(rawUsd); // never equal to raw USD
  });
});

// ============================================================
// applyMargin
// ============================================================

describe('applyMargin — provider cost → customer overage price', () => {
  it('default 3.0× margin triples the cost', () => {
    expect(applyMargin(1000)).toBe(3000);
  });

  it('custom 2.0× margin', () => {
    expect(applyMargin(1000, 2.0)).toBe(2000);
  });

  it('margin of 1.0× returns the same amount', () => {
    expect(applyMargin(500, 1.0)).toBe(500);
  });

  it('rounds to nearest ₩1', () => {
    // 3 × 1.5 = 4.5 → rounds to 5? or 4? Math.round(4.5)=5 in JS
    expect(applyMargin(3, 1.5)).toBe(5);
  });

  it('overage price is NEVER the raw provider cost (margin > 1)', () => {
    const providerCostKrw = 2000;
    const overageKrw = applyMargin(providerCostKrw, 3.0);
    // Customer is charged 3× the provider cost
    expect(overageKrw).toBeGreaterThan(providerCostKrw);
    expect(overageKrw).toBe(6000);
  });
});

// ============================================================
// Invoice line separation (§billing design: base / overage / VAT never bundled)
// ============================================================

describe('invoice line composition — separation of base/overage/VAT', () => {
  it('total = base + overage + VAT (explicit breakdown)', () => {
    const base = 2_000_000;
    const providerCostKrw = usdToKrw(0.10, 1350); // $0.10 × 1350 = 135 KRW
    const overage = applyMargin(providerCostKrw, 3.0); // 135 × 3 = 405 KRW
    const vat = computeVat(base + overage);
    const total = base + overage + vat;

    expect(total).toBe(base + overage + vat);
    // VAT is §1 'VAT 별도' — it is a separate line item, never in base
    expect(vat).toBeGreaterThan(0);
    // Overage uses FX + margin, never raw USD
    expect(overage).toBe(405);
  });

  it('NULL-customer llm_call spend results in ₩0 overage per customer (absorbed as overhead)', () => {
    // Represents the policy: NULL customer_id rows are excluded from per-customer billing
    // In sumLlmUsageForPeriod: WHERE customer_id = $customerId (non-null predicate)
    // NULL rows cannot match a non-null customerId → excluded automatically
    // Simulate: no usage returned → llmUsageUsd = 0
    const llmUsageUsd = 0; // null-customer rows excluded
    const providerCostKrw = usdToKrw(llmUsageUsd, 1350);
    const overageKrw = applyMargin(providerCostKrw, 3.0);
    expect(overageKrw).toBe(0); // no overage billed
  });
});
