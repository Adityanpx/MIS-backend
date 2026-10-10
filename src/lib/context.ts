import type { Request } from 'express';
import type { TenantTxCtx, AdminTxCtx } from '../db/tenant';
import type { ClientCtx } from '../types/express';
import { unauthorized } from './errors';

export function clientCtx(req: Request): ClientCtx {
  if (!req.ctx) throw unauthorized();
  return req.ctx;
}
/** Transaction context for withTenant(): tenant and actor come ONLY from the verified ctx. */
export function tenantTx(ctx: ClientCtx): TenantTxCtx {
  return { tenantId: ctx.tenantId, actorId: ctx.userId };
}
export function adminTx(req: Request): AdminTxCtx {
  if (!req.adminCtx) throw unauthorized();
  return { adminId: req.adminCtx.adminId };
}
