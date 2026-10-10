import type { RequestHandler } from 'express';
import { AUTH_CACHE_TTL_MS } from '../config/constants';
import { env } from '../config/env';
import { maybeOne } from '../db/sql';
import { withSystem } from '../db/tenant';
import { forbidden, unauthorized } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { verifyAdminAccess } from '../lib/jwt';
import { bearer } from './auth-client';

const cache = new Map<string, number>();
export function invalidateAdminAuthCache(adminId?: string): void {
  if (!adminId) return cache.clear();
  for (const key of cache.keys()) if (key.startsWith(`${adminId}:`)) cache.delete(key);
}

/** Optional IP allow-list for the WHOLE Super Admin API, including the login endpoints. */
export const adminIpGuard: RequestHandler = (req, _res, next) => {
  if (env.ADMIN_IP_ALLOWLIST.length > 0 && !env.ADMIN_IP_ALLOWLIST.includes(req.ip ?? '')) {
    return next(forbidden('IP_NOT_ALLOWED', 'Access from this network is not allowed.'));
  }
  next();
};

export const authAdmin: RequestHandler = asyncHandler(async (req, _res, next) => {
  const claims = verifyAdminAccess(bearer(req.header('authorization')));
  const key = `${claims.sub}:${claims.ver}`;
  const at = cache.get(key);
  if (!at || Date.now() - at >= AUTH_CACHE_TTL_MS) {
    const row = await withSystem((tx) =>
      maybeOne<{ status: string; token_version: number }>(
        tx, 'SELECT status, token_version FROM app.super_admins WHERE id = $1', [claims.sub]),
    );
    if (!row || row.status !== 'active' || row.token_version !== claims.ver) {
      throw unauthorized('TOKEN_REVOKED', 'Your session is no longer valid. Please sign in again.');
    }
    if (cache.size > 1000) cache.clear();
    cache.set(key, Date.now());
  }
  req.adminCtx = { adminId: claims.sub };
  next();
});
