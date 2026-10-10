import type { Request, Response } from 'express';
import { clientCtx } from '../../lib/context';
import { noContent, ok } from '../../lib/http';
import { requestMeta } from '../../lib/request-meta';
import { parseBody } from '../../lib/validate';
import { changePasswordBody, codeBody, mePatchBody } from '../../shared/schemas/auth';
import { sendSession } from './auth.controller';
import * as svc from './me.service';

export async function getMe(req: Request, res: Response) {
  ok(res, await svc.getMe(clientCtx(req)));
}
export async function patchMe(req: Request, res: Response) {
  ok(res, await svc.updateMe(clientCtx(req), parseBody(req, mePatchBody), requestMeta(req)));
}
export async function changePassword(req: Request, res: Response) {
  const b = parseBody(req, changePasswordBody);
  sendSession(res, await svc.changePassword(clientCtx(req), b.currentPassword, b.newPassword, requestMeta(req)));
}
export async function setup2fa(req: Request, res: Response) {
  ok(res, await svc.setupTotp(clientCtx(req)));
}
export async function enable2fa(req: Request, res: Response) {
  await svc.enableTotp(clientCtx(req), parseBody(req, codeBody).code, requestMeta(req));
  noContent(res);
}
export async function disable2fa(req: Request, res: Response) {
  await svc.disableTotp(clientCtx(req), parseBody(req, codeBody).code, requestMeta(req));
  noContent(res);
}
export async function acceptTerms(req: Request, res: Response) {
  ok(res, await svc.acceptTerms(clientCtx(req), requestMeta(req)));
}
