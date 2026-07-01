-- ===== 0014_billing.sql : subscription + invoice (KRW, VAT-aware) =====
-- PLAIN tables — fully transactional; no Timescale objects, no RLS.
-- All monetary amounts are in KRW (Korean Won). Provider cost (USD) is kept in
-- llm_call.usd; the billing layer converts to KRW with margin+FX in invoice_line.

BEGIN;

CREATE TABLE IF NOT EXISTS subscription (
  -- One subscription per customer (PK = customer_id)
  customer_id          uuid        PRIMARY KEY REFERENCES customer(id),
  plan_tier            text        NOT NULL,
  base_krw             numeric     NOT NULL DEFAULT 0,
  -- 'trialing' | 'active' | 'paused' | 'canceled'
  status               text        NOT NULL CHECK (status IN ('trialing','active','paused','canceled')) DEFAULT 'active',
  started_at           timestamptz NOT NULL DEFAULT now(),
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end   timestamptz NOT NULL,
  -- Set true to cancel at the end of the current period (no immediate data loss)
  cancel_at_period_end boolean     NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid        NOT NULL REFERENCES customer(id),
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,
  base_krw           numeric     NOT NULL DEFAULT 0,
  -- Overage: margin + USD->KRW FX applied (never raw llm_call USD)
  usage_overage_krw  numeric     NOT NULL DEFAULT 0,
  -- §1 'VAT 별도' — VAT is explicit and separate
  vat_krw            numeric     NOT NULL DEFAULT 0,
  total_krw          numeric     NOT NULL DEFAULT 0,
  -- 'draft' | 'issued' | 'paid' | 'void'
  status             text        NOT NULL CHECK (status IN ('draft','issued','paid','void')) DEFAULT 'draft',
  issued_at          timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Idempotent monthly close: one invoice per customer per billing period
  UNIQUE (customer_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS ix_invoice_customer ON invoice (customer_id, period_start DESC);

CREATE TABLE IF NOT EXISTS invoice_line (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid    NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  -- 'base' | 'overage' | 'human_ops'
  -- overage includes margin+FX; human_ops is manually entered
  kind        text    NOT NULL CHECK (kind IN ('base','overage','human_ops')),
  label       text    NOT NULL,
  amount_krw  numeric NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_invoice_line_invoice ON invoice_line (invoice_id);

COMMIT;
