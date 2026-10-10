import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { PROOF_MAX_BYTES } from '../../config/constants';
import { many, maybeOne, one } from '../../db/sql';
import { withSystem, withTenant } from '../../db/tenant';
import { clientCtx, tenantTx } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { asyncHandler, created, ok } from '../../lib/http';
import { idempotent } from '../../lib/idempotency';
import { D, money } from '../../lib/money';
import { pageMeta, paginationQuery } from '../../lib/pagination';
import { requestMeta } from '../../lib/request-meta';
import { parseParams, parseQuery } from '../../lib/validate';
import { accountState } from '../../middleware/account-state';
import { requireClientAdmin } from '../../middleware/require-role';
import { INVOICE_STATUSES } from '../../shared/enums';
import { formatMoney } from '../../shared/format';
import { clientTdsFields, paymentNotificationFields } from '../../shared/schemas/billing';
import { idParam } from '../../shared/schemas/common';
import { currentSubscription } from '../admin/subscriptions/subscriptions.service';
import { clientActor, writeAudit } from '../audit/audit.service';
import { DEFAULT_SELLER, DEFAULT_TAX, type SellerSettings, type TaxSettings } from '../billing/billing-config';
import { notifySuperAdmins } from '../billing/billing-notify';
import { invoiceDetail, listInvoices } from '../billing/invoice-queries';
import { ensurePayLink } from '../billing/razorpay/links';
import { assertTenantKey, billingKey, storage } from '../files/storage';
import { detectFile, uploadSingle } from '../files/upload';
import { sendInBackground } from '../notifications/email.service';
import { getSetting } from '../platform/settings.service';

export const clientBillingRouter = Router();
clientBillingRouter.use(requireClientAdmin, accountState('billing'));

const id = (req: Request) => parseParams(req, idParam).id;
const OPEN = ['issued', 'partially_paid', 'overdue'];

/** An invoice of THIS tenant (404 otherwise, drafts are invisible to clients). */
async function ownInvoice(req: Request) {
  const ctx = clientCtx(req);
  const inv = await withTenant(tenantTx(ctx), (tx) => maybeOne<{ id: string; number: string; status: string; balance: string; total: string }>(
    tx, `SELECT id, number, status, balance, total FROM app.invoices WHERE tenant_id = $1 AND id = $2 AND status <> 'draft'`, [ctx.tenantId, id(req)]));
  if (!inv) throw notFound('Invoice');
  return { ctx, inv };
}

clientBillingRouter.get('/summary', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const seller = { ...DEFAULT_SELLER, ...(await getSetting<Partial<SellerSettings>>('seller.company', {})) };
  const r = await withTenant(tenantTx(ctx), (tx) => one<{ outstanding: string; overdue: string; next_due: string | null; credit: string }>(
    tx,
    `SELECT coalesce((SELECT sum(balance) FROM app.invoices WHERE tenant_id = $1 AND status IN ('issued', 'partially_paid', 'overdue')), 0) AS outstanding,
            coalesce((SELECT sum(balance) FROM app.invoices WHERE tenant_id = $1 AND status = 'overdue'), 0) AS overdue,
            (SELECT min(due_date) FROM app.invoices WHERE tenant_id = $1 AND status IN ('issued', 'partially_paid')) AS next_due,
            coalesce((SELECT sum(amount) FROM app.client_credit_ledger WHERE tenant_id = $1), 0) AS credit`,
    [ctx.tenantId],
  ));
  ok(res, {
    outstanding: money(r.outstanding), overdue: money(r.overdue), nextDue: r.next_due, creditBalance: money(r.credit),
    accountState: ctx.tenantAccountState,
    paymentInstructions: { // CA-12: offline payment details
      payee: seller.legalName, bank: seller.bank, upiId: seller.upiId, note: 'Quote the invoice number in the payment reference.',
    },
  });
}));

/** CA-09: per plant — plan, term, dates, billing mode, year-by-year schedule, account state. */
clientBillingRouter.get('/subscriptions', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  ok(res, await withTenant(tenantTx(ctx), async (tx) => {
    const plants = await many<{ id: string; name: string; code: string; account_state: string; setup_status: string }>(
      tx, 'SELECT id, name, code, account_state, setup_status FROM app.plants WHERE tenant_id = $1 ORDER BY name', [ctx.tenantId]);
    const out = [];
    for (const p of plants) {
      const sub = await currentSubscription(tx, ctx.tenantId, p.id);
      out.push({
        plantId: p.id, plantName: p.name, plantCode: p.code, accountState: p.account_state, setupStatus: p.setup_status,
        subscription: sub && {
          id: sub.id, planName: sub.plan.name, termYears: sub.plan.termYears, startDate: sub.startDate, endDate: sub.endDate,
          billingMode: sub.billingMode, status: sub.status, pricePerYear: sub.pricePerYear, schedule: sub.schedule, totalExGst: sub.totalExGst,
        },
      });
    }
    return out;
  }));
}));

