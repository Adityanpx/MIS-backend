import { exec, many, maybeOne, one } from '../../db/sql';
import { withAdmin, type AdminTxCtx } from '../../db/tenant';
import { enqueue } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { todayIST } from '../../lib/dates';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { D, money } from '../../lib/money';
import type { RequestMeta } from '../../lib/request-meta';
import { invalidateClientAuthCache } from '../../middleware/auth-client';
import { formatMoney } from '../../shared/format';
import { adminActor, writeAudit } from '../audit/audit.service';
import { evaluateTenant } from '../lifecycle/lifecycle.service';
import { sendInBackground } from '../notifications/email.service';
import { loadBillingConfig, lockTenantBilling } from './billing-config';
import { applyCreditToInvoice, addCreditEntry, creditBalance } from './credit';
import { tenantOfInvoice } from './invoice-queries';
import { recomputeInvoice } from './invoice-totals';
import { recordOfflinePaymentTx } from './payments.service';

async function afterChange(tenantId: string, outbox: Array<string | null>, invoiceIds: string[]) {
  invalidateClientAuthCache();
  sendInBackground(outbox);
  for (const invoiceId of invoiceIds) {
    await enqueue(QUEUES.razorpayLinkCreate, { tenantId, invoiceId, then: 'pdf' }, { singletonKey: `rzp-link:${invoiceId}` });
  }
}

