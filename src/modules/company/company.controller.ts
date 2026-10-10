import type { Request, Response } from 'express';
import { z } from 'zod';
import { isUniqueViolation } from '../../db/errors';
import { withTenant } from '../../db/tenant';
import { clientCtx, tenantTx } from '../../lib/context';
import { conflict } from '../../lib/errors';
import { created, noContent, ok } from '../../lib/http';
import { pageMeta, paginationQuery } from '../../lib/pagination';
import { requestMeta } from '../../lib/request-meta';
import { parseBody, parseParams, parseQuery } from '../../lib/validate';
import { invalidateClientAuthCache } from '../../middleware/auth-client';
import { USER_STATUSES } from '../../shared/enums';
import { idParam, isoDate } from '../../shared/schemas/common';
import { companyPatchBody, plantRolesPutBody, userInviteBody, userPatchBody } from '../../shared/schemas/company';
import { clientActor } from '../audit/audit.service';
import { detectFile } from '../files/upload';
import { sendInBackground } from '../notifications/email.service';
import * as users from '../users/users.service';
import * as svc from './company.service';

const usersQuery = paginationQuery.extend({ status: z.enum(USER_STATUSES).optional() });
const auditQuery = paginationQuery.extend({
  entity: z.string().trim().max(50).optional(),
  action: z.string().trim().max(80).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const getCompany = async (req: Request, res: Response) => ok(res, await svc.getCompany(clientCtx(req)));
export const patchCompany = async (req: Request, res: Response) =>
  ok(res, await svc.updateCompany(clientCtx(req), parseBody(req, companyPatchBody), requestMeta(req)));
export async function uploadLogo(req: Request, res: Response) {
  const file = await detectFile(req.file, ['png', 'jpg', 'svg']);
  ok(res, await svc.setCompanyLogo(clientCtx(req), file, requestMeta(req)));
}
export async function listAudit(req: Request, res: Response) {
  const q = parseQuery(req, auditQuery);
  const r = await svc.listAudit(clientCtx(req), q);
  ok(res, r.items, pageMeta(q, r.total));
}

// ------------------------------------------------------------ users (CA-05…08)
export async function listUsers(req: Request, res: Response) {
  const ctx = clientCtx(req);
  const q = parseQuery(req, usersQuery);
  const r = await withTenant(tenantTx(ctx), (tx) => users.listUsers(tx, ctx.tenantId, q));
  ok(res, r.items, pageMeta(q, r.total));
}
export async function getUser(req: Request, res: Response) {
  const ctx = clientCtx(req);
  const { id } = parseParams(req, idParam);
  ok(res, await withTenant(tenantTx(ctx), (tx) => users.getUser(tx, ctx.tenantId, id)));
}
export async function inviteUser(req: Request, res: Response) {
  const ctx = clientCtx(req);
  const body = parseBody(req, userInviteBody);
  try {
    const r = await withTenant(tenantTx(ctx), (tx) => users.inviteUser(tx, ctx.tenantId, body, clientActor(ctx), requestMeta(req)));
    sendInBackground([r.outboxId]);
    created(res, r.user);
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_uq')) throw conflict('EMAIL_IN_USE', 'This email address is already registered.');
    throw err;
  }
}
export async function patchUser(req: Request, res: Response) {
  const ctx = clientCtx(req);
  const { id } = parseParams(req, idParam);
  const body = parseBody(req, userPatchBody);
  const dto = await withTenant(tenantTx(ctx), (tx) => users.updateUser(tx, ctx.tenantId, id, body, clientActor(ctx), requestMeta(req)));
  invalidateClientAuthCache(id);
  ok(res, dto);
}
function setStatus(action: 'disable' | 'enable') {
  return async (req: Request, res: Response) => {
    const ctx = clientCtx(req);
    const { id } = parseParams(req, idParam);
    const dto = await withTenant(tenantTx(ctx), (tx) =>
      users.setUserStatus(tx, ctx.tenantId, id, action, clientActor(ctx), requestMeta(req), ctx.userId));
    invalidateClientAuthCache(id);
    ok(res, dto);
  };
}
export const disableUser = setStatus('disable');
export const enableUser = setStatus('enable');
export async function resendInvite(req: Request, res: Response) {
  const ctx = clientCtx(req);
  const { id } = parseParams(req, idParam);
  const outboxId = await withTenant(tenantTx(ctx), (tx) => users.resendInvite(tx, ctx.tenantId, id, clientActor(ctx), requestMeta(req)));
  sendInBackground([outboxId]);
  noContent(res);
}
export async function resetPassword(req: Request, res: Response) {
  const ctx = clientCtx(req);
  const { id } = parseParams(req, idParam);
  const outboxId = await withTenant(tenantTx(ctx), (tx) => users.sendPasswordReset(tx, ctx.tenantId, id, clientActor(ctx), requestMeta(req)));
  sendInBackground([outboxId]);
  noContent(res);
}
export async function putPlantRoles(req: Request, res: Response) {
  const ctx = clientCtx(req);
  const { id } = parseParams(req, idParam);
  const { roles } = parseBody(req, plantRolesPutBody);
  const dto = await withTenant(tenantTx(ctx), (tx) => users.setPlantRoles(tx, ctx.tenantId, id, roles, clientActor(ctx), requestMeta(req)));
  invalidateClientAuthCache(id);
  ok(res, dto);
}
