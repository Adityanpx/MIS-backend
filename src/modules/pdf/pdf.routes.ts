import { Router, type Request } from 'express';
import { z } from 'zod';
import { many, maybeOne, one } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { enqueue } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { clientCtx, tenantTx } from '../../lib/context';
import { daysInclusive } from '../../lib/dates';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { asyncHandler, ok } from '../../lib/http';
import { requestMeta } from '../../lib/request-meta';
import { parseBody, parseParams, parseQuery } from '../../lib/validate';
import { accountState } from '../../middleware/account-state';
import { plantAccess } from '../../middleware/plant-access';
import { requireClientAdmin } from '../../middleware/require-role';
import { isoDate, uuid } from '../../shared/schemas/common';
import { clientActor, writeAudit } from '../audit/audit.service';
import { assertTenantKey, storage } from '../files/storage';

export const pdfRouter = Router({ mergeParams: true });
const P = (req: Request) => {
  if (!req.plant) throw notFound('Plant');
  return req.plant;
};

pdfRouter.get('/', plantAccess('any'), accountState('read'), asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const q = parseQuery(req, z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), month: z.coerce.number().int().min(1).max(12).optional() }));
  const rows = await withTenant(tenantTx(ctx), (tx) => many(tx,
    `SELECT id, d AS date, doc_type, version, status, reason, size_bytes, generated_at FROM app.pdf_documents
      WHERE tenant_id = $1 AND plant_id = $2 AND ($3::int IS NULL OR extract(year FROM d) = $3) AND ($4::int IS NULL OR extract(month FROM d) = $4)
      ORDER BY d DESC, doc_type, version DESC LIMIT 2000`, [ctx.tenantId, P(req).id, q.year ?? null, q.month ?? null]));
  ok(res, rows);
}));

pdfRouter.get('/:pdfId/download', plantAccess('any'), accountState('read'), asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const { pdfId } = parseParams(req, z.object({ plantId: uuid, pdfId: uuid }));
  const doc = await withTenant(tenantTx(ctx), (tx) => maybeOne<{ file_key: string | null }>(tx,
    'SELECT file_key FROM app.pdf_documents WHERE tenant_id = $1 AND plant_id = $2 AND id = $3', [ctx.tenantId, P(req).id, pdfId]));
  if (!doc?.file_key) throw notFound('PDF');
  assertTenantKey(doc.file_key, ctx.tenantId); // PDF-09: the key must belong to the tenant before signing
  ok(res, { url: await storage.signedUrl(doc.file_key, { downloadName: doc.file_key.split('/').pop() }) });
}));

/** PDF-02: on demand (one date: Editor or Client Admin) or bulk (range: Client Admin, ≤ 366 days). */
pdfRouter.post('/generate', plantAccess(['editor']), accountState('read'), asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const plant = P(req);
  const b = parseBody(req, z.union([
    z.object({ date: isoDate }).strict(),
    z.object({ from: isoDate, to: isoDate }).strict(),
  ]));
  if ('from' in b) {
    if (!ctx.isClientAdmin) throw forbidden('FORBIDDEN_ROLE', 'Only a Client Admin can generate a date range.');
    if (b.from > b.to || daysInclusive(b.from, b.to) > 366) throw badRequest('INVALID_RANGE', 'Choose up to 366 days.');
  }
  await withTenant(tenantTx(ctx), (tx) => writeAudit(tx, clientActor(ctx), { action: 'pdf.generate_request', entity: 'plant', entityId: plant.id, after: b }, requestMeta(req)));
  await enqueue(QUEUES.pdfGenerate, { tenantId: ctx.tenantId, plantId: plant.id, ...b, reason: 'regenerate' });
  res.status(202).json({ data: { queued: true } });
}));

pdfRouter.post('/zip', plantAccess([]), requireClientAdmin, accountState('read'), asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const plant = P(req);
  const b = parseBody(req, z.object({ from: isoDate, to: isoDate }).strict());
  if (b.from > b.to || daysInclusive(b.from, b.to) > 366) throw badRequest('INVALID_RANGE', 'Choose up to 366 days.');
  const { id } = await withTenant(tenantTx(ctx), async (tx) => {
    const r = await one<{ id: string }>(tx, `INSERT INTO app.exports (tenant_id, scope, status, created_by) VALUES ($1, $2::jsonb, 'building', $3) RETURNING id`,
      [ctx.tenantId, JSON.stringify({ type: 'pdf_zip', plantId: plant.id, ...b }), ctx.userId]);
    await writeAudit(tx, clientActor(ctx), { action: 'pdf.zip_request', entity: 'export', entityId: r.id, after: b }, requestMeta(req));
    return r;
  });
  await enqueue(QUEUES.pdfZip, { tenantId: ctx.tenantId, plantId: plant.id, ...b, exportId: id, userId: ctx.userId });
  res.status(202).json({ data: { exportId: id } });
}));
