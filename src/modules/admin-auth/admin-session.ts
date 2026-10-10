import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { randomToken, sha256 } from '../../lib/crypto';
import { signAdminAccess } from '../../lib/jwt';
import type { RequestMeta } from '../../lib/request-meta';

export interface AdminProfile {
  admin: { id: string; name: string; email: string; mobile: string | null; totpEnabled: boolean; lastLoginAt: string | null };
}
export interface AdminSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshMaxAgeMs: number;
  refreshId: string;
  profile: AdminProfile;
}

export async function loadAdminProfile(tx: Tx, adminId: string): Promise<AdminProfile> {
  const a = await one<{
    id: string; name: string; email: string; mobile: string | null; totp_enabled: boolean; last_login_at: string | null;
  }>(tx, 'SELECT id, name, email, mobile, totp_enabled, last_login_at FROM app.super_admins WHERE id = $1', [adminId]);
  return {
    admin: { id: a.id, name: a.name, email: a.email, mobile: a.mobile, totpEnabled: a.totp_enabled, lastLoginAt: a.last_login_at },
  };
}

export async function issueAdminSession(
  tx: Tx,
  adminId: string,
  meta: RequestMeta,
  familyId: string = randomUUID(),
): Promise<AdminSession> {
  const { token_version } = await one<{ token_version: number }>(
    tx, 'SELECT token_version FROM app.super_admins WHERE id = $1', [adminId]);
  const refreshToken = randomToken();
  const ttlSec = env.REFRESH_TTL_HOURS_ADMIN * 3600;
  const { id } = await one<{ id: string }>(
    tx,
    `INSERT INTO app.super_admin_refresh_tokens (super_admin_id, family_id, token_hash, device, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) RETURNING id`,
    [adminId, familyId, sha256(refreshToken), meta.userAgent, meta.ip, ttlSec],
  );
  return {
    accessToken: signAdminAccess({ sub: adminId, ver: token_version }),
    expiresIn: env.ACCESS_TOKEN_TTL_SEC,
    refreshToken,
    refreshMaxAgeMs: ttlSec * 1000,
    refreshId: id,
    profile: await loadAdminProfile(tx, adminId),
  };
}
