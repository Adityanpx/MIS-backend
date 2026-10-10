-- ============================================================ 1) column additions
ALTER TABLE app.invoices
  ADD COLUMN gst_rate_pct          numeric(5,2)  NOT NULL DEFAULT 18,
  ADD COLUMN excess_to_credit      numeric(14,2) NOT NULL DEFAULT 0,   -- overflow moved to client credit (credit note on a paid invoice)
  ADD COLUMN tolerance_written_off numeric(14,2) NOT NULL DEFAULT 0,   -- TDS-03
  ADD COLUMN rzp_link_amount       numeric(14,2),
  ADD COLUMN issued_at             timestamptz,
  ADD COLUMN cancelled_at          timestamptz,
  ADD COLUMN cancel_reason         text,
  ADD COLUMN notes                 text;

ALTER TABLE app.payments
  ADD COLUMN method                  text,                               -- upi / card / netbanking (Razorpay)
  ADD COLUMN gateway_fee             numeric(14,2) NOT NULL DEFAULT 0,   -- RZP-06 convenience fee (not allocated)
  ADD COLUMN needs_review            boolean NOT NULL DEFAULT false,     -- amount mismatch / reconciliation
  ADD COLUMN review_note             text,
  ADD COLUMN reversed_at             timestamptz,
  ADD COLUMN reverse_reason          text,
  ADD COLUMN payment_notification_id uuid;

ALTER TABLE app.subscriptions
  ADD COLUMN pending_plan_id       uuid REFERENCES app.plans(id),        -- SUB-06: change from the next billing year
  ADD COLUMN pending_plan_snapshot jsonb,
  ADD COLUMN pending_effective     date;

ALTER TABLE app.clients ADD COLUMN deleted_at timestamptz;
ALTER TABLE app.tds_entries ADD COLUMN note text;

ALTER TABLE app.client_credit_ledger DROP CONSTRAINT client_credit_ledger_kind_check;
ALTER TABLE app.client_credit_ledger ADD CONSTRAINT client_credit_ledger_kind_check
  CHECK (kind IN ('excess_payment', 'credit_note', 'applied', 'refunded', 'reversal', 'adjustment'));

-- ============================================================ 2) new tenant tables
CREATE TABLE app.lifecycle_holds (                 -- LC-05: the suspension clock is paused inside these windows
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.clients(id),
  plant_id    uuid,                                -- NULL = the whole client
  from_date   date NOT NULL,
  until_date  date NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (tenant_id, id),
  CHECK (until_date >= from_date),
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id)
);

CREATE TABLE app.reminder_log (                    -- every billing/lifecycle notice is sent once per key
  tenant_id  uuid NOT NULL REFERENCES app.clients(id),
  key        text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE app.usage_snapshots (                 -- USE-01..03, written by usage.snapshot (04:00 IST)
  snap_date           date NOT NULL,
  tenant_id           uuid NOT NULL,
  plant_id            uuid NOT NULL,
  active_users        int NOT NULL,
  max_users           int NOT NULL,
  storage_bytes       bigint NOT NULL,
  storage_gb          int NOT NULL,
  logsheets_7d        int NOT NULL,
  logsheets_30d       int NOT NULL,
  last_logsheet_date  date,
  last_login_at       timestamptz,
  setup_status        text NOT NULL,
  account_state       text NOT NULL,
  PRIMARY KEY (snap_date, tenant_id, plant_id),
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id) ON DELETE CASCADE
);

