import type { Request, Response } from 'express';
import { z } from 'zod';
import { isUniqueViolation } from '../../../db/errors';
import { withAdmin } from '../../../db/tenant';
import { adminTx } from '../../../lib/context';
import { conflict } from '../../../lib/errors';
import { created, noContent, ok } from '../../../lib/http';
import { pageMeta, paginationQuery } from '../../../lib/pagination';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams, parseQuery } from '../../../lib/validate';
import { invalidateClientAuthCache } from '../../../middleware/auth-client';
import { USER_STATUSES } from '../../../shared/enums';
import { clientCreateBody, clientListQuery, clientPatchBody } from '../../../shared/schemas/admin';
import { idParam, uuid } from '../../../shared/schemas/common';
import { adminActor } from '../../audit/audit.service';
import { detectFile } from '../../files/upload';
import { sendInBackground } from '../../notifications/email.service';
import * as users from '../../users/users.service';
import * as svc from './clients.service';

const userParams = z.object({ id: uuid, userId: uuid });
const usersQuery = paginationQuery.extend({ status: z.enum(USER_STATUSES).optional() });
const adminUserPatch = z.object({ isClientAdmin: z.boolean() }).strict();

export async function list(req: Request, res: Response) {
  const q = parseQuery(req, clientListQuery);
  const r = await svc.listClients(adminTx(req), q);
  ok(res, r.items, pageMeta(q, r.total));
}
export const get = async (req: Request, res: Response) =>
  ok(res, await svc.getClient(adminTx(req), parseParams(req, idParam).id));
export const create = async (req: Request, res: Response) =>
  created(res, await svc.createClient(adminTx(req), parseBody(req, clientCreateBody), requestMeta(req)));
export const update = async (req: Request, res: Response) =>
  ok(res, await svc.updateClient(adminTx(req), parseParams(req, idParam).id, parseBody(req, clientPatchBody), requestMeta(req)));
export async function uploadLogo(req: Request, res: Response) {
  const { id } = parseParams(req, idParam);
  const file = await detectFile(req.file, ['png', 'jpg', 'svg']);
  ok(res, await svc.setClientLogo(adminTx(req), id, file, requestMeta(req)));
}

// ---- client users tab (CL-07): every query is filtered by the client id from the path ----
export async function listUsers(req: Request, res: Response) {
  const { id } = parseParams(req, idParam);
  const q = parseQuery(req, usersQuery);
  const r = await withAdmin(adminTx(req), async (tx) => {
    await svc.loadClient(tx, id);
    return users.listUsers(tx, id, q);
  });
  ok(res, r.items, pageMeta(q, r.total));
}
export async function updateUser(req: Request, res: Response) {
  const { id, userId } = parseParams(req, userParams);
  const body = parseBody(req, adminUserPatch);
  const ctx = adminTx(req);
  const dto = await withAdmin(ctx, async (tx) => {
    await svc.loadClient(tx, id);
    return users.updateUser(tx, id, userId, body, adminActor(ctx.adminId, id), requestMeta(req));
  });
  invalidateClientAuthCache(userId);
  ok(res, dto);
}
function userStatus(action: 'disable' | 'enable') {
  return async (req: Request, res: Response) => {
    const { id, userId } = parseParams(req, userParams);
    const ctx = adminTx(req);
    const dto = await withAdmin(ctx, async (tx) => {
      await svc.loadClient(tx, id);
      return users.setUserStatus(tx, id, userId, action, adminActor(ctx.adminId, id), requestMeta(req));
    });
    invalidateClientAuthCache(userId);
    ok(res, dto);
  };
}
export const disableUser = userStatus('disable');
export const enableUser = userStatus('enable');
export async function resendInvite(req: Request, res: Response) {
  const { id, userId } = parseParams(req, userParams);
  const ctx = adminTx(req);
  const outboxId = await withAdmin(ctx, async (tx) => {
    await svc.loadClient(tx, id);
    return users.resendInvite(tx, id, userId, adminActor(ctx.adminId, id), requestMeta(req));
  });
  sendInBackground([outboxId]);
  noContent(res);
}
export async function resetPassword(req: Request, res: Response) {
  const { id, userId } = parseParams(req, userParams);
  const ctx = adminTx(req);
  const outboxId = await withAdmin(ctx, async (tx) => {
    await svc.loadClient(tx, id);
    return users.sendPasswordReset(tx, id, userId, adminActor(ctx.adminId, id), requestMeta(req));
  });
  sendInBackground([outboxId]);
  noContent(res);
}
/** Not used by the Super Admin panel in Phase 1, kept for parity with the client side (invite extra admins). */
export async function inviteUser(req: Request, res: Response) {
  const { id } = parseParams(req, idParam);
  const body = parseBody(req, z.object({
    name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email(),
    mobile: z.string().trim().optional(), designation: z.string().trim().max(100).optional(),
  }).strict());
  const ctx = adminTx(req);
  try {
    const r = await withAdmin(ctx, async (tx) => {
      await svc.loadClient(tx, id);
      return users.inviteUser(tx, id, { ...body, isClientAdmin: true, plantRoles: [] }, adminActor(ctx.adminId, id), requestMeta(req));
    });
    sendInBackground([r.outboxId]);
    created(res, r.user);
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_uq')) throw conflict('EMAIL_IN_USE', 'This email address is already registered.');
    throw err;
  }
}
