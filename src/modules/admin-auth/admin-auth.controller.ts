import type { Request, Response } from 'express';
import { ADMIN_REFRESH_COOKIE, ADMIN_REFRESH_PATH } from '../../config/constants';
import { clearRefreshCookie, setRefreshCookie } from '../../lib/cookies';
import { adminTx } from '../../lib/context';
import { unauthorized } from '../../lib/errors';
import { noContent, ok } from '../../lib/http';
import { requestMeta } from '../../lib/request-meta';
import { parseBody } from '../../lib/validate';
import { adminMePatchBody } from '../../shared/schemas/admin';
import {
  changePasswordBody, forgotBody, inviteAcceptBody, loginBody, mfaTokenBody, mfaVerifyBody, resetBody,
} from '../../shared/schemas/auth';
import * as svc from './admin-auth.service';
import type { AdminSession } from './admin-session';

function sendSession(res: Response, s: AdminSession) {
  setRefreshCookie(res, ADMIN_REFRESH_COOKIE, ADMIN_REFRESH_PATH, s.refreshToken, s.refreshMaxAgeMs);
  return ok(res, { mfaRequired: false, accessToken: s.accessToken, expiresIn: s.expiresIn, ...s.profile });
}
function cookie(req: Request): string | undefined {
  const v: unknown = (req.cookies as Record<string, unknown> | undefined)?.[ADMIN_REFRESH_COOKIE];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
const sendMfa = (res: Response, r: svc.AdminLoginResult) =>
  // devCode: TEMP TESTING (remove before go-live) — see AdminLoginResult.
  ok(res, { mfaRequired: true, mfaPurpose: r.purpose, mfaToken: r.mfaToken, ...(r.devCode ? { devCode: r.devCode } : {}) });

export async function login(req: Request, res: Response) {
  const b = parseBody(req, loginBody);
  sendMfa(res, await svc.adminLogin(b.email, b.password, requestMeta(req)));
}
export async function verify2fa(req: Request, res: Response) {
  const b = parseBody(req, mfaVerifyBody);
  sendSession(res, await svc.adminVerifyMfa(b.mfaToken, b.code, requestMeta(req)));
}
export async function enrolStart(req: Request, res: Response) {
  ok(res, await svc.adminEnrolStart(parseBody(req, mfaTokenBody).mfaToken));
}
export async function enrolConfirm(req: Request, res: Response) {
  const b = parseBody(req, mfaVerifyBody);
  sendSession(res, await svc.adminEnrolConfirm(b.mfaToken, b.code, requestMeta(req)));
}
export async function refresh(req: Request, res: Response) {
  const raw = cookie(req);
  if (!raw) throw unauthorized('UNAUTHENTICATED', 'Please sign in.');
  try {
    sendSession(res, await svc.adminRefresh(raw, requestMeta(req)));
  } catch (err) {
    clearRefreshCookie(res, ADMIN_REFRESH_COOKIE, ADMIN_REFRESH_PATH);
    throw err;
  }
}
export async function logout(req: Request, res: Response) {
  await svc.adminLogout(cookie(req), requestMeta(req));
  clearRefreshCookie(res, ADMIN_REFRESH_COOKIE, ADMIN_REFRESH_PATH);
  noContent(res);
}
export async function logoutAll(req: Request, res: Response) {
  await svc.adminLogoutAll(adminTx(req).adminId, requestMeta(req));
  clearRefreshCookie(res, ADMIN_REFRESH_COOKIE, ADMIN_REFRESH_PATH);
  noContent(res);
}
export async function forgot(req: Request, res: Response) {
  await svc.adminForgot(parseBody(req, forgotBody).email, requestMeta(req));
  ok(res, { message: 'If the email is registered, a reset link has been sent.' });
}
export async function reset(req: Request, res: Response) {
  const b = parseBody(req, resetBody);
  await svc.adminReset(b.token, b.password, requestMeta(req));
  ok(res, { message: 'Password changed. Please sign in.' });
}
export async function acceptInvite(req: Request, res: Response) {
  const b = parseBody(req, inviteAcceptBody);
  sendMfa(res, await svc.adminAcceptInvite(b.token, b.password, requestMeta(req)));
}
export async function getMe(req: Request, res: Response) {
  ok(res, await svc.getAdminMe(adminTx(req).adminId));
}
export async function patchMe(req: Request, res: Response) {
  ok(res, await svc.updateAdminMe(adminTx(req).adminId, parseBody(req, adminMePatchBody), requestMeta(req)));
}
export async function changePassword(req: Request, res: Response) {
  const b = parseBody(req, changePasswordBody);
  sendSession(res, await svc.changeAdminPassword(adminTx(req).adminId, b.currentPassword, b.newPassword, requestMeta(req)));
}
