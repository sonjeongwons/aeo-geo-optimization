/**
 * src/billing/close.ts
 *
 * Monthly billing close — generates invoice + invoice_line rows for a customer's
 * prior completed billing period. Called by the billing.close pg-boss job
 * (1st of every month at 03:00 UTC).
 *
 * Design (§11 billing design):
 * - Separates OUR provider cost (llm_call.usd, USD, tiny today) from
 *   customer PRICE via pricing.ts (price ∝ questions × languages).
 * - Reads cost_daily CAGG for the prior month (does NOT scan llm_call directly).
 * - NULL-customer llm_call rows are excluded: absorbed as overhead, not billed.
 * - invoice UNIQUE(customer_id, period_start, period_end) makes this idempotent.
 * - invoice_line rows separate base / overage (+margin, FX) / VAT explicitly.
 * - §1 'VAT 별도': VAT is a separate line item, never bundled into base.
 *
 * FX rate: injected as a parameter so the close job can pull a live rate
 * (e.g. from an env var or a rate-provider API) and inject it. The close.ts
 * function itself is pure-functional — no live FX fetch inside.
 *
 * BUSINESS INPUT NOTE:
 *   - DEFAULT_FX_RATE_KRW_PER_USD: update daily/weekly in production.
 *   - OVERAGE_MARGIN_MULTIPLIER: cost × multiplier = customer overage price.
 *   - Both are flagged here for easy configuration without modifying business logic.
 */

import pino from 'pino';
import { getDb } from '../db/kysely.js';
import {
  getSubscription,
  insertInvoice,
  insertInvoiceLine,
  sumLlmUsageForPeriod,
} from '../db/repo.js';
import {
  priceForScope,
  usdToKrw,
  applyMargin,
  computeVat,
  DEFAULT_FX_RATE_KRW_PER_USD,
  OVERAGE_MARGIN_MULTIPLIER,
  type PriceScope,
} from './pricing.js';
import type { PaymentProvider } from './paymentProvider.js';

const log = pino({ name: 'billing.close' });

// ---------------------------------------------------------------------------
// Business inputs — re-exported from pricing.ts (single source of truth)
// ---------------------------------------------------------------------------

// DEFAULT_FX_RATE_KRW_PER_USD and OVERAGE_MARGIN_MULTIPLIER are defined in
// pricing.ts (pure module) and imported above so both close.ts and apps/web
// billing page share exactly the same constants. Re-export them so callers
// (e.g. runMonthlyClose defaults) can still reference them via close.ts.
export { DEFAULT_FX_RATE_KRW_PER_USD, OVERAGE_MARGIN_MULTIPLIER };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CloseInput {
  /** Customer UUID to close the billing period for. */
  customerId: string;
  /** Start of the billing period (inclusive). */
  periodStart: Date;
  /** End of the billing period (exclusive). */
  periodEnd: Date;
  /**
   * Customer scope for pricing: active question/language/model/sample counts.
   * If not provided, the close job reads counts from the DB.
   */
  scope?: PriceScope;
  /**
   * USD → KRW exchange rate. Defaults to DEFAULT_FX_RATE_KRW_PER_USD.
   * BUSINESS INPUT: inject a live rate from the calling context.
   */
  fxRateKrwPerUsd?: number;
  /**
   * Payment provider to call after invoice creation (optional).
   * If omitted, invoice is left in 'issued' status for manual reconciliation.
   */
  paymentProvider?: PaymentProvider;
}

export interface CloseResult {
  /** The invoice UUID, or null if the period was already invoiced (idempotent). */
  invoiceId: string | null;
  /** True when this was a no-op because the invoice already existed. */
  alreadyExists: boolean;
  /** Amount billed in KRW (base + overage + VAT). */
  totalKrw: number;
}

// ---------------------------------------------------------------------------
// Scope reader (fallback when scope is not injected)
// ---------------------------------------------------------------------------

/**
 * Read the active customer scope from the DB.
 * Used when CloseInput.scope is not provided.
 *
 * Returns default minimal scope when customer has no active questions/languages
 * (results in ₩0 for that period — a new customer or one with no active data).
 */
