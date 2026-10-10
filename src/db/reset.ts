import dotenv from 'dotenv';
import { Client } from 'pg';
import { passwordFromUrl, runMigrations } from './migrate';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

export async function resetDatabase(log: (m: string) => void = (m) => console.log(m)): Promise<void> {
  const url = process.env.DIRECT_URL ?? '';
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (!['development', 'test'].includes(nodeEnv) || !/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error('db:reset is only allowed for NODE_ENV development/test against a localhost database');
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
    await client.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  } finally {
    await client.end();
  }
  await runMigrations({
    databaseUrl: url,
    appPassword: passwordFromUrl(process.env.DATABASE_URL ?? ''),
    adminPassword: passwordFromUrl(process.env.ADMIN_DATABASE_URL ?? ''),
    log,
  });
}

if (require.main === module) {
  resetDatabase()
    .then(() => process.exit(0))
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
