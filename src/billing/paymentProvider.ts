/**
 * src/billing/paymentProvider.ts
 *
 * PaymentProvider seam — pluggable payment integration interface.
 *
 * Phase 5 ships the data model + invoice generation + manual/CSV export.
 * Payment capture is OUT of scope (B2B sales-led invoice motion, like gpto's
 * ~₩2M/mo model). This seam holds the interface for a future Stripe/Toss adapter.
 *
 * Design: mirrors the existing AlertSink / DeliverySink / SecretProvider seam
 * pattern — a plain TypeScript interface that all adapters implement, with a
 * Noop default for development. Production adapters are wired at startup via
 * dependency injection (not hard-imported).
 */

// ---------------------------------------------------------------------------
// Invoice data passed to the payment provider
// ---------------------------------------------------------------------------

export interface InvoicePaymentRequest {
  /** invoice.id (UUID). */
  invoiceId: string;
  /** customer.id (UUID). */
  customerId: string;
  /** Customer-facing billing period description (e.g. "2026년 6월"). */
  periodLabel: string;
  /** Invoice start (inclusive). */
  periodStart: Date;
  /** Invoice end (exclusive). */
  periodEnd: Date;
  /** Total amount including VAT, in KRW. */
  totalKrw: number;
  /** Customer email for receipt delivery (if available). */
  recipientEmail?: string;
}

export interface InvoicePaymentResult {
  /** External payment reference (e.g. Stripe PaymentIntent ID or Toss order ID). */
  externalRef: string;
  /** Status returned by the payment provider. */
  status: 'pending' | 'succeeded' | 'failed';
  /** ISO 8601 timestamp of the payment attempt. */
  attemptedAt: string;
}

// ---------------------------------------------------------------------------
// PaymentProvider interface
// ---------------------------------------------------------------------------

/**
 * PaymentProvider — seam for future Stripe / Toss payment integration.
 *
 * Phase 5 ships the NoopPaymentProvider (no-op). Real adapters implement this
 * interface and are injected at startup via WorkerConfig / close.ts.
 *
 * All methods are async to support network calls in production adapters.
 */
export interface PaymentProvider {
  /**
   * Initiate a payment request for an issued invoice.
   *
   * In a real adapter, this creates a payment link / invoice in the provider's
   * system and returns an external reference. The returned status drives whether
   * the invoice is marked 'paid' immediately (e.g. direct debit) or left 'issued'
   * awaiting customer action (e.g. card flow or wire transfer).
   *
   * Phase 5: B2B sales-led — a real payment call is not needed. Returns a stub
   * result that leaves the invoice in 'issued' state for manual reconciliation.
   */
  initiatePayment(
    request: InvoicePaymentRequest,
  ): Promise<InvoicePaymentResult>;

  /**
   * Export invoice data as CSV for manual reconciliation / accountant hand-off.
   *
   * Returns a CSV string with columns:
   *   invoice_id, customer_id, period, base_krw, overage_krw, vat_krw, total_krw, status
   */
  exportToCsv(invoiceIds: string[]): Promise<string>;
}

// ---------------------------------------------------------------------------
// NoopPaymentProvider — development default (no real payment calls)
// ---------------------------------------------------------------------------

/**
 * NoopPaymentProvider — used in development and CI.
 *
 * All methods are no-ops that log and return stub results.
 * Injected as the default in close.ts when no real provider is configured.
 */
export class NoopPaymentProvider implements PaymentProvider {
  async initiatePayment(
    request: InvoicePaymentRequest,
  ): Promise<InvoicePaymentResult> {
    console.info(
      `[NoopPaymentProvider] Skipping payment initiation for invoice=${request.invoiceId} ` +
        `total=₩${request.totalKrw.toLocaleString()}`,
    );
    return {
      externalRef: `noop:${request.invoiceId}`,
      status: 'pending',
      attemptedAt: new Date().toISOString(),
    };
  }

  async exportToCsv(invoiceIds: string[]): Promise<string> {
    const header =
      'invoice_id,customer_id,period,base_krw,overage_krw,vat_krw,total_krw,status';
    // No-op: returns header only (real adapter joins to DB)
    console.info(
      `[NoopPaymentProvider] CSV export requested for ${invoiceIds.length} invoices (noop)`,
    );
    return header + '\n';
  }
}
