-- =====================================================================
-- v1.1 — Standards, tabs, management role, plant settings extensions
-- Runs after 0015_pgboss_database_create.sql
-- =====================================================================

-- 1) parameter_standards: add kind + inherit_from_kind
ALTER TABLE app.parameter_standards
  ADD COLUMN kind text NOT NULL DEFAULT 'actual'
    CHECK (kind IN ('bidding','actual')),
  ADD COLUMN inherit_from_kind text
    CHECK (inherit_from_kind IN ('bidding','actual'));

-- Existing rows load as 'actual' (Excel-era values were always the Actual standard).
-- Replace the unique constraint so each kind keeps its own effective-dated series.
ALTER TABLE app.parameter_standards
  DROP CONSTRAINT parameter_standards_tenant_id_parameter_id_effective_from_key;

ALTER TABLE app.parameter_standards
  ADD CONSTRAINT parameter_standards_uq
  UNIQUE (tenant_id, parameter_id, kind, effective_from);

CREATE INDEX parameter_standards_lookup_ix
  ON app.parameter_standards (tenant_id, parameter_id, kind, effective_from DESC);

-- 2) parameters: add monitoring_tab + per-parameter result-display override
ALTER TABLE app.parameters
  ADD COLUMN monitoring_tab text
    CHECK (monitoring_tab IN ('key','chemicals','compliance','administrative','maintenance')),
  ADD COLUMN result_display text
    CHECK (result_display IN ('pct','qty','both','none'));

-- Backfill monitoring_tab from the existing group_key.
UPDATE app.parameters
   SET monitoring_tab = CASE
     WHEN group_key = 'key'                      THEN 'key'
     WHEN group_key = 'chemical'                 THEN 'chemicals'
     WHEN group_key IN ('lab_inlet', 'lab_outlet') THEN 'compliance'
     ELSE 'administrative'
   END
 WHERE monitoring_tab IS NULL;

ALTER TABLE app.parameters
  ALTER COLUMN monitoring_tab SET NOT NULL,
  ALTER COLUMN monitoring_tab SET DEFAULT 'administrative';

-- 3) plant_settings: v1.1 fields
ALTER TABLE app.plant_settings
  ADD COLUMN primary_standard text NOT NULL DEFAULT 'actual'
    CHECK (primary_standard IN ('bidding','actual')),
  ADD COLUMN standards_shown text NOT NULL DEFAULT 'both'
    CHECK (standards_shown IN ('bidding','actual','both')),
  ADD COLUMN results_display text NOT NULL DEFAULT 'both'
    CHECK (results_display IN ('pct','qty','both')),
  ADD COLUMN tab_labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN maintenance_settings jsonb NOT NULL DEFAULT jsonb_build_object(
      'enabled', false,
      'reviewTickRequired', true,
      'longOpenAlertDays', 3,
      'criticalLongOpenDays', 1,
      'repeatThreshold', 3,
      'repeatWindowDays', 90,
      'criticalAlertEnabled', true
    ),
  ADD COLUMN v1_1_enabled boolean NOT NULL DEFAULT false;

-- 4) users: company-wide read-only Management role
ALTER TABLE app.users
  ADD COLUMN is_management boolean NOT NULL DEFAULT false;

-- A user is either Client Admin or Management, never both.
ALTER TABLE app.users
  ADD CONSTRAINT users_role_singular_ck
  CHECK (NOT (is_client_admin AND is_management));

-- 5) plans: Management-user cap (per-plant cap already exists as max_users_per_plant)
ALTER TABLE app.plans
  ADD COLUMN max_management_users int NOT NULL DEFAULT 5
    CHECK (max_management_users BETWEEN 0 AND 100);

-- 6) revenue_components: an independent "Actual" quantity for the two-standards revenue split (§13.10).
-- NULL means "same as the Bidding (contract) quantity" — existing plants compute revStdActual = revStd until set.
ALTER TABLE app.revenue_components
  ADD COLUMN actual_std_qty_per_day numeric(18,6) CHECK (actual_std_qty_per_day >= 0);
