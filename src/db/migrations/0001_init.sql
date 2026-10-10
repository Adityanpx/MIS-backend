-- Schema for all application objects. public stays empty and unexposed.
CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON SCHEMA app FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON SCHEMA app FROM authenticated'; END IF;
END $$;

-- Two login roles used by the running API. Neither owns any table, so RLS always applies to them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOINHERIT PASSWORD {{APP_DB_PASSWORD}};
  ELSE
    ALTER ROLE app_user WITH LOGIN PASSWORD {{APP_DB_PASSWORD}};
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_user') THEN
    CREATE ROLE admin_user LOGIN NOINHERIT PASSWORD {{ADMIN_DB_PASSWORD}};
  ELSE
    ALTER ROLE admin_user WITH LOGIN PASSWORD {{ADMIN_DB_PASSWORD}};
  END IF;
END $$;

-- The migration owner must be a member of admin_user to hand SECURITY DEFINER functions to it (0008).
GRANT admin_user TO CURRENT_USER;
GRANT USAGE ON SCHEMA app TO app_user, admin_user;

-- Job queue schema (Phase 2, pg-boss) owned by admin_user.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION admin_user;

-- Current tenant / actor from TRANSACTION-LOCAL settings set by src/db/tenant.ts.
-- NULL when not set → every tenant policy evaluates to false → zero rows (fail closed).
CREATE OR REPLACE FUNCTION app.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_actor() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.actor_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := coalesce(app.current_actor(), NEW.updated_by);
  RETURN NEW;
END $$;
