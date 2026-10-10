import archiver from 'archiver';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { INVOICE_ZIP_MAX } from '../../../config/constants';
import { many, one } from '../../../db/sql';
import { withAdmin } from '../../../db/tenant';
import { enqueue } from '../../../jobs/boss';
import { QUEUES } from '../../../jobs/queues';
import { adminTx } from '../../../lib/context';
import { formatDisplayDate } from '../../../lib/dates';
import { unprocessable } from '../../../lib/errors';
import { asyncHandler, created, ok } from '../../../lib/http';
import { idempotent } from '../../../lib/idempotency';
import { pageMeta, paginationQuery } from '../../../lib/pagination';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams, parseQuery } from '../../../lib/validate';
import { INVOICE_STATUSES } from '../../../shared/enums';
import { formatMoney } from '../../../shared/format';
import { adminTdsBody, cancelInvoiceBody, creditNoteBody, manualInvoiceBody } from '../../../shared/schemas/billing';
import { idParam, uuid } from '../../../shared/schemas/common';
import { adminActor, writeAudit } from '../../audit/audit.service';
import { loadBillingConfig } from '../../billing/billing-config';
import { notifyClientBilling } from '../../billing/billing-notify';
import { invoiceDetail, listInvoices, tenantOfInvoice } from '../../billing/invoice-queries';
import { cancelInvoice, createCreditNote, createManualInvoice, issueDraft } from '../../billing/invoices.service';
import { ensurePayLink } from '../../billing/razorpay/links';
import { addTds } from '../../billing/tds-credit.service';
import { readStoredFile } from '../../exports/download';
import { docFileName } from '../../files/storage';
import { sendInBackground } from '../../notifications/email.service';
import { signedBillingUrl } from './files';

