import { Router, type Request } from 'express';
import { z } from 'zod';
import { PROOF_MAX_BYTES } from '../../../config/constants';
import { many, maybeOne } from '../../../db/sql';
import { withAdmin } from '../../../db/tenant';
import { adminTx } from '../../../lib/context';
import { notFound } from '../../../lib/errors';
import { asyncHandler, created, noContent, ok } from '../../../lib/http';
import { idempotent } from '../../../lib/idempotency';
import { pageMeta, paginationQuery } from '../../../lib/pagination';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams, parseQuery } from '../../../lib/validate';
import { PAYMENT_MODES, PAYMENT_STATUSES } from '../../../shared/enums';
import {
  allocationsPutBody, chequeBounceBody, chequeClearBody, offlinePaymentBody, rejectNotificationBody, reverseBody, tdsPatchBody,
  verifyNotificationBody,
} from '../../../shared/schemas/billing';
import { idParam, isoDate, uuid } from '../../../shared/schemas/common';
import { adminActor, writeAudit } from '../../audit/audit.service';
import * as pay from '../../billing/payments.service';
import * as tds from '../../billing/tds-credit.service';
import { billingKey, storage } from '../../files/storage';
import { detectFile, uploadSingle } from '../../files/upload';
import { signedBillingUrl } from './files';

const id = (req: Request) => parseParams(req, idParam).id;
const proofUpload = uploadSingle('file', PROOF_MAX_BYTES);

export const adminPaymentsRouter = Router();
adminPaymentsRouter.get('/', asyncHandler(async (req, res) => {
  const q = parseQuery(req, paginationQuery.extend({
    clientId: uuid.optional(), mode: z.enum(PAYMENT_MODES).optional(), status: z.enum(PAYMENT_STATUSES).optional(),
    from: isoDate.optional(), to: isoDate.optional(), needsReview: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  }));
  const r = await pay.listPayments(adminTx(req), q);
  ok(res, r.items, pageMeta(q, r.total));
}));
adminPaymentsRouter.post('/', asyncHandler(async (req, res) => {
  const ctx = adminTx(req);
  const body = parseBody(req, offlinePaymentBody);
  created(res, await idempotent(req, `admin:${ctx.adminId}:payments`, () => pay.recordOfflinePayment(ctx, body, requestMeta(req))));
}));
adminPaymentsRouter.get('/:id', asyncHandler(async (req, res) => ok(res, await pay.getPayment(adminTx(req), id(req)))));
adminPaymentsRouter.post('/:id/proof', proofUpload, asyncHandler(async (req, res) => {
  const file = await detectFile(req.file, ['pdf', 'png', 'jpg']);
  ok(res, await pay.setPaymentProof(adminTx(req), id(req), file, requestMeta(req)));
}));
adminPaymentsRouter.get('/:id/proof', asyncHandler(async (req, res) => {
  const p = await withAdmin(adminTx(req), (tx) => maybeOne<{ tenant_id: string; proof_key: string | null }>(
    tx, 'SELECT tenant_id, proof_key FROM app.payments WHERE id = $1', [id(req)]));
  if (!p?.proof_key) throw notFound('Proof');
  ok(res, await signedBillingUrl(p.proof_key, p.tenant_id, 'The proof'));
}));
adminPaymentsRouter.post('/:id/clear', asyncHandler(async (req, res) => {
  ok(res, await pay.clearCheque(adminTx(req), id(req), parseBody(req, chequeClearBody).clearedOn, requestMeta(req)));
}));
adminPaymentsRouter.post('/:id/bounce', asyncHandler(async (req, res) => {
  ok(res, await pay.bounceCheque(adminTx(req), id(req), parseBody(req, chequeBounceBody), requestMeta(req)));
}));
adminPaymentsRouter.post('/:id/reverse', asyncHandler(async (req, res) => {
  ok(res, await pay.reversePayment(adminTx(req), id(req), parseBody(req, reverseBody).reason, requestMeta(req)));
}));
adminPaymentsRouter.put('/:id/allocations', asyncHandler(async (req, res) => {
  ok(res, await pay.reallocate(adminTx(req), id(req), parseBody(req, allocationsPutBody).allocations, requestMeta(req)));
}));
adminPaymentsRouter.post('/:id/reviewed', asyncHandler(async (req, res) => {
  const { note } = parseBody(req, z.object({ note: z.string().trim().min(3).max(500) }).strict());
  ok(res, await pay.markReviewed(adminTx(req), id(req), note, requestMeta(req)));
}));