async function readCustomerScope(customerId: string): Promise<PriceScope> {
  const db = getDb();

  const [qRow, lRow, mRow] = await Promise.all([
    db
      .selectFrom('question')
      .select(db.fn.countAll<string>().as('cnt'))
      .where('customer_id', '=', customerId)
      .where('active', '=', true)
      .executeTakeFirst(),
    db
      .selectFrom('customer_language')
      .select(db.fn.countAll<string>().as('cnt'))
      .where('customer_id', '=', customerId)
      .executeTakeFirst(),
    db
      .selectFrom('model')
      .select(db.fn.countAll<string>().as('cnt'))
      .where('enabled', '=', true)
      .where('modality', '=', 'chat')
      .executeTakeFirst(),
  ]);

  const questionCount = parseInt(qRow?.cnt ?? '0', 10);
  const languageCount = parseInt(lRow?.cnt ?? '0', 10);
  const modelCount = Math.max(1, parseInt(mRow?.cnt ?? '5', 10));

  return {
    questionCount,
    languageCount,
    models: modelCount,
    samples: 3, // §5.3 default sampling depth
  };
}

// ---------------------------------------------------------------------------
// Close function
// ---------------------------------------------------------------------------

/**
 * Generate invoice + invoice_line rows for a customer's completed billing period.
 *
 * Idempotent: invoice UNIQUE(customer_id, period_start, period_end) prevents
 * double-creation. Returns alreadyExists=true on the conflict path.
 *
 * @param input - Close parameters (customerId, period, optional scope+FX).
 * @returns CloseResult with invoiceId, alreadyExists flag, and totalKrw.
 */
export async function closeBillingPeriod(input: CloseInput): Promise<CloseResult> {
  const {
    customerId,
    periodStart,
    periodEnd,
    fxRateKrwPerUsd = DEFAULT_FX_RATE_KRW_PER_USD,
  } = input;

  log.info(
    { customerId, periodStart, periodEnd },
    'billing.close: starting period close',
  );

  // 1. Read subscription (for plan_tier reference).
  const subscription = await getSubscription(customerId);
  if (!subscription) {
    // No subscription row — this customer is not on a plan.
    // Log and skip rather than error (could be a recently onboarded customer).
    log.warn(
      { customerId },
      'billing.close: no subscription found — skipping close',
    );
    return { invoiceId: null, alreadyExists: false, totalKrw: 0 };
  }

  // 2. Read customer scope (either injected or from DB).
  const scope = input.scope ?? (await readCustomerScope(customerId));

  // 3. Compute the base price for this scope.
  const priceResult = priceForScope(scope);
  const baseKrw = priceResult.baseKrw;

  // 4. Read LLM usage for the period from cost_daily CAGG.
  //    NULL-customer rows are excluded by sumLlmUsageForPeriod (absorbed as overhead).
  //    Treat null return (no CAGG data) as $0 spend (no overage this period).
  const llmUsageUsd = (await sumLlmUsageForPeriod(customerId, periodStart, periodEnd)) ?? 0;

  // 5. Convert provider cost to KRW with FX + margin.
  //    The overage line item separates our provider cost from the customer price
  //    (§billing review must-fix: never bill raw llm_call.usd as the invoice amount).
  const providerCostKrw = usdToKrw(llmUsageUsd, fxRateKrwPerUsd);
  const usageOverageKrw = applyMargin(providerCostKrw, OVERAGE_MARGIN_MULTIPLIER);

  // 6. Compute VAT (§1 'VAT 별도' — 10% KR VAT on (base + overage) pre-tax).
  const preTaxKrw = baseKrw + usageOverageKrw;
  const vatKrw = computeVat(preTaxKrw);
  const totalKrw = preTaxKrw + vatKrw;

  // 7. Insert the invoice row (idempotent via UNIQUE(customer_id, period_start, period_end)).
  const invoiceRow = await insertInvoice({
    customerId,
    periodStart,
    periodEnd,
    baseKrw,
    usageOverageKrw,
    vatKrw,
    totalKrw,
    status: 'issued',
    issuedAt: new Date(),
  });

  if (!invoiceRow) {
    // Idempotent path: invoice already exists for this period.
    log.info(
      { customerId, periodStart, periodEnd },
      'billing.close: invoice already exists — skipping (idempotent)',
    );
    return { invoiceId: null, alreadyExists: true, totalKrw };
  }

  const invoiceId = invoiceRow.id;

  // 8. Insert invoice_line rows (base / overage / VAT).
  //    These lines record the full breakdown for audit and customer display.

  // 8a. Base line: the fixed monthly subscription price.
  await insertInvoiceLine({
    invoiceId,
    kind: 'base',
    label: `월정액 구독 (${priceResult.tier} tier, ${scope.questionCount}문 × ${scope.languageCount}언어)`,
    amountKrw: baseKrw,
  });

  // 8b. Overage line: provider cost with FX + margin applied.
  //     This is never the raw llm_call.usd amount — it is the customer-facing
  //     metered price after margin and FX conversion.
  if (usageOverageKrw > 0) {
    await insertInvoiceLine({
      invoiceId,
      kind: 'overage',
      label: `LLM 사용량 초과 (원가 $${llmUsageUsd.toFixed(4)} USD × FX ${fxRateKrwPerUsd}/USD × ${OVERAGE_MARGIN_MULTIPLIER}× 마진)`,
      amountKrw: usageOverageKrw,
    });
  }

  // 8c. VAT line: §1 'VAT 별도' — explicit, never bundled.
  //     kind='vat' so SUM(amount_krw) WHERE kind='base' equals invoice.base_krw
  //     and the tax line is correctly labelled (not counted into the base subtotal).
  if (vatKrw > 0) {
    await insertInvoiceLine({
      invoiceId,
      kind: 'vat',
      label: '부가가치세 (VAT 10%)',
      amountKrw: vatKrw,
    });
  }

  log.info(
    {
      customerId,
      invoiceId,
      baseKrw,
      usageOverageKrw,
      vatKrw,
      totalKrw,
      tier: priceResult.tier,
    },
    'billing.close: invoice created',
  );

  // 9. Optional: call the payment provider (Stripe/Toss seam).
  if (input.paymentProvider) {
    try {
      await input.paymentProvider.initiatePayment({
        invoiceId,
        customerId,
        periodLabel: formatPeriodLabel(periodStart),
        periodStart,
        periodEnd,
        totalKrw,
      });
    } catch (err) {
      // Payment initiation failure is non-fatal — invoice stays 'issued' for
      // manual reconciliation. Do not re-throw; billing close succeeds even when
      // payment collection fails.
      log.error(
        { customerId, invoiceId, err },
        'billing.close: payment provider call failed — invoice stays issued (manual reconciliation)',
      );
    }
  }

  return { invoiceId, alreadyExists: false, totalKrw };
}

