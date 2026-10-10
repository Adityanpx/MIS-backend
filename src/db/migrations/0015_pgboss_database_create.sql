-- pg-boss runs `CREATE SCHEMA IF NOT EXISTS pgboss` on start; Postgres checks the database-level CREATE privilege
-- before the IF NOT EXISTS test. Local owners are superusers so it never showed; Supabase's `postgres` is not.
-- Only admin_user (the job runner) gets it; app_user stays unprivileged.
DO $$ BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO admin_user', current_database());
END $$;