/** TDS-02 (Super Admin entry = verified). */
export async function addTds(
  ctx: AdminTxCtx, invoiceId: string, input: { amount: string; section: string; deductionDate: string; certificateStatus: 'pending' | 'received' }, meta: RequestMeta,
) {
  const tenantId = await withAdmin(ctx, (tx) => tenantOfInvoice(tx, invoiceId));
  const outbox = await withAdmin(ctx, async (tx) => {
    await lockTenantBilling(tx, tenantId);
    const cfg = await loadBillingConfig(tx);
    if (!cfg.tax.tdsSections.includes(input.section)) throw unprocessable('TDS_SECTION_UNKNOWN', `Allowed sections: ${cfg.tax.tdsSections.join(', ')}.`);
    const inv = await one<{ status: string; balance: string }>(
      tx, 'SELECT status, balance FROM app.invoices WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, invoiceId]);
    if (['draft', 'cancelled'].includes(inv.status)) throw conflict('INVOICE_NOT_OPEN', 'TDS can only be recorded on an issued invoice.');
    if (D(input.amount).gt(inv.balance)) throw unprocessable('TDS_EXCEEDS_BALANCE', 'TDS is larger than the invoice balance.');
    const actor = adminActor(ctx.adminId, tenantId);
    const { id } = await one<{ id: string }>(
      tx,
      `INSERT INTO app.tds_entries (tenant_id, invoice_id, amount, section, deduction_date, certificate_status, verified, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`,
      [tenantId, invoiceId, money(input.amount), input.section, input.deductionDate, input.certificateStatus, ctx.adminId],
    );
    await recomputeInvoice(tx, tenantId, invoiceId, { tolerance: cfg.tax.closeTolerance, today: todayIST(), actor });
    await writeAudit(tx, actor, { action: 'tds.create', entity: 'tds', entityId: id, after: input }, meta);
    return (await evaluateTenant(tx, tenantId, { actor, cause: 'payment', note: 'TDS recorded' })).outbox;
  });
  await afterChange(tenantId, outbox, [invoiceId]);
}

/** TDS-02/CA-13: certificate status, verification of a client-entered TDS. */
export async function patchTds(
  ctx: AdminTxCtx, tdsId: string, patch: { certificateStatus?: 'pending' | 'received'; verified?: boolean; note?: string }, meta: RequestMeta,
) {
  const t = await withAdmin(ctx, (tx) => maybeOne<{ tenant_id: string; invoice_id: string }>(
    tx, 'SELECT tenant_id, invoice_id FROM app.tds_entries WHERE id = $1', [tdsId]));
  if (!t) throw notFound('TDS entry');
  const outbox = await withAdmin(ctx, async (tx) => {
    await lockTenantBilling(tx, t.tenant_id);
    const cfg = await loadBillingConfig(tx);
    const actor = adminActor(ctx.adminId, t.tenant_id);
    const before = await one(tx, 'SELECT certificate_status, verified, note FROM app.tds_entries WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [t.tenant_id, tdsId]);
    await exec(
      tx,
      `UPDATE app.tds_entries SET certificate_status = coalesce($3, certificate_status), verified = coalesce($4, verified),
              note = coalesce($5, note) WHERE tenant_id = $1 AND id = $2`,
      [t.tenant_id, tdsId, patch.certificateStatus ?? null, patch.verified ?? null, patch.note ?? null],
    );
    await recomputeInvoice(tx, t.tenant_id, t.invoice_id, { tolerance: cfg.tax.closeTolerance, today: todayIST(), actor });
    await writeAudit(tx, actor, { action: 'tds.update', entity: 'tds', entityId: tdsId, before, after: patch }, meta);
    return (await evaluateTenant(tx, t.tenant_id, { actor, cause: 'payment', note: 'TDS updated' })).outbox;
  });
  await afterChange(t.tenant_id, outbox, [t.invoice_id]);
}

export async function listTds(ctx: AdminTxCtx, q: { clientId?: string; verified?: boolean; certificateStatus?: string }) {
  return withAdmin(ctx, (tx) => many(
    tx,
    `SELECT t.id, t.tenant_id AS "clientId", c.display_name AS "clientName", t.invoice_id AS "invoiceId", i.number AS "invoiceNo",
            t.amount, t.section, t.deduction_date AS "deductionDate", t.certificate_status AS "certificateStatus",
            t.certificate_key IS NOT NULL AS "certificateUploaded", t.entered_by_client AS "enteredByClient", t.verified, t.note
       FROM app.tds_entries t JOIN app.clients c ON c.id = t.tenant_id
       JOIN app.invoices i ON i.tenant_id = t.tenant_id AND i.id = t.invoice_id
      WHERE ($1::uuid IS NULL OR t.tenant_id = $1) AND ($2::boolean IS NULL OR t.verified = $2)
        AND ($3::text IS NULL OR t.certificate_status = $3)
      ORDER BY t.deduction_date DESC LIMIT 1000`,
    [q.clientId ?? null, q.verified ?? null, q.certificateStatus ?? null],
  ));
}

// ------------------------------------------------------------------ credit (CRD-01…03)
export async function getCredit(ctx: AdminTxCtx, clientId: string) {
  return withAdmin(ctx, async (tx) => {
    const c = await maybeOne(tx, `SELECT 1 FROM app.clients WHERE id = $1 AND status <> 'deleted'`, [clientId]);
    if (!c) throw notFound('Client');
    const ledger = await many(tx,
      `SELECT id, entry_date AS "date", kind, amount, ref_type AS "refType", ref_id AS "refId", created_at AS "createdAt"
         FROM app.client_credit_ledger WHERE tenant_id = $1 ORDER BY entry_date DESC, created_at DESC LIMIT 500`, [clientId]);
    return { balance: await creditBalance(tx, clientId), ledger };
  });
}

export async function refundCredit(
  ctx: AdminTxCtx, clientId: string, input: { amount: string; refundDate: string; mode: string; reference?: string; reason: string }, meta: RequestMeta,
) {
  await withAdmin(ctx, async (tx) => {
    const c = await maybeOne(tx, `SELECT 1 FROM app.clients WHERE id = $1 AND status <> 'deleted'`, [clientId]);
    if (!c) throw notFound('Client');
    await lockTenantBilling(tx, clientId);
    const bal = await creditBalance(tx, clientId);
    if (D(input.amount).gt(bal)) throw unprocessable('CREDIT_INSUFFICIENT', `Available credit is ${formatMoney(bal)}.`);
    await addCreditEntry(tx, clientId, { kind: 'refunded', amount: D(input.amount).neg(), date: input.refundDate, refType: 'refund', by: ctx.adminId });
    await writeAudit(tx, adminActor(ctx.adminId, clientId), { action: 'credit.refund', entity: 'client', entityId: clientId, after: input, reason: input.reason }, meta);
  });
  return getCredit(ctx, clientId);
}

/** CRD-02 manual mode: apply available credit to one invoice. */
export async function applyCredit(ctx: AdminTxCtx, clientId: string, input: { invoiceId: string; amount?: string }, meta: RequestMeta) {
  const outbox = await withAdmin(ctx, async (tx) => {
    const inv = await maybeOne(tx, 'SELECT 1 FROM app.invoices WHERE tenant_id = $1 AND id = $2', [clientId, input.invoiceId]);
    if (!inv) throw notFound('Invoice');
    await lockTenantBilling(tx, clientId);
    const cfg = await loadBillingConfig(tx);
    const actor = adminActor(ctx.adminId, clientId);
    const applied = await applyCreditToInvoice(tx, clientId, input.invoiceId, {
      maxAmount: input.amount, tolerance: cfg.tax.closeTolerance, today: todayIST(), actor,
    });
    await writeAudit(tx, actor, { action: 'credit.apply', entity: 'invoice', entityId: input.invoiceId, after: { applied } }, meta);
    return (await evaluateTenant(tx, clientId, { actor, cause: 'payment', note: 'Credit applied' })).outbox;
  });
  await afterChange(clientId, outbox, [input.invoiceId]);
  return getCredit(ctx, clientId);
}

// ------------------------------------------------------------------ "I have paid" notifications (CA-12)
export async function listPaymentNotifications(ctx: AdminTxCtx, status?: string) {
  return withAdmin(ctx, (tx) => many(
    tx,
    `SELECT n.id, n.tenant_id AS "clientId", c.display_name AS "clientName", n.invoice_id AS "invoiceId", i.number AS "invoiceNo",
            n.amount, n.paid_on AS "paidOn", n.reference, n.proof_key IS NOT NULL AS "proofUploaded", n.status, n.note,
            n.created_at AS "createdAt"
       FROM app.payment_notifications n JOIN app.clients c ON c.id = n.tenant_id
       JOIN app.invoices i ON i.tenant_id = n.tenant_id AND i.id = n.invoice_id
      WHERE ($1::text IS NULL OR n.status = $1) ORDER BY n.created_at DESC LIMIT 500`,
    [status ?? null],
  ));
}

export async function verifyPaymentNotification(
  ctx: AdminTxCtx, id: string, input: { mode: 'neft' | 'rtgs' | 'imps' | 'upi' | 'other'; allocations?: Array<{ invoiceId: string; amount: string }> }, meta: RequestMeta,
) {
  const n = await withAdmin(ctx, (tx) => maybeOne<{ tenant_id: string; invoice_id: string; amount: string; paid_on: string; reference: string; status: string; proof_key: string | null }>(
    tx, 'SELECT tenant_id, invoice_id, amount, paid_on, reference, status, proof_key FROM app.payment_notifications WHERE id = $1', [id]));
  if (!n) throw notFound('Payment notification');
  if (n.status !== 'pending') throw conflict('ALREADY_HANDLED', 'This notification was already handled.');
  const r = await withAdmin(ctx, async (tx) => {
    await lockTenantBilling(tx, n.tenant_id);
    const cfg = await loadBillingConfig(tx);
    const actor = adminActor(ctx.adminId, n.tenant_id);
    const res = await recordOfflinePaymentTx(tx, {
      clientId: n.tenant_id, mode: input.mode, amount: n.amount, paymentDate: n.paid_on, reference: n.reference,
      allocations: input.allocations ?? [{ invoiceId: n.invoice_id, amount: n.amount }], paymentNotificationId: id,
    }, cfg, actor, meta);
    if (n.proof_key) await exec(tx, 'UPDATE app.payments SET proof_key = $3 WHERE tenant_id = $1 AND id = $2', [n.tenant_id, res.paymentId, n.proof_key]);
    await exec(tx, `UPDATE app.payment_notifications SET status = 'verified', handled_by = $3, handled_at = now()
                     WHERE tenant_id = $1 AND id = $2`, [n.tenant_id, id, ctx.adminId]);
    await writeAudit(tx, actor, { action: 'payment_notification.verify', entity: 'payment_notification', entityId: id, after: { paymentId: res.paymentId } }, meta);
    return res;
  });
  invalidateClientAuthCache();
  sendInBackground(r.outbox);
  if (r.receiptId) await enqueue(QUEUES.pdfInvoice, { tenantId: n.tenant_id, kind: 'receipt', id: r.receiptId });
  return { paymentId: r.paymentId };
}

export async function rejectPaymentNotification(ctx: AdminTxCtx, id: string, note: string, meta: RequestMeta) {
  await withAdmin(ctx, async (tx) => {
    const n = await maybeOne<{ tenant_id: string; status: string }>(tx, 'SELECT tenant_id, status FROM app.payment_notifications WHERE id = $1 FOR UPDATE', [id]);
    if (!n) throw notFound('Payment notification');
    if (n.status !== 'pending') throw conflict('ALREADY_HANDLED', 'This notification was already handled.');
    await exec(tx, `UPDATE app.payment_notifications SET status = 'rejected', note = $3, handled_by = $4, handled_at = now()
                     WHERE tenant_id = $1 AND id = $2`, [n.tenant_id, id, note, ctx.adminId]);
    await writeAudit(tx, adminActor(ctx.adminId, n.tenant_id), { action: 'payment_notification.reject', entity: 'payment_notification', entityId: id, reason: note }, meta);
  });
}
