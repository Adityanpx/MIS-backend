-- File 2 (frontend): per-user, per-plant dashboard layout chosen in the "Add widget" drawer.
-- A tenant table like every other: composite FKs keep user and plant inside the same tenant, RLS keeps it inside the tenant.
CREATE TABLE app.dashboard_layouts (
  tenant_id   uuid NOT NULL REFERENCES app.clients(id),
  user_id     uuid NOT NULL,
  plant_id    uuid NOT NULL,
  layout      jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, plant_id),
  FOREIGN KEY (tenant_id, user_id)  REFERENCES app.users  (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, plant_id) REFERENCES app.plants (tenant_id, id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(layout) = 'object'),
  CHECK (pg_column_size(layout) < 8192)
);

ALTER TABLE app.dashboard_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dashboard_layouts FORCE ROW LEVEL SECURITY;
CREATE POLICY p_dashboard_layouts_tenant ON app.dashboard_layouts FOR ALL TO app_user
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
CREATE POLICY p_dashboard_layouts_admin ON app.dashboard_layouts FOR ALL TO admin_user USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.dashboard_layouts TO app_user, admin_user;

CREATE INDEX dashboard_layouts_plant_idx ON app.dashboard_layouts (tenant_id, plant_id);
