import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { API_ISSUER, AUD_ADMIN, AUD_ADMIN_MFA, AUD_CLIENT, AUD_CLIENT_MFA, MFA_TOKEN_TTL_SEC } from '../config/constants';
import { unauthorized } from './errors';

export interface ClientAccessClaims { sub: string; tid: string; ver: number; typ: 'access'; act?: string; mode?: 'view' | 'edit' }
export interface AdminAccessClaims { sub: string; ver: number; typ: 'access'; mfa: true }
export interface MfaClaims { sub: string; typ: 'mfa'; purpose: 'verify' | 'enrol'; tid?: string }

const ALG = 'HS256' as const;

function sign(payload: object, secret: string, audience: string, expiresInSec: number): string {
  return jwt.sign(payload, secret, { algorithm: ALG, issuer: API_ISSUER, audience, expiresIn: expiresInSec });
}
function verify<T>(token: string, secret: string, audience: string): T {
  try {
    return jwt.verify(token, secret, { algorithms: [ALG], issuer: API_ISSUER, audience }) as T;
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) throw unauthorized('TOKEN_EXPIRED', 'Access token expired');
    throw unauthorized('TOKEN_INVALID', 'Invalid token');
  }
}

export const signClientAccess = (c: Omit<ClientAccessClaims, 'typ'>, ttlSec = env.ACCESS_TOKEN_TTL_SEC) =>
  sign({ ...c, typ: 'access' }, env.JWT_CLIENT_SECRET, AUD_CLIENT, ttlSec);
export function verifyClientAccess(token: string): ClientAccessClaims {
  const c = verify<ClientAccessClaims>(token, env.JWT_CLIENT_SECRET, AUD_CLIENT);
  if (c.typ !== 'access') throw unauthorized('TOKEN_INVALID', 'Invalid token');
  return c;
}
export const signAdminAccess = (c: Omit<AdminAccessClaims, 'typ' | 'mfa'>) =>
  sign({ ...c, typ: 'access', mfa: true }, env.JWT_ADMIN_SECRET, AUD_ADMIN, env.ACCESS_TOKEN_TTL_SEC);
export function verifyAdminAccess(token: string): AdminAccessClaims {
  const c = verify<AdminAccessClaims>(token, env.JWT_ADMIN_SECRET, AUD_ADMIN);
  if (c.typ !== 'access' || c.mfa !== true) throw unauthorized('TOKEN_INVALID', 'Invalid token');
  return c;
}
export const signClientMfa = (c: Omit<MfaClaims, 'typ'>) =>
  sign({ ...c, typ: 'mfa' }, env.JWT_CLIENT_SECRET, AUD_CLIENT_MFA, MFA_TOKEN_TTL_SEC);
export const verifyClientMfa = (t: string) => verify<MfaClaims>(t, env.JWT_CLIENT_SECRET, AUD_CLIENT_MFA);
export const signAdminMfa = (c: Omit<MfaClaims, 'typ'>) =>
  sign({ ...c, typ: 'mfa' }, env.JWT_ADMIN_SECRET, AUD_ADMIN_MFA, MFA_TOKEN_TTL_SEC);
export const verifyAdminMfa = (t: string) => verify<MfaClaims>(t, env.JWT_ADMIN_SECRET, AUD_ADMIN_MFA);
