import type { Request, Response } from 'express';
import { adminTx } from '../../../lib/context';
import { created, noContent, ok } from '../../../lib/http';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams } from '../../../lib/validate';
import { superAdminCreateBody, superAdminPatchBody } from '../../../shared/schemas/admin';
import { idParam } from '../../../shared/schemas/common';
import * as svc from './super-admins.service';

export const list = async (req: Request, res: Response) => ok(res, await svc.listSuperAdmins(adminTx(req)));
export const create = async (req: Request, res: Response) =>
  created(res, await svc.createSuperAdmin(adminTx(req), parseBody(req, superAdminCreateBody), requestMeta(req)));
export const update = async (req: Request, res: Response) =>
  ok(res, await svc.updateSuperAdmin(adminTx(req), parseParams(req, idParam).id, parseBody(req, superAdminPatchBody), requestMeta(req)));
export const disable = async (req: Request, res: Response) =>
  ok(res, await svc.setSuperAdminStatus(adminTx(req), parseParams(req, idParam).id, 'disable', requestMeta(req)));
export const enable = async (req: Request, res: Response) =>
  ok(res, await svc.setSuperAdminStatus(adminTx(req), parseParams(req, idParam).id, 'enable', requestMeta(req)));
export const resendInvite = async (req: Request, res: Response) => {
  await svc.resendSuperAdminInvite(adminTx(req), parseParams(req, idParam).id, requestMeta(req));
  noContent(res);
};
export const resetPassword = async (req: Request, res: Response) => {
  await svc.sendSuperAdminReset(adminTx(req), parseParams(req, idParam).id, requestMeta(req));
  noContent(res);
};
export const reset2fa = async (req: Request, res: Response) =>
  ok(res, await svc.resetSuperAdmin2fa(adminTx(req), parseParams(req, idParam).id, requestMeta(req)));