-- ============================================================ 3) new platform table (no tenant_id → admin only)
CREATE TABLE app.admin_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,                       -- N-S01 … N-S06
  title       text NOT NULL,
  body        text NOT NULL,
  link        text,
  client_id   uuid REFERENCES app.clients(id) ON DELETE SET NULL,
  dedupe_key  text UNIQUE,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================ 4) RLS + grants for the new tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lifecycle_holds', 'reminder_log', 'usage_snapshots'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_%1$s_tenant ON app.%1$I FOR ALL TO app_user
                    USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant())', t);
    EXECUTE format('CREATE POLICY p_%1$s_admin ON app.%1$I FOR ALL TO admin_user USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
ALTER TABLE app.admin_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.admin_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY p_admin_notifications_admin ON app.admin_notifications FOR ALL TO admin_user USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.lifecycle_holds, app.reminder_log, app.usage_snapshots, app.admin_notifications
  TO admin_user;
-- app_user: read its own holds (banners compute the next state change) and its own act-as sessions (auth-client check)
GRANT SELECT ON app.lifecycle_holds, app.act_as_sessions TO app_user;

-- ============================================================ 5) SECURITY DEFINER functions
-- Act-as exchange (TRD §5.4.5): marks the one-time code used and returns the session + the tenant's primary Client Admin.
CREATE OR REPLACE FUNCTION app.auth_use_act_as_code(p_hash text)
RETURNS TABLE (session_id uuid, tenant_id uuid, super_admin_id uuid, mode text, user_id uuid, started_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = app, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  UPDATE app.act_as_sessions s
     SET code_used_at = now(), started_at = now()
   WHERE s.code_hash = p_hash AND s.code_used_at IS NULL AND s.ended_at IS NULL AND s.code_expires_at > now()
  RETURNING s.id, s.tenant_id, s.super_admin_id, s.mode,
            (SELECT u.id FROM app.users u
              WHERE u.tenant_id = s.tenant_id AND u.is_client_admin AND u.status = 'active'
              ORDER BY u.created_at LIMIT 1),
            s.started_at;
END $$;

-- Announcements for the CURRENT tenant (app.tenant_id setting) or, without a tenant, only those for all clients.
CREATE OR REPLACE FUNCTION app.active_announcements()
RETURNS TABLE (id uuid, message text, level text, starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT a.id, a.message, a.level, a.starts_at, a.ends_at
    FROM app.announcements a
   WHERE now() BETWEEN a.starts_at AND a.ends_at
     AND (coalesce((a.audience->>'all')::boolean, false)
          OR (app.current_tenant() IS NOT NULL AND (a.audience->'clientIds') ? app.current_tenant()::text))
   ORDER BY a.starts_at DESC
   LIMIT 5
$$;

-- Non-superuser owners (Supabase) need CREATE on the schema to hand objects to admin_user; revoked right after.
GRANT CREATE ON SCHEMA app TO admin_user;
ALTER FUNCTION app.auth_use_act_as_code(text) OWNER TO admin_user;
ALTER FUNCTION app.active_announcements()      OWNER TO admin_user;
REVOKE CREATE ON SCHEMA app FROM admin_user;
REVOKE ALL ON FUNCTION app.auth_use_act_as_code(text), app.active_announcements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_use_act_as_code(text), app.active_announcements() TO app_user;

-- ============================================================ 6) constraints and indexes
-- SUB-04: only one active and one scheduled subscription per plant.
CREATE UNIQUE INDEX subscriptions_one_active_uq    ON app.subscriptions (tenant_id, plant_id) WHERE status = 'active';
CREATE UNIQUE INDEX subscriptions_one_scheduled_uq ON app.subscriptions (tenant_id, plant_id) WHERE status = 'scheduled';

CREATE INDEX invoice_lines_invoice_idx  ON app.invoice_lines (tenant_id, invoice_id);
CREATE INDEX invoice_lines_plant_idx    ON app.invoice_lines (tenant_id, plant_id);
CREATE INDEX alloc_invoice_idx          ON app.payment_allocations (tenant_id, invoice_id);
CREATE INDEX alloc_payment_idx          ON app.payment_allocations (tenant_id, payment_id);
CREATE INDEX payments_status_mode_idx   ON app.payments (status, mode);
CREATE INDEX credit_ledger_tenant_idx   ON app.client_credit_ledger (tenant_id, entry_date);
CREATE INDEX tds_invoice_idx            ON app.tds_entries (tenant_id, invoice_id);
CREATE INDEX credit_notes_invoice_idx   ON app.credit_notes (tenant_id, invoice_id);
CREATE INDEX receipts_payment_idx       ON app.receipts (tenant_id, payment_id);
CREATE INDEX holds_tenant_idx           ON app.lifecycle_holds (tenant_id, plant_id);
CREATE INDEX usage_latest_idx           ON app.usage_snapshots (tenant_id, plant_id, snap_date DESC);
CREATE INDEX audit_at_idx               ON app.audit_log (at DESC);
CREATE INDEX admin_notif_created_idx    ON app.admin_notifications (created_at DESC);
CREATE INDEX payment_notif_status_idx   ON app.payment_notifications (status, created_at);
CREATE INDEX invoices_issue_idx         ON app.invoices (issue_date);

