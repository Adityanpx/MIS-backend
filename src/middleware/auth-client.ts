import type { RequestHandler } from 'express';
import { ACT_AS_SESSION_MINUTES, AUTH_CACHE_TTL_MS } from '../config/constants';
import { many, maybeOne } from '../db/sql';
import { withTenant } from '../db/tenant';
import { forbidden, unauthorized } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { verifyClientAccess } from '../lib/jwt';
import type { PlantRole } from '../shared/enums';
import type { ClientCtx } from '../types/express';

const cache = new Map<string, { at: number; ctx: ClientCtx }>();

/** Call after changing a user's roles, admin flag, status or token version (single-instance cache). */
export function invalidateClientAuthCache(userId?: string): void {
  if (!userId) return cache.clear();
  for (const key of cache.keys()) if (key.startsWith(`${userId}:`)) cache.delete(key);
}

export function bearer(header: string | undefined): string {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m?.[1]) throw unauthorized();
  return m[1];
}

export const authClient: RequestHandler = asyncHandler(async (req, _res, next) => {
  const claims = verifyClientAccess(bearer(req.header('authorization')));
  const key = `${claims.sub}:${claims.ver}:${claims.act ?? ''}:${claims.mode ?? ''}`;
  const hit = cache.get(key);
  let ctx: ClientCtx;
  if (hit && Date.now() - hit.at < AUTH_CACHE_TTL_MS) {
    ctx = hit.ctx;
  } else {
    ctx = await withTenant({ tenantId: claims.tid, actorId: claims.sub }, async (tx) => {
      const u = await maybeOne<{
        status: string; token_version: number; is_client_admin: boolean; is_management: boolean;
        client_status: string; account_state: string; terms_version: string | null;
      }>(
        tx,
        `SELECT u.status, u.token_version, u.is_client_admin, u.is_management,
                c.status AS client_status, c.account_state, c.terms_version
           FROM app.users u JOIN app.clients c ON c.id = u.tenant_id
          WHERE u.tenant_id = $1 AND u.id = $2`,
        [claims.tid, claims.sub],
      );
      if (!u || u.status !== 'active' || u.client_status === 'deleted' || u.token_version !== claims.ver) {
        throw unauthorized('TOKEN_REVOKED', 'Your session is no longer valid. Please sign in again.');
      }
      if (claims.act) {
        const s = await maybeOne(
          tx,
          `SELECT 1 FROM app.act_as_sessions
            WHERE tenant_id = $1 AND super_admin_id = $2 AND ended_at IS NULL AND code_used_at IS NOT NULL
              AND started_at > now() - make_interval(mins => $3)`,
          [claims.tid, claims.act, ACT_AS_SESSION_MINUTES],
        );
        if (!s) throw unauthorized('ACT_AS_ENDED', 'This support session has ended.');
      }
      const roles = await many<{ plant_id: string; role: PlantRole }>(
        tx,
        'SELECT plant_id, role FROM app.user_plant_roles WHERE tenant_id = $1 AND user_id = $2',
        [claims.tid, claims.sub],
      );
      return {
        tenantId: claims.tid,
        userId: claims.sub,
        isClientAdmin: u.is_client_admin,
        isManagement: u.is_management,
        plantRoles: Object.fromEntries(roles.map((r) => [r.plant_id, r.role])),
        tenantAccountState: u.account_state,
        tenantTermsVersion: u.terms_version,
        actingAsAdminId: claims.act,
        actAsMode: claims.mode,
      } satisfies ClientCtx;
    });
    if (cache.size > 5000) cache.clear();
    cache.set(key, { at: Date.now(), ctx });
  }
  if (ctx.actAsMode === 'view' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    throw forbidden('ACT_AS_READ_ONLY', 'This support session is read-only.');
  }
  req.ctx = ctx;
  next();
});
