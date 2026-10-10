import { Pool, types } from 'pg';
import { env } from '../config/env';
import { logger } from '../lib/logger';

types.setTypeParser(1082, (v) => v); // DATE    → 'YYYY-MM-DD' (no time-zone shifting)
types.setTypeParser(1700, (v) => v); // NUMERIC → string (exact; convert with Number()/Decimal where used)
types.setTypeParser(20, (v) => Number(v)); // INT8 → number (counts, bigserial ids; safe for our ranges)
// Capture pg's original parser once per process: this module can be evaluated several times (tests), and wrapping our own wrapper would break it.
const g = globalThis as { __pgTimestamptzParser?: (v: string) => unknown };
const parseTimestamptz = (g.__pgTimestamptzParser ??= types.getTypeParser(1184) as (v: string) => unknown);
types.setTypeParser(1184, (v) => (parseTimestamptz(v) as Date).toISOString()); // TIMESTAMPTZ → ISO-8601 UTC string

function sslConfig() {
  if (env.DB_SSL !== 'require') return undefined;
  return env.DB_SSL_CA ? { ca: env.DB_SSL_CA, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

export const appPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_APP_MAX,
  ssl: sslConfig(),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'ommis-api-app',
});
export const adminPool = new Pool({
  connectionString: env.ADMIN_DATABASE_URL,
  max: env.DB_POOL_ADMIN_MAX,
  ssl: sslConfig(),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'ommis-api-admin',
});
appPool.on('error', (err) => logger.error({ err, pool: 'app' }, 'Idle DB client error'));
adminPool.on('error', (err) => logger.error({ err, pool: 'admin' }, 'Idle DB client error'));

export async function closePools(): Promise<void> {
  await Promise.all([appPool.end(), adminPool.end()]);
}
