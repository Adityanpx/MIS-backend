import { Router, type Request } from 'express';
import { z } from 'zod';
import { maybeOne, one } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { enqueue } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { clientCtx, tenantTx } from '../../lib/context';
import { daysInclusive } from '../../lib/dates';
import { badRequest, notFound } from '../../lib/errors';
import { asyncHandler, ok } from '../../lib/http';
import { requestMeta } from '../../lib/request-meta';
import { parseBody, parseParams } from '../../lib/validate';
import { accountState } from '../../middleware/account-state';
import { plantAccess } from '../../middleware/plant-access';
import { idParam, isoDate } from '../../shared/schemas/common';
import { clientActor, writeAudit } from '../audit/audit.service';
import { assertTenantKey, storage } from '../files/storage';

export const plantExportsRouter = Router({ mergeParams: true });
plantExportsRouter.post('/logsheets', plantAccess(['editor', 'checker', 'verifier']), accountState('billing'), asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const plant = (req as Request).plant!;
  const b = parseBody(req, z.object({ from: isoDate, to: isoDate }).strict());
  if (b.from > b.to || daysInclusive(b.from, b.to) > 5480) throw badRequest('INVALID_RANGE', 'Invalid date range.');
  const r = await withTenant(tenantTx(ctx), async (tx) => {
    const row = await one<{ id: string }>(tx, `INSERT INTO app.exports (tenant_id, scope, status, created_by) VALUES ($1, $2::jsonb, 'building', $3) RETURNING id`,
      [ctx.tenantId, JSON.stringify({ type: 'logsheets', plantId: plant.id, ...b }), ctx.userId]);
    await writeAudit(tx, clientActor(ctx), { action: 'export.request', entity: 'export', entityId: row.id, after: b }, requestMeta(req));
    return row;
  });
  await enqueue(QUEUES.exportLogsheets, { tenantId: ctx.tenantId, plantId: plant.id, ...b, exportId: r.id, userId: ctx.userId });
  res.status(202).json({ data: { exportId: r.id } });
}));

export const exportsRouter = Router();
async function loadExport(req: Request) {
  const ctx = clientCtx(req);
  const { id } = parseParams(req, idParam);
  const e = await withTenant(tenantTx(ctx), (tx) => maybeOne<{ id: string; scope: { plantId?: string }; status: string; file_key: string | null;
    expires_at: string | null; created_by: string | null; error: string | null; created_at: string }>(tx,
    'SELECT id, scope, status, file_key, expires_at, created_by, error, created_at FROM app.exports WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]));
  if (!e || (!ctx.isClientAdmin && e.created_by !== ctx.userId)) throw notFound('Export');
  if (e.scope.plantId && !ctx.isClientAdmin && !ctx.plantRoles[e.scope.plantId]) throw notFound('Export');
  return e;
}
exportsRouter.get('/:id', asyncHandler(async (req, res) => {
  const e = await loadExport(req);
  ok(res, { id: e.id, scope: e.scope, status: e.status, expiresAt: e.expires_at, error: e.error, createdAt: e.created_at });
}));
exportsRouter.get('/:id/download', asyncHandler(async (req, res) => {
  const e = await loadExport(req);
  if (e.status !== 'ready' || !e.file_key || (e.expires_at && Date.parse(e.expires_at) < Date.now())) throw notFound('Export file');
  assertTenantKey(e.file_key, clientCtx(req).tenantId);
  ok(res, { url: await storage.signedUrl(e.file_key, { downloadName: e.file_key.split('/').pop() }) });
}));
