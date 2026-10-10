-- updated_at trigger on every app table that has an updated_at column
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'app' AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%1$s_touch BEFORE UPDATE ON app.%1$I
                    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', r.table_name);
  END LOOP;
END $$;

-- audit_log is append-only for everybody
CREATE OR REPLACE FUNCTION app.audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER trg_audit_log_immutable BEFORE UPDATE OR DELETE ON app.audit_log
FOR EACH ROW EXECUTE FUNCTION app.audit_log_immutable();

-- ---------- Login-time lookups (tenant not yet known). Owned by admin_user, callable by app_user. ----------
CREATE OR REPLACE FUNCTION app.auth_find_user_by_email(p_email text)
RETURNS TABLE (
  id uuid, tenant_id uuid, name text, email text, password_hash text, status text,
  is_client_admin boolean, totp_enabled boolean, failed_logins int, locked_until timestamptz,
  token_version int, client_status text, client_account_state text, client_force_2fa boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.name, u.email, u.password_hash, u.status,
         u.is_client_admin, u.totp_enabled, u.failed_logins, u.locked_until,
         u.token_version, c.status, c.account_state, c.force_2fa
  FROM app.users u JOIN app.clients c ON c.id = u.tenant_id
  WHERE lower(u.email) = lower(p_email)
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.auth_find_refresh(p_hash text)
RETURNS TABLE (
  id uuid, tenant_id uuid, user_id uuid, family_id uuid, expires_at timestamptz, revoked_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT r.id, r.tenant_id, r.user_id, r.family_id, r.expires_at, r.revoked_at
  FROM app.refresh_tokens r WHERE r.token_hash = p_hash LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.auth_find_token(p_hash text, p_purpose text)
RETURNS TABLE (id uuid, tenant_id uuid, user_id uuid, expires_at timestamptz, used_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT t.id, t.tenant_id, t.user_id, t.expires_at, t.used_at
  FROM app.auth_tokens t WHERE t.token_hash = p_hash AND t.purpose = p_purpose LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.public_platform_settings()
RETURNS TABLE (key text, value jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT s.key, s.value FROM app.platform_settings s WHERE s.is_public
$$;

-- Non-superuser owners (Supabase) need CREATE on the schema to hand objects to admin_user; revoked right after.
GRANT CREATE ON SCHEMA app TO admin_user;
ALTER FUNCTION app.auth_find_user_by_email(text) OWNER TO admin_user;
ALTER FUNCTION app.auth_find_refresh(text)       OWNER TO admin_user;
ALTER FUNCTION app.auth_find_token(text, text)   OWNER TO admin_user;
ALTER FUNCTION app.public_platform_settings()    OWNER TO admin_user;
REVOKE CREATE ON SCHEMA app FROM admin_user;
REVOKE ALL ON FUNCTION app.auth_find_user_by_email(text), app.auth_find_refresh(text),
                       app.auth_find_token(text, text), app.public_platform_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_find_user_by_email(text), app.auth_find_refresh(text),
                          app.auth_find_token(text, text), app.public_platform_settings() TO app_user;
GRANT EXECUTE ON FUNCTION app.current_tenant(), app.current_actor() TO app_user, admin_user;