clientBillingRouter.get('/invoices', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const q = parseQuery(req, paginationQuery.extend({ status: z.enum(INVOICE_STATUSES).optional() }));
  const r = await withTenant(tenantTx(ctx), (tx) => listInvoices(tx, {
    tenantId: ctx.tenantId, status: q.status === 'draft' ? 'none' : q.status, includeDrafts: false, page: q.page, pageSize: q.pageSize,
  }));
  ok(res, r.items, pageMeta(q, r.total));
}));
clientBillingRouter.get('/invoices/:id', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  ok(res, await withTenant(tenantTx(ctx), (tx) => invoiceDetail(tx, ctx.tenantId, id(req), { includeDrafts: false })));
}));
clientBillingRouter.get('/invoices/:id/pdf', asyncHandler(async (req, res) => {
  const { ctx } = await ownInvoice(req);
  const r = await withTenant(tenantTx(ctx), (tx) => one<{ pdf_key: string | null }>(
    tx, 'SELECT pdf_key FROM app.invoices WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id(req)]));
  if (!r.pdf_key) throw conflict('PDF_NOT_READY', 'The invoice PDF is being generated. Try again in a minute.');
  assertTenantKey(r.pdf_key, ctx.tenantId);
  ok(res, { url: await storage.signedUrl(r.pdf_key, { downloadName: r.pdf_key.split('/').pop() }) });
}));

/** CA-10 "Pay Now": a valid Razorpay link for the current balance (created on demand). */
clientBillingRouter.post('/invoices/:id/pay-link', asyncHandler(async (req, res) => {
  const { ctx, inv } = await ownInvoice(req);
  if (!OPEN.includes(inv.status) || !D(inv.balance).gt(0)) throw conflict('INVOICE_NOT_OPEN', 'This invoice has nothing left to pay.');
  const url = await ensurePayLink(ctx.tenantId, inv.id);
  if (!url) throw conflict('PAY_LINK_UNAVAILABLE', 'Online payment is not available right now. Please use bank transfer.');
  ok(res, { url });
}));

const proofUpload = uploadSingle('file', PROOF_MAX_BYTES);

/** CA-12 "I have paid by bank transfer": creates a notification for the Super Admin to verify (nothing is applied yet). */
clientBillingRouter.post('/invoices/:id/payment-notifications', proofUpload, asyncHandler(async (req, res) => {
  const { ctx, inv } = await ownInvoice(req);
  if (!OPEN.includes(inv.status)) throw conflict('INVOICE_NOT_OPEN', 'This invoice is not open.');
  const f = paymentNotificationFields.parse(req.body ?? {});
  if (D(f.amount).gt(D(inv.balance).mul(2))) throw unprocessable('AMOUNT_TOO_LARGE', 'The amount is much larger than the balance.');
  const result = await idempotent(req, `tenant:${ctx.tenantId}:pn:${inv.id}`, async () => {
    const pnId = randomUUID();
    let proofKey: string | null = null;
    if (req.file) {
      const file = await detectFile(req.file, ['pdf', 'png', 'jpg']);
      proofKey = billingKey(ctx.tenantId, 'proofs', `pn-${pnId}.${file.ext}`);
      await storage.put(proofKey, file.buffer, file.mime);
    }
    await withTenant(tenantTx(ctx), async (tx) => {
      await tx.query(
        `INSERT INTO app.payment_notifications (id, tenant_id, invoice_id, amount, paid_on, reference, proof_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [pnId, ctx.tenantId, inv.id, money(f.amount), f.paidOn, f.reference, proofKey, ctx.userId],
      );
      await writeAudit(tx, clientActor(ctx), { action: 'payment_notification.create', entity: 'payment_notification', entityId: pnId, after: f }, requestMeta(req));
    });
    // Platform notification (admin_user): AFTER the tenant transaction committed.
    const outbox = await withSystem((tx) => notifySuperAdmins(tx, {
      code: 'N-S04', title: `Client says paid: ${formatMoney(f.amount)}`, body: `Invoice ${inv.number}, ref ${f.reference}, on ${f.paidOn}.`,
      link: '/payment-notifications', clientId: ctx.tenantId, dedupeKey: `N-S04:${pnId}`, email: true,
    }));
    sendInBackground(outbox);
    return { id: pnId, status: 'pending' };
  });
  created(res, result);
}));

/** CA-13: TDS deducted by the client (+ optional Form 16A). Counted only after Super Admin verification. */
clientBillingRouter.post('/invoices/:id/tds', proofUpload, asyncHandler(async (req, res) => {
  const { ctx, inv } = await ownInvoice(req);
  if (!OPEN.includes(inv.status)) throw conflict('INVOICE_NOT_OPEN', 'This invoice is not open.');
  const f = clientTdsFields.parse(req.body ?? {});
  const tax = { ...DEFAULT_TAX, ...(await getSetting<Partial<TaxSettings>>('tax', {})) };
  if (!tax.tdsSections.includes(f.section)) throw unprocessable('TDS_SECTION_UNKNOWN', `Allowed sections: ${tax.tdsSections.join(', ')}.`);
  if (D(f.amount).gt(inv.balance)) throw unprocessable('TDS_EXCEEDS_BALANCE', 'TDS is larger than the invoice balance.');
  const tdsId = randomUUID();
  let key: string | null = null;
  if (req.file) {
    const file = await detectFile(req.file, ['pdf', 'png', 'jpg']);
    key = billingKey(ctx.tenantId, 'tds', `${tdsId}.${file.ext}`);
    await storage.put(key, file.buffer, file.mime);
  }
  await withTenant(tenantTx(ctx), async (tx) => {
    await tx.query(
      `INSERT INTO app.tds_entries (id, tenant_id, invoice_id, amount, section, deduction_date, certificate_status, certificate_key,
                                    entered_by_client, verified, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, $9)`,
      [tdsId, ctx.tenantId, inv.id, money(f.amount), f.section, f.deductionDate, key ? 'received' : 'pending', key, ctx.userId],
    );
    await writeAudit(tx, clientActor(ctx), { action: 'tds.client_entry', entity: 'tds', entityId: tdsId, after: f }, requestMeta(req));
  });
  const outbox = await withSystem((tx) => notifySuperAdmins(tx, {
    code: 'TDS_ENTERED', title: `TDS entered by client: ${formatMoney(f.amount)}`, body: `Invoice ${inv.number}, section ${f.section}. Pending verification.`,
    link: '/tds?verified=false', clientId: ctx.tenantId, dedupeKey: `TDS:${tdsId}`,
  }));
  sendInBackground(outbox);
  created(res, { id: tdsId, verified: false });
}));

clientBillingRouter.get('/payments', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  ok(res, await withTenant(tenantTx(ctx), (tx) => many(
    tx,
    `SELECT p.id, p.mode, p.amount, p.payment_date AS "paymentDate", p.reference, p.status, r.id AS "receiptId", r.number AS "receiptNo",
            r.pdf_key IS NOT NULL AS "receiptReady",
            (SELECT json_agg(json_build_object('invoiceNo', i.number, 'amount', a.amount)) FROM app.payment_allocations a
               LEFT JOIN app.invoices i ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
              WHERE a.tenant_id = p.tenant_id AND a.payment_id = p.id) AS allocations
       FROM app.payments p LEFT JOIN app.receipts r ON r.tenant_id = p.tenant_id AND r.payment_id = p.id
      WHERE p.tenant_id = $1 ORDER BY p.payment_date DESC, p.created_at DESC LIMIT 500`,
    [ctx.tenantId],
  )));
}));
clientBillingRouter.get('/payment-notifications', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  ok(res, await withTenant(tenantTx(ctx), (tx) => many(
    tx,
    `SELECT n.id, n.invoice_id AS "invoiceId", i.number AS "invoiceNo", n.amount, n.paid_on AS "paidOn", n.reference, n.status, n.note,
            n.created_at AS "createdAt"
       FROM app.payment_notifications n JOIN app.invoices i ON i.tenant_id = n.tenant_id AND i.id = n.invoice_id
      WHERE n.tenant_id = $1 ORDER BY n.created_at DESC LIMIT 200`,
    [ctx.tenantId],
  )));
}));

async function signedDoc(req: Request, table: 'app.receipts' | 'app.credit_notes', what: string) {
  const ctx = clientCtx(req);
  const r = await withTenant(tenantTx(ctx), (tx) => maybeOne<{ pdf_key: string | null }>(
    tx, `SELECT pdf_key FROM ${table} WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, id(req)]));
  if (!r) throw notFound(what);
  if (!r.pdf_key) throw conflict('PDF_NOT_READY', `The ${what.toLowerCase()} PDF is being generated. Try again in a minute.`);
  assertTenantKey(r.pdf_key, ctx.tenantId);
  return { url: await storage.signedUrl(r.pdf_key, { downloadName: r.pdf_key.split('/').pop() }) };
}
clientBillingRouter.get('/receipts/:id/pdf', asyncHandler(async (req, res) => ok(res, await signedDoc(req, 'app.receipts', 'Receipt'))));
clientBillingRouter.get('/credit-notes/:id/pdf', asyncHandler(async (req, res) => ok(res, await signedDoc(req, 'app.credit_notes', 'Credit note'))));

/** CA-11: credit balance and its history. */
clientBillingRouter.get('/credit', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  ok(res, await withTenant(tenantTx(ctx), async (tx) => ({
    balance: money((await one<{ b: string }>(tx, 'SELECT coalesce(sum(amount), 0) AS b FROM app.client_credit_ledger WHERE tenant_id = $1', [ctx.tenantId])).b),
    ledger: await many(tx,
      `SELECT entry_date AS "date", kind, amount, ref_type AS "refType" FROM app.client_credit_ledger
        WHERE tenant_id = $1 ORDER BY entry_date DESC, created_at DESC LIMIT 200`, [ctx.tenantId]),
  })));
}));