// ---------------------------------------------------------------------------
// Billing close job handler (called by the scheduler worker)
// ---------------------------------------------------------------------------

/**
 * Run the monthly billing close for ALL active customers.
 *
 * Called by the billing.close pg-boss job handler in worker.ts (1st of month).
 * Reads all customers, computes the prior full month window, and calls
 * closeBillingPeriod for each. Errors per customer do not stop other customers.
 *
 * @param fxRateKrwPerUsd  Live USD→KRW rate (injected from env or rate provider).
 * @param paymentProvider  Optional payment provider seam.
 */
export async function runMonthlyClose(
  fxRateKrwPerUsd = DEFAULT_FX_RATE_KRW_PER_USD,
  paymentProvider?: PaymentProvider,
): Promise<void> {
  const db = getDb();

  // Compute the prior full month window.
  // billing.close runs on the 1st of the month, so "prior month" = last month.
  const now = new Date();
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  log.info({ periodStart, periodEnd }, 'billing.close: starting monthly close run');

  // Fetch all customers.
  const customers = await db
    .selectFrom('customer')
    .select(['id', 'slug'])
    .execute();

  log.info({ count: customers.length }, 'billing.close: closing for customers');

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const customer of customers) {
    try {
      const closeInput: CloseInput = {
        customerId: customer.id,
        periodStart,
        periodEnd,
        fxRateKrwPerUsd,
      };
      if (paymentProvider !== undefined) {
        closeInput.paymentProvider = paymentProvider;
      }
      const result = await closeBillingPeriod(closeInput);

      if (result.alreadyExists) {
        skipped++;
        log.debug(
          { customerId: customer.id, slug: customer.slug },
          'billing.close: already invoiced — skipped',
        );
      } else if (result.invoiceId) {
        succeeded++;
        log.info(
          { customerId: customer.id, slug: customer.slug, invoiceId: result.invoiceId, totalKrw: result.totalKrw },
          'billing.close: invoice created',
        );
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      log.error(
        { customerId: customer.id, slug: customer.slug, err },
        'billing.close: error closing period — skipping customer',
      );
    }
  }

  log.info(
    { succeeded, skipped, failed, total: customers.length },
    'billing.close: monthly close run complete',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a period start date as a human-readable Korean month label.
 * e.g. new Date('2026-06-01') → "2026년 6월"
 */
function formatPeriodLabel(periodStart: Date): string {
  const year = periodStart.getUTCFullYear();
  const month = periodStart.getUTCMonth() + 1;
  return `${year}년 ${month}월`;
}
