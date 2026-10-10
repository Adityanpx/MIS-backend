import type { Response } from 'express';
import { env } from '../config/env';

export function setRefreshCookie(res: Response, name: string, path: string, token: string, maxAgeMs: number) {
  res.cookie(name, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path,
    domain: env.COOKIE_DOMAIN,
    maxAge: maxAgeMs,
  });
}
export function clearRefreshCookie(res: Response, name: string, path: string) {
  res.clearCookie(name, {
    httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAMESITE, path, domain: env.COOKIE_DOMAIN,
  });
}
