import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 727274;

/** Password embedded in a postgres:// URL (percent-decoded). */
export function passwordFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

export interface MigrateOptions {
  databaseUrl: string;
  appPassword: string;
  adminPassword: string;
  ssl?: boolean;
  log?: (msg: string) => void;
}

export async function runMigrations(opts: MigrateOptions): Promise<number> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const client = new Client({ connectionString: opts.databaseUrl, ssl: opts.ssl ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  let applied = 0;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query('CREATE SCHEMA IF NOT EXISTS app');
    await client.query(`CREATE TABLE IF NOT EXISTS app.schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM app.schema_migrations'))
        .rows.map((r) => [r.filename, r.checksum]),
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const file of files) {
      const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(raw).digest('hex');
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) throw new Error(`Migration ${file} was modified after it was applied. Create a new migration instead.`);
        continue;
      }
      const sql = raw
        .replaceAll('{{APP_DB_PASSWORD}}', client.escapeLiteral(opts.appPassword))
        .replaceAll('{{ADMIN_DB_PASSWORD}}', client.escapeLiteral(opts.adminPassword));
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO app.schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied += 1;
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (applied === 0) log('No pending migrations');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return applied;
}

if (require.main === module) {
  const url = process.env.DIRECT_URL;
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!url || !appUrl || !adminUrl) {
    console.error('DIRECT_URL, DATABASE_URL and ADMIN_DATABASE_URL are required (role passwords are read from the last two)');
    process.exit(1);
  }
  runMigrations({ databaseUrl: url, appPassword: passwordFromUrl(appUrl), adminPassword: passwordFromUrl(adminUrl), ssl: process.env.DB_SSL === 'require' })
    .then(() => process.exit(0))
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