const fy = z.string().regex(/^\d{4}-\d{2}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const listQuery = paginationQuery.extend({
  clientId: uuid.optional(), status: z.enum(INVOICE_STATUSES).optional(), fy: fy.optional(), month: month.optional(),
  overdueDays: z.coerce.number().int().min(0).max(3650).optional(),
});
const id = (req: Request) => parseParams(req, idParam).id;

export const adminInvoicesRouter = Router();

adminInvoicesRouter.get('/', asyncHandler(async (req, res) => {
  const q = parseQuery(req, listQuery);
  const r = await withAdmin(adminTx(req), (tx) => listInvoices(tx, {
    tenantId: q.clientId ?? null, status: q.status, fy: q.fy, month: q.month, overdueDaysMin: q.overdueDays, q: q.q,
    includeDrafts: true, page: q.page, pageSize: q.pageSize,
  }));
  ok(res, r.items, pageMeta(q, r.total));
}));

adminInvoicesRouter.post('/', asyncHandler(async (req, res) => {
  const ctx = adminTx(req);
  const body = parseBody(req, manualInvoiceBody);
  created(res, await idempotent(req, `admin:${ctx.adminId}:invoices`, () => createManualInvoice(ctx, body, requestMeta(req))));
}));

/** INV-14: bulk download of invoice PDFs (streamed zip, max 500). */
adminInvoicesRouter.post('/zip', asyncHandler(async (req, res) => {
  const ctx = adminTx(req);
  const b = parseBody(req, z.object({ clientId: uuid.optional(), fy: fy.optional(), month: month.optional(), status: z.enum(INVOICE_STATUSES).optional() }).strict());
  const rows = await withAdmin(ctx, async (tx) => {
    const r = await many<{ number: string; pdf_key: string }>(
      tx,
      `SELECT number, pdf_key FROM app.invoices
        WHERE pdf_key IS NOT NULL AND number IS NOT NULL AND ($1::uuid IS NULL OR tenant_id = $1) AND ($2::text IS NULL OR fy = $2)
          AND ($3::text IS NULL OR to_char(issue_date, 'YYYY-MM') = $3) AND ($4::text IS NULL OR status = $4)
        ORDER BY number LIMIT $5`,
      [b.clientId ?? null, b.fy ?? null, b.month ?? null, b.status ?? null, INVOICE_ZIP_MAX + 1],
    );
    if (r.length > INVOICE_ZIP_MAX) throw unprocessable('TOO_MANY_FILES', `Narrow the filter: at most ${INVOICE_ZIP_MAX} invoices per zip.`);
    await writeAudit(tx, adminActor(ctx.adminId, b.clientId ?? null), { action: 'invoice.zip', entity: 'invoice', after: { ...b, count: r.length } }, requestMeta(req));
    return r;
  });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="invoices-${b.fy ?? b.month ?? 'all'}.zip"`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', (err) => res.destroy(err));
  zip.pipe(res);
  for (const r of rows) zip.append(await readStoredFile(r.pdf_key), { name: `${docFileName(r.number)}.pdf` });
  await zip.finalize();
}));

adminInvoicesRouter.get('/:id', asyncHandler(async (req, res) => {
  ok(res, await withAdmin(adminTx(req), (tx) => invoiceDetail(tx, null, id(req), { includeDrafts: true })));
}));
adminInvoicesRouter.post('/:id/issue', asyncHandler(async (req, res) => {
  ok(res, await issueDraft(adminTx(req), id(req), requestMeta(req)));
}));
adminInvoicesRouter.post('/:id/cancel', asyncHandler(async (req, res) => {
  ok(res, await cancelInvoice(adminTx(req), id(req), parseBody(req, cancelInvoiceBody), requestMeta(req)));
}));
adminInvoicesRouter.post('/:id/credit-notes', asyncHandler(async (req, res) => {
  created(res, await createCreditNote(adminTx(req), id(req), parseBody(req, creditNoteBody), requestMeta(req)));
}));
adminInvoicesRouter.get('/:id/pdf', asyncHandler(async (req, res) => {
  const r = await withAdmin(adminTx(req), async (tx) => {
    const tenantId = await tenantOfInvoice(tx, id(req));
    const { pdf_key } = await one<{ pdf_key: string | null }>(tx, 'SELECT pdf_key FROM app.invoices WHERE tenant_id = $1 AND id = $2', [tenantId, id(req)]);
    return { tenantId, key: pdf_key };
  });
  ok(res, await signedBillingUrl(r.key, r.tenantId));
}));
/** Re-sends N-B01 (no dedupe) to the billing emails + Client Admins. */
adminInvoicesRouter.post('/:id/resend', asyncHandler(async (req, res) => {
  const ctx = adminTx(req);
  const outbox = await withAdmin(ctx, async (tx) => {
    const tenantId = await tenantOfInvoice(tx, id(req));
    const i = await one<{ number: string | null; issue_date: string | null; due_date: string | null; balance: string; rzp_link_url: string | null; status: string }>(
      tx, 'SELECT number, issue_date, due_date, balance, rzp_link_url, status FROM app.invoices WHERE tenant_id = $1 AND id = $2', [tenantId, id(req)]);
    if (!i.number || !i.issue_date || !i.due_date) throw unprocessable('INVOICE_NOT_ISSUED', 'Only an issued invoice can be re-sent.');
    await writeAudit(tx, adminActor(ctx.adminId, tenantId), { action: 'invoice.resend', entity: 'invoice', entityId: id(req) }, requestMeta(req));
    const cfg = await loadBillingConfig(tx);
    return notifyClientBilling(tx, {
      tenantId, code: 'N-B01', title: `Invoice ${i.number}`, body: `Balance ${formatMoney(i.balance)}.`, link: `/billing/invoices/${id(req)}`,
      vars: {
        invoiceNo: i.number, invoiceDate: formatDisplayDate(i.issue_date), dueDate: formatDisplayDate(i.due_date),
        amount: formatMoney(i.balance), description: '', sellerName: cfg.seller.legalName, ...(i.rzp_link_url ? { payLink: i.rzp_link_url } : {}),
      },
    });
  });
  sendInBackground(outbox);
  res.status(204).end();
}));
adminInvoicesRouter.post('/:id/pay-link/refresh', asyncHandler(async (req, res) => {
  const ctx = adminTx(req);
  const tenantId = await withAdmin(ctx, (tx) => tenantOfInvoice(tx, id(req)));
  const url = await ensurePayLink(tenantId, id(req), { force: true });
  await withAdmin(ctx, (tx) => writeAudit(tx, adminActor(ctx.adminId, tenantId), { action: 'invoice.pay_link_refresh', entity: 'invoice', entityId: id(req) }, requestMeta(req)));
  await enqueue(QUEUES.pdfInvoice, { tenantId, kind: 'invoice', id: id(req) });
  ok(res, { url });
}));
adminInvoicesRouter.post('/:id/tds', asyncHandler(async (req, res) => {
  await addTds(adminTx(req), id(req), parseBody(req, adminTdsBody), requestMeta(req));
  ok(res, await withAdmin(adminTx(req), (tx) => invoiceDetail(tx, null, id(req), { includeDrafts: true })));
}));
