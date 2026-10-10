import type { Request } from 'express';
import { maybeOne } from '../db/sql';
import { withSystem } from '../db/tenant';
import { badRequest } from './errors';

/** Runs `fn` once per (scope, Idempotency-Key). Without the header it simply runs `fn`. */
export async function idempotent<T>(req: Request, scope: string, fn: () => Promise<T>): Promise<T> {
  const key = req.header('idempotency-key');
  if (!key) return fn();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8–100 letters, digits, - or _.');
  const hit = await withSystem((tx) => maybeOne<{ response: T }>(tx, 'SELECT response FROM app.idempotency_keys WHERE scope = $1 AND key = $2', [scope, key]));
  if (hit) return hit.response;
  const result = await fn();
  await withSystem((tx) => tx.query(
    'INSERT INTO app.idempotency_keys (scope, key, response) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING',
    [scope, key, JSON.stringify(result)],
  ));
  return result;
}
