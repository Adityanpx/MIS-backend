import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL,
    ssl: process.env.DB_SSL === 'require' ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    const missingTenant = await client.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind = 'r'
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
             OR NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname
                            AND p.policyname = 'p_' || c.relname || '_tenant'))`);
    const missingAny = await client.query<{ table_name: string }>(`
      SELECT c.relname AS table_name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'app'
      WHERE c.relkind = 'r' AND c.relname <> 'schema_migrations' AND NOT c.relrowsecurity`);
    const problems = [...missingTenant.rows, ...missingAny.rows].map((r) => r.table_name);
    if (problems.length) {
      console.error(`RLS check FAILED for: ${[...new Set(problems)].join(', ')}`);
      process.exit(1);
    }
    console.log('RLS check passed: every app table has row-level security');
  } finally {
    await client.end();
  }
}
main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
