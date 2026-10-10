import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { many, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { randomToken, sha256 } from '../../lib/crypto';
import { signClientAccess } from '../../lib/jwt';
import type { RequestMeta } from '../../lib/request-meta';
import type { PlantRole } from '../../shared/enums';
import { signedUrlOrNull } from '../files/storage';
import { currentTermsVersion } from '../platform/settings.service';
import { insertRefreshToken } from './auth.repo';

export interface PlantAccessDto {
  plantId: string; code: string; name: string; role: PlantRole | 'client_admin';
  setupStatus: string; accountState: string;
}
export interface SessionProfile {
  user: {
    id: string; name: string; email: string; mobile: string | null; designation: string | null;
    isClientAdmin: boolean; totpEnabled: boolean;
  };
  tenant: { id: string; code: string; displayName: string; accountState: string; force2fa: boolean; logoUrl: string | null };
  plants: PlantAccessDto[];
  mustAcceptTerms: boolean;
  termsVersion: string;
  actingAs: { adminId: string; mode: 'view' | 'edit' } | null;
}
export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshMaxAgeMs: number;
  refreshId: string;
  profile: SessionProfile;
}

export async function loadProfile(
  tx: Tx,
  tenantId: string,
  userId: string,
  actingAs: SessionProfile['actingAs'] = null,
): Promise<SessionProfile> {
  const u = await one<{
    id: string; name: string; email: string; mobile: string | null; designation: string | null;
    is_client_admin: boolean; totp_enabled: boolean; code: string; display_name: string;
    account_state: string; force_2fa: boolean; logo_key: string | null; terms_version: string | null;
  }>(
    tx,
    `SELECT u.id, u.name, u.email, u.mobile, u.designation, u.is_client_admin, u.totp_enabled,
            c.code, c.display_name, c.account_state, c.force_2fa, c.logo_key, c.terms_version
       FROM app.users u JOIN app.clients c ON c.id = u.tenant_id
      WHERE u.tenant_id = $1 AND u.id = $2`,
    [tenantId, userId],
  );
  const plants = u.is_client_admin
    ? await many<{ id: string; code: string; name: string; setup_status: string; account_state: string; role: string }>(
        tx,
        `SELECT p.id, p.code, p.name, p.setup_status, p.account_state, 'client_admin' AS role
           FROM app.plants p WHERE p.tenant_id = $1 ORDER BY p.name`,
        [tenantId],
      )
    : await many<{ id: string; code: string; name: string; setup_status: string; account_state: string; role: string }>(
        tx,
        `SELECT p.id, p.code, p.name, p.setup_status, p.account_state, r.role
           FROM app.user_plant_roles r
           JOIN app.plants p ON p.tenant_id = r.tenant_id AND p.id = r.plant_id
          WHERE r.tenant_id = $1 AND r.user_id = $2 ORDER BY p.name`,
        [tenantId, userId],
      );
  const termsVersion = await currentTermsVersion();
  return {
    user: {
      id: u.id, name: u.name, email: u.email, mobile: u.mobile, designation: u.designation,
      isClientAdmin: u.is_client_admin, totpEnabled: u.totp_enabled,
    },
    tenant: {
      id: tenantId, code: u.code, displayName: u.display_name, accountState: u.account_state,
      force2fa: u.force_2fa, logoUrl: await signedUrlOrNull(u.logo_key),
    },
    plants: plants.map((p) => ({
      plantId: p.id, code: p.code, name: p.name, role: p.role as PlantAccessDto['role'],
      setupStatus: p.setup_status, accountState: p.account_state,
    })),
    mustAcceptTerms: u.is_client_admin && !!termsVersion && u.terms_version !== termsVersion,
    termsVersion,
    actingAs,
  };
}

/** Creates a refresh token row (new or existing family) and a matching access token. Call inside withTenant. */
export async function issueSession(
  tx: Tx,
  tenantId: string,
  userId: string,
  meta: RequestMeta,
  familyId: string = randomUUID(),
): Promise<IssuedSession> {
  const { token_version } = await one<{ token_version: number }>(
    tx, 'SELECT token_version FROM app.users WHERE tenant_id = $1 AND id = $2', [tenantId, userId]);
  const refreshToken = randomToken();
  const ttlSec = env.REFRESH_TTL_DAYS_CLIENT * 86_400;
  const refreshId = await insertRefreshToken(tx, {
    tenantId, userId, familyId, tokenHash: sha256(refreshToken), device: meta.userAgent, ip: meta.ip, ttlSec,
  });
  return {
    accessToken: signClientAccess({ sub: userId, tid: tenantId, ver: token_version }),
    expiresIn: env.ACCESS_TOKEN_TTL_SEC,
    refreshToken,
    refreshMaxAgeMs: ttlSec * 1000,
    refreshId,
    profile: await loadProfile(tx, tenantId, userId),
  };
}
