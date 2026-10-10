import { exec, maybeOne, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { LOCKOUT_ATTEMPTS, LOCKOUT_MINUTES } from '../../config/constants';

export interface LoginLookupRow {
  id: string; tenant_id: string; name: string; email: string; password_hash: string | null; status: string;
  is_client_admin: boolean; totp_enabled: boolean; failed_logins: number; locked_until: string | null;
  token_version: number; client_status: string; client_account_state: string; client_force_2fa: boolean;
}

// ---------- login-time lookups (run inside withAuthLookup: SECURITY DEFINER functions) ----------
export const findLoginUser = (tx: Tx, email: string) =>
  maybeOne<LoginLookupRow>(
    tx,
    `SELECT id, tenant_id, name, email, password_hash, status, is_client_admin, totp_enabled, failed_logins,
            locked_until, token_version, client_status, client_account_state, client_force_2fa
       FROM app.auth_find_user_by_email($1)`,
    [email],
  );
export const findRefreshByHash = (tx: Tx, hash: string) =>
  maybeOne<{ id: string; tenant_id: string; user_id: string; family_id: string }>(
    tx, 'SELECT id, tenant_id, user_id, family_id FROM app.auth_find_refresh($1)', [hash]);
export const findUserTokenByHash = (tx: Tx, hash: string, purpose: 'invite' | 'reset') =>
  maybeOne<{ id: string; tenant_id: string; user_id: string; expires_at: string; used_at: string | null }>(
    tx, 'SELECT id, tenant_id, user_id, expires_at, used_at FROM app.auth_find_token($1, $2)', [hash, purpose]);

// ---------- tenant-scoped (run inside withTenant) ----------
export const isLocked = (lockedUntil: string | null) => !!lockedUntil && Date.parse(lockedUntil) > Date.now();

/** Counts a failure. An expired lock restarts the count at 1. Locks for LOCKOUT_MINUTES at LOCKOUT_ATTEMPTS. */
export const registerLoginFailure = (tx: Tx, tenantId: string, userId: string) =>
  one<{ failed_logins: number; locked_until: string | null }>(
    tx,
    `UPDATE app.users SET
        failed_logins = CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_logins + 1 END,
        locked_until  = CASE
          WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_logins + 1 END) >= $3
          THEN now() + make_interval(mins => $4)
          ELSE NULL END
      WHERE tenant_id = $1 AND id = $2
      RETURNING failed_logins, locked_until`,
    [tenantId, userId, LOCKOUT_ATTEMPTS, LOCKOUT_MINUTES],
  );
export const markLoginSuccess = (tx: Tx, tenantId: string, userId: string) =>
  exec(
    tx,
    `UPDATE app.users SET failed_logins = 0, locked_until = NULL, last_login_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, userId],
  );

export async function insertRefreshToken(
  tx: Tx,
  p: { tenantId: string; userId: string; familyId: string; tokenHash: string; device: string; ip: string | null; ttlSec: number },
): Promise<string> {
  const r = await one<{ id: string }>(
    tx,
    `INSERT INTO app.refresh_tokens (tenant_id, user_id, family_id, token_hash, device, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) RETURNING id`,
    [p.tenantId, p.userId, p.familyId, p.tokenHash, p.device, p.ip, p.ttlSec],
  );
  return r.id;
}
export const revokeRefreshToken = (tx: Tx, tenantId: string, id: string, replacedBy: string | null = null) =>
  exec(
    tx,
    `UPDATE app.refresh_tokens SET revoked_at = coalesce(revoked_at, now()), replaced_by = coalesce(replaced_by, $3)
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, replacedBy],
  );
export const revokeRefreshFamily = (tx: Tx, tenantId: string, familyId: string) =>
  exec(
    tx,
    'UPDATE app.refresh_tokens SET revoked_at = now() WHERE tenant_id = $1 AND family_id = $2 AND revoked_at IS NULL',
    [tenantId, familyId],
  );
export const revokeAllRefreshTokens = (tx: Tx, tenantId: string, userId: string) =>
  exec(
    tx,
    'UPDATE app.refresh_tokens SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [tenantId, userId],
  );
export const bumpTokenVersion = (tx: Tx, tenantId: string, userId: string) =>
  one<{ token_version: number }>(
    tx,
    'UPDATE app.users SET token_version = token_version + 1 WHERE tenant_id = $1 AND id = $2 RETURNING token_version',
    [tenantId, userId],
  );
