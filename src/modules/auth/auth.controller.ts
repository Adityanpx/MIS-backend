import type { Request, Response } from 'express';
import { CLIENT_REFRESH_COOKIE, CLIENT_REFRESH_PATH } from '../../config/constants';
import { clearRefreshCookie, setRefreshCookie } from '../../lib/cookies';
import { clientCtx } from '../../lib/context';
import { unauthorized } from '../../lib/errors';
import { noContent, ok } from '../../lib/http';
import { requestMeta } from '../../lib/request-meta';
import { parseBody } from '../../lib/validate';
import {
  forgotBody, inviteAcceptBody, loginBody, mfaTokenBody, mfaVerifyBody, resetBody,
} from '../../shared/schemas/auth';
import * as svc from './auth.service';
import type { IssuedSession } from './session';

export function sendSession(res: Response, s: IssuedSession) {
  setRefreshCookie(res, CLIENT_REFRESH_COOKIE, CLIENT_REFRESH_PATH, s.refreshToken, s.refreshMaxAgeMs);
  return ok(res, { mfaRequired: false, accessToken: s.accessToken, expiresIn: s.expiresIn, ...s.profile });
}
function sendLoginResult(res: Response, r: svc.LoginResult) {
  if (r.kind === 'mfa') return ok(res, { mfaRequired: true, mfaPurpose: r.purpose, mfaToken: r.mfaToken });
  return sendSession(res, r.session);
}
function refreshCookie(req: Request): string | undefined {
  const v: unknown = (req.cookies as Record<string, unknown> | undefined)?.[CLIENT_REFRESH_COOKIE];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export async function login(req: Request, res: Response) {
  const b = parseBody(req, loginBody);
  sendLoginResult(res, await svc.login(b.email, b.password, requestMeta(req)));
}
export async function verify2fa(req: Request, res: Response) {
  const b = parseBody(req, mfaVerifyBody);
  sendSession(res, await svc.verifyMfa(b.mfaToken, b.code, requestMeta(req)));
}
export async function enrolStart(req: Request, res: Response) {
  const b = parseBody(req, mfaTokenBody);
  ok(res, await svc.startEnrolment(b.mfaToken));
}
export async function enrolConfirm(req: Request, res: Response) {
  const b = parseBody(req, mfaVerifyBody);
  sendSession(res, await svc.confirmEnrolment(b.mfaToken, b.code, requestMeta(req)));
}
export async function refresh(req: Request, res: Response) {
  const raw = refreshCookie(req);
  if (!raw) throw unauthorized('UNAUTHENTICATED', 'Please sign in.');
  try {
    sendSession(res, await svc.refreshSession(raw, requestMeta(req)));
  } catch (err) {
    clearRefreshCookie(res, CLIENT_REFRESH_COOKIE, CLIENT_REFRESH_PATH);
    throw err;
  }
}
export async function logout(req: Request, res: Response) {
  await svc.logout(refreshCookie(req), requestMeta(req));
  clearRefreshCookie(res, CLIENT_REFRESH_COOKIE, CLIENT_REFRESH_PATH);
  noContent(res);
}
export async function logoutAll(req: Request, res: Response) {
  const ctx = clientCtx(req);
  await svc.logoutAll(ctx.tenantId, ctx.userId, requestMeta(req));
  clearRefreshCookie(res, CLIENT_REFRESH_COOKIE, CLIENT_REFRESH_PATH);
  noContent(res);
}
export async function forgot(req: Request, res: Response) {
  const b = parseBody(req, forgotBody);
  await svc.forgotPassword(b.email, requestMeta(req));
  ok(res, { message: 'If the email is registered, a reset link has been sent.' });
}
export async function reset(req: Request, res: Response) {
  const b = parseBody(req, resetBody);
  await svc.resetPassword(b.token, b.password, requestMeta(req));
  ok(res, { message: 'Password changed. Please sign in.' });
}
export async function acceptInvite(req: Request, res: Response) {
  const b = parseBody(req, inviteAcceptBody);
  sendLoginResult(res, await svc.acceptInvite(b.token, b.password, requestMeta(req)));
}
