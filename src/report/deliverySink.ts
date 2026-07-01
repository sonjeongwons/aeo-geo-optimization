/**
 * src/report/deliverySink.ts
 *
 * DeliverySink — pluggable email delivery abstraction for weekly SMR reports.
 *
 * Design (DESIGN-phase5.md §"Report Automation"):
 * - DeliverySink is an interface; the implementation is injected at boot.
 * - Phase 5 ships at least ONE real sink (Resend HTTP adapter) so the §10
 *   retention loop is actually functional end-to-end.
 * - NoopSink is the dev default (no external calls; logs to console).
 * - A Resend adapter is the production default (RESEND_API_KEY env var).
 * - A future SMTP adapter can be plugged in by implementing the interface.
 *
 * Failure semantics:
 * - DeliverySink.send throws on permanent failure (bad recipient, auth error).
 * - Transient failures should be retried by the caller (deliver.ts) or the
 *   pg-boss retry mechanism; sink implementations may throw for any failure.
 */

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface DeliveryMessage {
  /** Recipient email address. */
  to: string;
  /** Email subject line. */
  subject: string;
  /** Rendered HTML body. */
  html: string;
  /** Plain-text fallback (optional). */
  text?: string;
}

/**
 * DeliverySink — interface for pluggable email delivery.
 *
 * Implementations:
 *   NoopSink     — dev default; logs to stdout, never calls external services.
 *   ResendSink   — production; sends via Resend HTTP API (RESEND_API_KEY required).
 */
export interface DeliverySink {
  readonly name: string;
  send(message: DeliveryMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// NoopSink — dev default (console log, no external calls)
// ---------------------------------------------------------------------------

/**
 * NoopSink: logs the email to stdout without sending.
 *
 * Used as the dev default when RESEND_API_KEY is not set, and in unit tests.
 * All calls succeed immediately; the subject + recipient are logged at info level.
 */
export class NoopSink implements DeliverySink {
  readonly name = 'noop';

  async send(message: DeliveryMessage): Promise<void> {
    console.info(
      `[NoopSink] Would send email: to=${message.to} subject="${message.subject}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// ResendSink — production delivery via Resend HTTP API
// ---------------------------------------------------------------------------

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * ResendSink: sends via the Resend HTTP API.
 *
 * Requires RESEND_API_KEY env var and a verified fromAddress.
 * Throws on HTTP errors (4xx auth/validation, 5xx transient).
 */
export class ResendSink implements DeliverySink {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string,
  ) {}

  async send(message: DeliveryMessage): Promise<void> {
    const body = {
      from: this.fromAddress,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      ...(message.text !== undefined ? { text: message.text } : {}),
    };

    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const err = await response.json() as { message?: string };
        detail = err.message ?? response.statusText;
      } catch {
        detail = response.statusText;
      }
      throw new DeliverySinkError(
        `ResendSink: HTTP ${response.status} — ${detail}`,
        response.status,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class DeliverySinkError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'DeliverySinkError';
  }
}

// ---------------------------------------------------------------------------
// Factory — build the appropriate sink from environment
// ---------------------------------------------------------------------------

/**
 * Build the appropriate DeliverySink from the environment.
 *
 * Priority:
 *   1. RESEND_API_KEY set → ResendSink (production).
 *   2. Fallback → NoopSink (dev/test).
 *
 * fromAddress defaults to "reports@aeo-geo.io" — override via REPORT_FROM_ADDRESS.
 */
export function buildDeliverySink(env: NodeJS.ProcessEnv = process.env): DeliverySink {
  const apiKey = env['RESEND_API_KEY'];
  const fromAddress = env['REPORT_FROM_ADDRESS'] ?? 'reports@aeo-geo.io';

  if (apiKey && apiKey.length > 0) {
    return new ResendSink(apiKey, fromAddress);
  }

  return new NoopSink();
}
