import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { IMPORT_MAX_BYTES } from '../../config/constants';
import { exec, maybeOne, one } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { enqueue } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { clientCtx, tenantTx } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { asyncHandler, ok } from '../../lib/http';
import { requestMeta } from '../../lib/request-meta';
import { parseBody, parseParams } from '../../lib/validate';
import { accountState } from '../../middleware/account-state';
import { plantAccess } from '../../middleware/plant-access';
import { requireClientAdmin } from '../../middleware/require-role';
import { isoDate, uuid } from '../../shared/schemas/common';
import { clientActor, writeAudit } from '../audit/audit.service';
import { storage, tenantKey } from '../files/storage';
import { uploadSingle } from '../files/upload';

export const importsRouter = Router({ mergeParams: true });
const gate = [plantAccess([]), requireClientAdmin];
const P = (req: Request) => {
  if (!req.plant) throw notFound('Plant');
  return req.plant;
};
const idP = z.object({ plantId: uuid, id: uuid });

importsRouter.post('/', ...gate, accountState('write'), uploadSingle('file', IMPORT_MAX_BYTES), asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const plant = P(req);
  const { mapping } = parseBody(req, z.object({ mapping: z.enum(['template', 'excel_data_entry']) }));
  const f = req.file;
  // .xlsx / .xlsm are zip containers: check the magic bytes "PK"
  if (!f || f.buffer.subarray(0, 2).toString('latin1') !== 'PK') throw badRequest('FILE_TYPE_NOT_ALLOWED', 'Upload an .xlsx or .xlsm workbook.');
  const key = tenantKey(ctx.tenantId, 'p', plant.id, 'imports', `${randomUUID()}.xlsx`);
  await storage.put(key, f.buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const r = await withTenant(tenantTx(ctx), async (tx) => {
    const row = await one<{ id: string }>(tx,
      `INSERT INTO app.imports (tenant_id, plant_id, file_key, mapping, status, created_by) VALUES ($1, $2, $3, $4, 'validating', $5) RETURNING id`,
      [ctx.tenantId, plant.id, key, mapping, ctx.userId]);
    await writeAudit(tx, clientActor(ctx), { action: 'import.upload', entity: 'import', entityId: row.id, after: { mapping } }, requestMeta(req));
    return row;
  });
  await enqueue(QUEUES.importValidate, { tenantId: ctx.tenantId, importId: r.id });
  res.status(202).json({ data: { id: r.id, status: 'validating' } });
}));

importsRouter.get('/:id', ...gate, accountState('read'), asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const r = await withTenant(tenantTx(ctx), (tx) => maybeOne(tx,
    `SELECT id, mapping, status, report, options, created_at FROM app.imports WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
    [ctx.tenantId, P(req).id, parseParams(req, idP).id]));
  if (!r) throw notFound('Import');
  ok(res, r);
}));

const applyBody = z.object({
  skipErrorRows: z.boolean().default(false),
  existing: z.enum(['skip', 'overwrite']).default('skip'),
  reason: z.string().trim().min(10).max(1000).optional(),
  openings: z.object({ stock: z.record(z.number().finite()).optional(), cash: z.number().finite().optional(), asOf: isoDate.optional() }).strict().optional(),
}).strict().refine((b) => b.existing !== 'overwrite' || !!b.reason, { message: 'A reason is required to overwrite', path: ['reason'] });

importsRouter.post('/:id/apply', ...gate, accountState('write'), asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const { id } = parseParams(req, idP);
  const body = parseBody(req, applyBody);
  await withTenant(tenantTx(ctx), async (tx) => {
    const imp = await maybeOne<{ status: string }>(tx, 'SELECT status FROM app.imports WHERE tenant_id = $1 AND plant_id = $2 AND id = $3 FOR UPDATE',
      [ctx.tenantId, P(req).id, id]);
    if (!imp) throw notFound('Import');
    if (imp.status !== 'validated') throw conflict('IMPORT_NOT_READY', `The import is ${imp.status}.`);
    if (P(req).setupStatus !== 'live') throw unprocessable('PLANT_NOT_LIVE', 'Complete the plant settings first.');
    await exec(tx, `UPDATE app.imports SET status = 'applying', options = $3::jsonb WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, id, JSON.stringify(body)]);
    await writeAudit(tx, clientActor(ctx), { action: 'import.apply_request', entity: 'import', entityId: id, after: body, reason: body.reason }, requestMeta(req));
  });
  await enqueue(QUEUES.importApply, { tenantId: ctx.tenantId, importId: id });
  res.status(202).json({ data: { id, status: 'applying' } });
}));
