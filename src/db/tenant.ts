import type { Pool, PoolClient } from 'pg';
import { adminPool, appPool, closePools } from './pools';
import { AppError } from '../lib/errors';

export type Tx = PoolClient;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantTxCtx {
  tenantId: string;
  actorId: string | null;
}
export interface AdminTxCtx {
  adminId: string;
}

async function runInTransaction<T>(pool: Pool, settings: Record<string, string>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keys = Object.keys(settings);
    if (keys.length > 0) {
      // set_config(..., true) = LOCAL to this transaction: a pooled connection can never carry it to the next request.
      const calls = keys.map((_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`).join(', ');
      await client.query(`SELECT ${calls}`, keys.flatMap((k) => [k, settings[k] ?? '']));
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken; release below */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Client-user work: app_user pool, RLS limited to ctx.tenantId. */
export function withTenant<T>(ctx: TenantTxCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(ctx.tenantId)) throw new AppError('INTERNAL_ERROR', 500, 'Invalid tenant context');
  return runInTransaction(appPool, { 'app.tenant_id': ctx.tenantId, 'app.actor_id': ctx.actorId ?? '' }, fn);
}
/** Super Admin requests: admin_user pool (all tenants). Route code must still filter explicitly. */
export function withAdmin<T>(ctx: AdminTxCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runInTransaction(adminPool, { 'app.actor_id': ctx.adminId }, fn);
}
/** Background jobs, webhooks, seeds: admin_user pool, no actor. */
export function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runInTransaction(adminPool, {}, fn);
}
/** Login-time lookups: app_user WITHOUT a tenant → only SECURITY DEFINER app.auth_* functions return data. */
export function withAuthLookup<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runInTransaction(appPool, {}, fn);
}

export async function pingDb(): Promise<void> {
  await withAuthLookup((tx) => tx.query('SELECT 1'));
  await withSystem((tx) => tx.query('SELECT 1'));
}
export const closeDb = closePools;
