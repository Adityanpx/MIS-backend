import type { RequestHandler } from 'express';
import { withTenant } from '../db/tenant';
import { tenantTx } from '../lib/context';
import { asyncHandler } from '../lib/http';
import { requestMeta } from '../lib/request-meta';
import { clientActor, writeAudit } from '../modules/audit/audit.service';

/** Mounted right after authClient. GETs during act-as are audited here; writes are audited by the services. */
export const auditActAs: RequestHandler = asyncHandler(async (req, _res, next) => {
  const ctx = req.ctx;
  if (ctx?.actingAsAdminId && req.method === 'GET') {
    await withTenant(tenantTx(ctx), (tx) => writeAudit(tx, clientActor(ctx), {
      action: 'act_as.view', entity: 'route', entityId: (req.originalUrl.split('?')[0] ?? '').slice(0, 200),
    }, requestMeta(req)));
  }
  next();
});
