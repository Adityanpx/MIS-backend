CREATE TABLE app.subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  plant_id               uuid NOT NULL,
  plan_id                uuid NOT NULL REFERENCES app.plans(id),
  plan_snapshot          jsonb NOT NULL,
  custom_price_per_year  numeric(14,2),
  custom_reason          text,
  start_date             date NOT NULL,
  end_date               date NOT NULL,
  billing_mode           text NOT NULL CHECK (billing_mode IN ('yearly','upfront')),
  trial_days             int NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('scheduled','active','ended','cancelled')),
  cancelled_at           timestamptz,
  cancel_reason          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz,
  updated_by             uuid,
  UNIQUE (tenant_id, id),
  CHECK (end_date >= start_date),
  CHECK (end_date < (start_date + interval '15 years')::date),
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id)
);

CREATE TABLE app.billing_schedule (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  subscription_id       uuid NOT NULL,
  year_no               int NOT NULL CHECK (year_no BETWEEN 1 AND 15),
  period_from           date NOT NULL,
  period_to             date NOT NULL,
  amount                numeric(14,2) NOT NULL CHECK (amount >= 0),
  planned_invoice_date  date NOT NULL,
  due_date              date NOT NULL,
  invoice_id            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, subscription_id, year_no),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES app.subscriptions (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE app.invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES app.clients(id),
  number               text UNIQUE,
  fy                   text,
  kind                 text NOT NULL CHECK (kind IN ('subscription','manual')),
  issue_date           date,
  due_date             date,
  place_of_supply      text,
  gst_type             text CHECK (gst_type IN ('intra','inter')),
  taxable              numeric(14,2) NOT NULL DEFAULT 0,
  cgst                 numeric(14,2) NOT NULL DEFAULT 0,
  sgst                 numeric(14,2) NOT NULL DEFAULT 0,
  igst                 numeric(14,2) NOT NULL DEFAULT 0,
  round_off            numeric(14,2) NOT NULL DEFAULT 0,
  total                numeric(14,2) NOT NULL DEFAULT 0,
  paid                 numeric(14,2) NOT NULL DEFAULT 0,
  tds                  numeric(14,2) NOT NULL DEFAULT 0,
  credit_noted         numeric(14,2) NOT NULL DEFAULT 0,
  credit_applied       numeric(14,2) NOT NULL DEFAULT 0,
  balance              numeric(14,2) NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','issued','partially_paid','paid','overdue','cancelled','written_off')),
  pdf_key              text,
  rzp_link_id          text,
  rzp_link_url         text,
  rzp_link_expires_at  timestamptz,
  seller_snapshot      jsonb,
  buyer_snapshot       jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz,
  updated_by           uuid,
  UNIQUE (tenant_id, id)
);
ALTER TABLE app.billing_schedule
  ADD FOREIGN KEY (tenant_id, invoice_id) REFERENCES app.invoices (tenant_id, id);

CREATE TABLE app.invoice_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  invoice_id       uuid NOT NULL,
  plant_id         uuid,
  subscription_id  uuid,
  billing_year     int,
  description      text NOT NULL,
  sac              text,
  qty              numeric(12,3) NOT NULL DEFAULT 1,
  rate             numeric(14,2) NOT NULL,
  taxable          numeric(14,2) NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id)      REFERENCES app.invoices (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, plant_id)        REFERENCES app.plants (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES app.subscriptions (tenant_id, id)
);

CREATE TABLE app.credit_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  number      text NOT NULL UNIQUE,
  invoice_id  uuid NOT NULL,
  cn_date     date NOT NULL,
  taxable     numeric(14,2) NOT NULL,
  cgst        numeric(14,2) NOT NULL DEFAULT 0,
  sgst        numeric(14,2) NOT NULL DEFAULT 0,
  igst        numeric(14,2) NOT NULL DEFAULT 0,
  total       numeric(14,2) NOT NULL,
  reason      text NOT NULL,
  pdf_key     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES app.invoices (tenant_id, id)
);

CREATE TABLE app.payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.clients(id),
  mode            text NOT NULL CHECK (mode IN ('razorpay','cash','neft','rtgs','imps','cheque','upi','other')),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_date    date NOT NULL,
  reference       text,
  bank            text,
  cheque_date     date,
  status          text NOT NULL CHECK (status IN ('pending_clearance','applied','bounced','reversed')),
  source          text NOT NULL CHECK (source IN ('manual','razorpay','reconciliation','client_notification')),
  rzp_payment_id  text UNIQUE,
  proof_key       text,
  remarks         text,
  override_reason text,
  cleared_at      timestamptz,
  bounced_at      timestamptz,
  bounce_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz,
  updated_by      uuid,
  UNIQUE (tenant_id, id)
);

CREATE TABLE app.payment_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  payment_id  uuid NOT NULL,
  invoice_id  uuid,                                   -- NULL = amount kept as client credit
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES app.payments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES app.invoices (tenant_id, id)
);

CREATE TABLE app.tds_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  invoice_id          uuid NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  section             text NOT NULL,
  deduction_date      date NOT NULL,
  certificate_status  text NOT NULL DEFAULT 'pending' CHECK (certificate_status IN ('pending','received')),
  certificate_key     text,
  entered_by_client   boolean NOT NULL DEFAULT false,
  verified            boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz,
  updated_by          uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES app.invoices (tenant_id, id)
);

CREATE TABLE app.client_credit_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.clients(id),
  entry_date  date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('excess_payment','credit_note','applied','refunded')),
  amount      numeric(14,2) NOT NULL,                  -- positive adds credit, negative uses it
  ref_type    text,
  ref_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (tenant_id, id)
);

CREATE TABLE app.receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  number        text NOT NULL UNIQUE,
  payment_id    uuid NOT NULL,
  receipt_date  date NOT NULL,
  pdf_key       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES app.payments (tenant_id, id)
);

CREATE TABLE app.lifecycle_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.clients(id),
  plant_id    uuid,
  from_state  text NOT NULL,
  to_state    text NOT NULL,
  cause       text NOT NULL CHECK (cause IN ('auto','manual','payment','hold','expiry','created')),
  note        text,
  actor_type  text NOT NULL CHECK (actor_type IN ('super_admin','user','system')),
  actor_id    uuid,
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id)
);

CREATE TABLE app.payment_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  invoice_id  uuid NOT NULL,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_on     date NOT NULL,
  reference   text NOT NULL,
  proof_key   text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  handled_by  uuid,
  handled_at  timestamptz,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES app.invoices (tenant_id, id)
);

CREATE TABLE app.plant_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.clients(id),
  details     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','rejected')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz,
  updated_by  uuid,
  UNIQUE (tenant_id, id)
);
