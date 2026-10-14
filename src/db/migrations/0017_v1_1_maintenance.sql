-- =====================================================================
-- v1.1 — Maintenance module: equipment register, breakdown log, append-only update trail
-- =====================================================================

CREATE TABLE app.equipment (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  plant_id               uuid NOT NULL,
  code                   text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_-]{1,40}$'),
  name                   text NOT NULL,
  category               text NOT NULL,                               -- free text, UI-driven list
  area                   text,
  make_model             text,
  capacity               text,
  criticality            text NOT NULL CHECK (criticality IN ('critical','major','minor')),
  standby                text NOT NULL DEFAULT 'none'
                         CHECK (standby IN ('yes','no','none')),
  installed_on           date,
  status                 text NOT NULL DEFAULT 'in_service'
                         CHECK (status IN ('in_service','out_of_service')),
  out_of_service_reason  text,
  out_of_service_on      date,
  is_active              boolean NOT NULL DEFAULT true,               -- soft-delete: equipment is never hard-deleted
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz,
  updated_by             uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, plant_id, code),
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX equipment_plant_ix ON app.equipment (tenant_id, plant_id, is_active, criticality);

CREATE TABLE app.breakdowns (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  plant_id               uuid NOT NULL,
  equipment_id           uuid NOT NULL,
  started_at             timestamptz NOT NULL,
  fault                  text NOT NULL,
  cause_category         text CHECK (cause_category IN (
                           'mechanical','electrical','instrumentation','process',
                           'power_failure','operator_error','wear_and_tear','other')),
  impact                 text NOT NULL CHECK (impact IN (
                           'none','reduced_capacity','bypass','plant_stopped')),
  standby_running        text NOT NULL DEFAULT 'none'
                         CHECK (standby_running IN ('yes','no','none')),
  action_taken           text,
  spares_required        text,
  expected_restore_on    date,
  status                 text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','in_progress','awaiting_spares','restored','cancelled')),
  restored_at            timestamptz,
  root_cause             text,
  corrective_action      text,
  cost                   numeric(14,2),
  cancelled_reason       text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL,
  updated_at             timestamptz,
  updated_by             uuid,
  UNIQUE (tenant_id, id),
  CHECK (restored_at IS NULL OR restored_at >= started_at),
  CHECK ((status = 'restored') = (restored_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, plant_id)     REFERENCES app.plants    (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES app.equipment (tenant_id, id)
);

CREATE INDEX breakdowns_by_plant_time_ix
  ON app.breakdowns (tenant_id, plant_id, started_at);

CREATE INDEX breakdowns_open_ix
  ON app.breakdowns (tenant_id, plant_id)
  WHERE status IN ('open','in_progress','awaiting_spares');

CREATE INDEX breakdowns_by_equipment_time_ix
  ON app.breakdowns (tenant_id, equipment_id, started_at);

CREATE TABLE app.breakdown_updates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  breakdown_id  uuid NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  user_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN (
                  'created','status','note','restored','reopened','cancelled','corrected')),
  status_after  text,
  note          text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, breakdown_id) REFERENCES app.breakdowns (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX breakdown_updates_by_bd_ix
  ON app.breakdown_updates (tenant_id, breakdown_id, at);

-- RLS: the 0009 generator loop already ran once, so new tenant tables need it added explicitly (same pattern as 0013/0014).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['equipment', 'breakdowns', 'breakdown_updates'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_%1$s_tenant ON app.%1$I FOR ALL TO app_user
                    USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant())', t);
    EXECUTE format('CREATE POLICY p_%1$s_admin ON app.%1$I FOR ALL TO admin_user USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON app.equipment  TO app_user; -- no DELETE: equipment is soft-deleted (is_active)
GRANT SELECT, INSERT, UPDATE ON app.breakdowns TO app_user; -- no DELETE: breakdowns are cancelled, never removed
GRANT SELECT, INSERT         ON app.breakdown_updates TO app_user; -- append-only trail
