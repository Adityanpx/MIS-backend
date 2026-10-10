-- 1) Every table with tenant_id: RLS on + forced; app_user limited to the current tenant; admin_user unrestricted.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'app' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('CREATE POLICY p_%1$s_tenant ON app.%1$I FOR ALL TO app_user
                    USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant())',
                   r.table_name);
    EXECUTE format('CREATE POLICY p_%1$s_admin ON app.%1$I FOR ALL TO admin_user USING (true) WITH CHECK (true)',
                   r.table_name);
  END LOOP;
END $$;

-- 2) clients: the row whose id IS the current tenant.
ALTER TABLE app.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.clients FORCE ROW LEVEL SECURITY;
CREATE POLICY p_clients_tenant ON app.clients FOR ALL TO app_user
  USING (id = app.current_tenant()) WITH CHECK (id = app.current_tenant());
CREATE POLICY p_clients_admin ON app.clients FOR ALL TO admin_user USING (true) WITH CHECK (true);

-- 3) Platform tables (no tenant_id): only admin_user has a policy → app_user always sees nothing.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT t.table_name FROM information_schema.tables t
    WHERE t.table_schema = 'app' AND t.table_type = 'BASE TABLE'
      AND t.table_name NOT IN ('clients', 'schema_migrations')
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                      WHERE c.table_schema = 'app' AND c.table_name = t.table_name AND c.column_name = 'tenant_id')
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('CREATE POLICY p_%1$s_admin ON app.%1$I FOR ALL TO admin_user USING (true) WITH CHECK (true)',
                   r.table_name);
  END LOOP;
END $$;