// ---------------------------------------------------------------- "I have paid" (CA-12)
export const adminPaymentNotificationsRouter = Router();
adminPaymentNotificationsRouter.get('/', asyncHandler(async (req, res) => {
  const q = parseQuery(req, z.object({ status: z.enum(['pending', 'verified', 'rejected']).optional() }));
  ok(res, await tds.listPaymentNotifications(adminTx(req), q.status));
}));
adminPaymentNotificationsRouter.get('/:id/proof', asyncHandler(async (req, res) => {
  const n = await withAdmin(adminTx(req), (tx) => maybeOne<{ tenant_id: string; proof_key: string | null }>(
    tx, 'SELECT tenant_id, proof_key FROM app.payment_notifications WHERE id = $1', [id(req)]));
  if (!n?.proof_key) throw notFound('Proof');
  ok(res, await signedBillingUrl(n.proof_key, n.tenant_id, 'The proof'));
}));
adminPaymentNotificationsRouter.post('/:id/verify', asyncHandler(async (req, res) => {
  ok(res, await tds.verifyPaymentNotification(adminTx(req), id(req), parseBody(req, verifyNotificationBody), requestMeta(req)));
}));
adminPaymentNotificationsRouter.post('/:id/reject', asyncHandler(async (req, res) => {
  await tds.rejectPaymentNotification(adminTx(req), id(req), parseBody(req, rejectNotificationBody).note, requestMeta(req));
  noContent(res);
}));

// ---------------------------------------------------------------- TDS (TDS-02…04)
export const adminTdsRouter = Router();
adminTdsRouter.get('/', asyncHandler(async (req, res) => {
  const q = parseQuery(req, z.object({
    clientId: uuid.optional(), verified: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    certificateStatus: z.enum(['pending', 'received']).optional(),
  }));
  ok(res, await tds.listTds(adminTx(req), q));
}));
adminTdsRouter.patch('/:id', asyncHandler(async (req, res) => {
  await tds.patchTds(adminTx(req), id(req), parseBody(req, tdsPatchBody), requestMeta(req));
  noContent(res);
}));
adminTdsRouter.post('/:id/certificate', proofUpload, asyncHandler(async (req, res) => {
  const ctx = adminTx(req);
  const file = await detectFile(req.file, ['pdf', 'png', 'jpg']);
  const t = await withAdmin(ctx, (tx) => maybeOne<{ tenant_id: string }>(tx, 'SELECT tenant_id FROM app.tds_entries WHERE id = $1', [id(req)]));
  if (!t) throw notFound('TDS entry');
  const key = billingKey(t.tenant_id, 'tds', `${id(req)}.${file.ext}`);
  await storage.put(key, file.buffer, file.mime);
  await withAdmin(ctx, async (tx) => {
    await tx.query(`UPDATE app.tds_entries SET certificate_key = $3, certificate_status = 'received' WHERE tenant_id = $1 AND id = $2`,
      [t.tenant_id, id(req), key]);
    await writeAudit(tx, adminActor(ctx.adminId, t.tenant_id), { action: 'tds.certificate_upload', entity: 'tds', entityId: id(req) }, requestMeta(req));
  });
  noContent(res);
}));
adminTdsRouter.get('/:id/certificate', asyncHandler(async (req, res) => {
  const t = await withAdmin(adminTx(req), (tx) => maybeOne<{ tenant_id: string; certificate_key: string | null }>(
    tx, 'SELECT tenant_id, certificate_key FROM app.tds_entries WHERE id = $1', [id(req)]));
  if (!t?.certificate_key) throw notFound('Certificate');
  ok(res, await signedBillingUrl(t.certificate_key, t.tenant_id, 'The certificate'));
}));

// ---------------------------------------------------------------- credit notes and receipts (read + PDF)
export const adminBillingDocsRouter = Router();
adminBillingDocsRouter.get('/credit-notes', asyncHandler(async (req, res) => {
  const q = parseQuery(req, z.object({ clientId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() }));
  ok(res, await withAdmin(adminTx(req), (tx) => many(
    tx,
    `SELECT cn.id, cn.tenant_id AS "clientId", c.display_name AS "clientName", cn.number, cn.cn_date AS "date", cn.taxable,
            cn.cgst, cn.sgst, cn.igst, cn.total, cn.reason, i.number AS "invoiceNo", cn.pdf_key IS NOT NULL AS "pdfReady"
       FROM app.credit_notes cn JOIN app.clients c ON c.id = cn.tenant_id JOIN app.invoices i ON i.tenant_id = cn.tenant_id AND i.id = cn.invoice_id
      WHERE ($1::uuid IS NULL OR cn.tenant_id = $1) AND ($2::date IS NULL OR cn.cn_date >= $2) AND ($3::date IS NULL OR cn.cn_date <= $3)
      ORDER BY cn.cn_date DESC LIMIT 1000`,
    [q.clientId ?? null, q.from ?? null, q.to ?? null],
  )));
}));
adminBillingDocsRouter.get('/credit-notes/:id/pdf', asyncHandler(async (req, res) => {
  const r = await withAdmin(adminTx(req), (tx) => maybeOne<{ tenant_id: string; pdf_key: string | null }>(
    tx, 'SELECT tenant_id, pdf_key FROM app.credit_notes WHERE id = $1', [id(req)]));
  if (!r) throw notFound('Credit note');
  ok(res, await signedBillingUrl(r.pdf_key, r.tenant_id));
}));
adminBillingDocsRouter.get('/receipts/:id/pdf', asyncHandler(async (req, res) => {
  const r = await withAdmin(adminTx(req), (tx) => maybeOne<{ tenant_id: string; pdf_key: string | null }>(
    tx, 'SELECT tenant_id, pdf_key FROM app.receipts WHERE id = $1', [id(req)]));
  if (!r) throw notFound('Receipt');
  ok(res, await signedBillingUrl(r.pdf_key, r.tenant_id));
}));
