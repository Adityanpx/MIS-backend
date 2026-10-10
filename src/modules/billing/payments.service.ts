import { exec, many, maybeOne, one } from '../../db/sql';
import { withAdmin, type AdminTxCtx, type Tx } from '../../db/tenant';
import { enqueue } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { formatDisplayDate, todayIST } from '../../lib/dates';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { D, money } from '../../lib/money';
import type { RequestMeta } from '../../lib/request-meta';
import { invalidateClientAuthCache } from '../../middleware/auth-client';
import { CASH_269ST_LIMIT } from '../../shared/constants';
import type { OfflinePaymentMode } from '../../shared/enums';
import { formatMoney } from '../../shared/format';
import { adminActor, writeAudit, type AuditActor } from '../audit/audit.service';
import { billingKey, storage } from '../files/storage';
import { evaluateTenant } from '../lifecycle/lifecycle.service';
import { sendInBackground } from '../notifications/email.service';
import { loadBillingConfig, lockTenantBilling, type BillingConfig } from './billing-config';
import { notifyClientBilling, notifySuperAdmins } from './billing-notify';
import { addCreditEntry } from './credit';
import { recomputeInvoice } from './invoice-totals';
import { createManualInvoice } from './invoices.service';
import { insertAllocations, planAllocations, settleAppliedPayment, unsettlePayment } from './payments.core';

export interface OfflinePaymentInput {
  clientId: string; mode: OfflinePaymentMode; amount: string; paymentDate: string; reference?: string; bank?: string;
  chequeDate?: string; remarks?: string; allocations?: Array<{ invoiceId: string; amount: string }>; overrideReason?: string;
  paymentNotificationId?: string;
}

/** After commit: receipt PDF, refreshed payment links, auth cache, emails. */
async function afterPayment(tenantId: string, r: { receiptId?: string | null; invoiceIds: string[]; outbox: Array<string | null> }) {
  invalidateClientAuthCache();
  sendInBackground(r.outbox);
  if (r.receiptId) await enqueue(QUEUES.pdfInvoice, { tenantId, kind: 'receipt', id: r.receiptId });
  for (const invoiceId of r.invoiceIds) {
    await enqueue(QUEUES.razorpayLinkCreate, { tenantId, invoiceId, then: 'pdf' }, { singletonKey: `rzp-link:${invoiceId}` });
  }
}

/** Inner body, also used by "verify payment notification". Caller holds lockTenantBilling. */
export async function recordOfflinePaymentTx(
  tx: Tx, input: OfflinePaymentInput, cfg: BillingConfig, actor: AuditActor, meta?: RequestMeta,
) {
  const today = todayIST();
  const tenantId = input.clientId;
  if (input.paymentDate > today) throw unprocessable('PAYMENT_DATE_IN_FUTURE', 'The payment date cannot be in the future.');
  // OFF-03 / CMP-04: cash from one client on one day ≥ ₹2,00,000 needs a typed override reason.
  if (input.mode === 'cash') {
    const { sum } = await one<{ sum: string }>(
      tx,
      `SELECT coalesce(sum(amount), 0) AS sum FROM app.payments
        WHERE tenant_id = $1 AND mode = 'cash' AND payment_date = $2 AND status <> 'reversed'`,
      [tenantId, input.paymentDate],
    );
    if (D(sum).plus(input.amount).gte(CASH_269ST_LIMIT) && !input.overrideReason) {
      throw unprocessable('CASH_LIMIT_269ST',
        `Cash received from this client on this day would be ${formatMoney(money(D(sum).plus(input.amount)))}. This may breach Income Tax Act section 269ST. Give an override reason to continue.`);
    }
  }
  const allocations = await planAllocations(tx, tenantId, input.amount, input.allocations);
  const status = input.mode === 'cheque' ? 'pending_clearance' : 'applied';
  const { id } = await one<{ id: string }>(
    tx,
    `INSERT INTO app.payments (tenant_id, mode, amount, payment_date, reference, bank, cheque_date, status, source, remarks,
                               override_reason, payment_notification_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [tenantId, input.mode, money(input.amount), input.paymentDate, input.reference ?? null, input.bank ?? null, input.chequeDate ?? null,
      status, input.paymentNotificationId ? 'client_notification' : 'manual', input.remarks ?? null, input.overrideReason ?? null,
      input.paymentNotificationId ?? null, actor.actorId],
  );
  await insertAllocations(tx, tenantId, id, allocations);
  await writeAudit(tx, actor, {
    action: 'payment.record', entity: 'payment', entityId: id, after: { ...input, allocations, status }, reason: input.overrideReason ?? null,
  }, meta);
  let settled: { receiptId: string | null; invoiceIds: string[]; outbox: Array<string | null> } = { receiptId: null, invoiceIds: [], outbox: [] };
  if (status === 'applied') settled = await settleAppliedPayment(tx, tenantId, id, cfg, actor, today);
  else settled.invoiceIds = allocations.map((a) => a.invoiceId).filter((x): x is string => !!x);
  const sa = await notifySuperAdmins(tx, {
    code: 'N-S01', title: `Payment ${status === 'applied' ? 'recorded' : 'recorded (cheque pending)'}: ${formatMoney(input.amount)}`,
    body: `${input.mode.toUpperCase()} ${input.reference ?? ''} on ${formatDisplayDate(input.paymentDate)}.`,
    link: `/payments/${id}`, clientId: tenantId, dedupeKey: `N-S01:${id}`,
  });
  const ev = await evaluateTenant(tx, tenantId, { actor, cause: 'payment', note: `Payment ${input.mode}` });
  return { paymentId: id, ...settled, outbox: [...settled.outbox, ...sa, ...ev.outbox] };
}

export async function recordOfflinePayment(ctx: AdminTxCtx, input: OfflinePaymentInput, meta: RequestMeta) {
  const r = await withAdmin(ctx, async (tx) => {
    const c = await maybeOne(tx, `SELECT 1 FROM app.clients WHERE id = $1 AND status <> 'deleted'`, [input.clientId]);
    if (!c) throw notFound('Client');
    await lockTenantBilling(tx, input.clientId);
    const cfg = await loadBillingConfig(tx);
    return recordOfflinePaymentTx(tx, input, cfg, adminActor(ctx.adminId, input.clientId), meta);
  });
  await afterPayment(input.clientId, r);
  return getPayment(ctx, r.paymentId);
}

// ------------------------------------------------------------------ reads
const PAYMENT_COLS = `p.id, p.tenant_id AS "clientId", c.display_name AS "clientName", p.mode, p.amount, p.payment_date AS "paymentDate",
  p.reference, p.bank, p.cheque_date AS "chequeDate", p.status, p.source, p.method, p.gateway_fee AS "gatewayFee",
  p.needs_review AS "needsReview", p.review_note AS "reviewNote", p.remarks, p.override_reason AS "overrideReason",
  p.cleared_at AS "clearedAt", p.bounced_at AS "bouncedAt", p.bounce_reason AS "bounceReason", p.reversed_at AS "reversedAt",
  p.reverse_reason AS "reverseReason", p.proof_key IS NOT NULL AS "proofUploaded", p.created_at AS "createdAt",
  (SELECT r.id FROM app.receipts r WHERE r.tenant_id = p.tenant_id AND r.payment_id = p.id LIMIT 1) AS "receiptId",
  (SELECT r.number FROM app.receipts r WHERE r.tenant_id = p.tenant_id AND r.payment_id = p.id LIMIT 1) AS "receiptNo"`;

export async function paymentDetail(tx: Tx, tenantId: string | null, id: string) {
  const p = await maybeOne<{ clientId: string } & Record<string, unknown>>(
    tx, `SELECT ${PAYMENT_COLS} FROM app.payments p JOIN app.clients c ON c.id = p.tenant_id
          WHERE p.id = $1 AND ($2::uuid IS NULL OR p.tenant_id = $2)`, [id, tenantId]);
  if (!p) throw notFound('Payment');
  const allocations = await many(tx,
    `SELECT a.invoice_id AS "invoiceId", i.number AS "invoiceNo", a.amount FROM app.payment_allocations a
       LEFT JOIN app.invoices i ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
      WHERE a.tenant_id = $1 AND a.payment_id = $2`, [p.clientId, id]);
  return { ...p, allocations };
}
export async function getPayment(ctx: AdminTxCtx, id: string) {
  return withAdmin(ctx, (tx) => paymentDetail(tx, null, id));
}
export async function listPayments(
  ctx: AdminTxCtx,
  q: { page: number; pageSize: number; clientId?: string; mode?: string; status?: string; from?: string; to?: string; needsReview?: boolean },
) {
  return withAdmin(ctx, async (tx) => {
    const where = `($1::uuid IS NULL OR p.tenant_id = $1) AND ($2::text IS NULL OR p.mode = $2) AND ($3::text IS NULL OR p.status = $3)
       AND ($4::date IS NULL OR p.payment_date >= $4) AND ($5::date IS NULL OR p.payment_date <= $5)
       AND ($6::boolean IS NULL OR p.needs_review = $6)`;
    const params = [q.clientId ?? null, q.mode ?? null, q.status ?? null, q.from ?? null, q.to ?? null, q.needsReview ?? null];
    const { total } = await one<{ total: number }>(tx, `SELECT count(*) AS total FROM app.payments p WHERE ${where}`, params);
    const items = await many(tx, `SELECT ${PAYMENT_COLS} FROM app.payments p JOIN app.clients c ON c.id = p.tenant_id
      WHERE ${where} ORDER BY p.payment_date DESC, p.created_at DESC LIMIT $7 OFFSET $8`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    return { items, total };
  });
}

// ------------------------------------------------------------------ cheque clear / bounce (OFF-02), reversal (OFF-05)
async function lockPayment(tx: Tx, id: string) {
  const p = await maybeOne<{ tenant_id: string; status: string; mode: string; amount: string; reference: string | null }>(
    tx, 'SELECT tenant_id, status, mode, amount, reference FROM app.payments WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw notFound('Payment');
  return p;
}

export async function clearCheque(ctx: AdminTxCtx, id: string, clearedOn: string, meta: RequestMeta) {
  const today = todayIST();
  if (clearedOn > today) throw unprocessable('DATE_IN_FUTURE', 'The clearing date cannot be in the future.');
  const r = await withAdmin(ctx, async (tx) => {
    const p = await lockPayment(tx, id);
    if (p.mode !== 'cheque' || p.status !== 'pending_clearance') throw conflict('NOT_PENDING_CHEQUE', 'Only a cheque pending clearance can be cleared.');
    await lockTenantBilling(tx, p.tenant_id);
    const cfg = await loadBillingConfig(tx);
    const actor = adminActor(ctx.adminId, p.tenant_id);
    // Balances may have changed since the cheque was recorded: cap each allocation, the rest becomes credit.
    const allocs = await many<{ id: string; invoice_id: string | null; amount: string; balance: string | null }>(
      tx,
      `SELECT a.id, a.invoice_id, a.amount, i.balance FROM app.payment_allocations a
         LEFT JOIN app.invoices i ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
        WHERE a.tenant_id = $1 AND a.payment_id = $2`,
      [p.tenant_id, id],
    );
    let toCredit = D(0);
    for (const a of allocs) {
      if (!a.invoice_id) continue;
      const cap = D(a.balance ?? '0');
      if (D(a.amount).gt(cap)) {
        toCredit = toCredit.plus(D(a.amount).minus(cap));
        if (cap.lte(0)) await exec(tx, 'DELETE FROM app.payment_allocations WHERE tenant_id = $1 AND id = $2', [p.tenant_id, a.id]);
        else await exec(tx, 'UPDATE app.payment_allocations SET amount = $3 WHERE tenant_id = $1 AND id = $2', [p.tenant_id, a.id, money(cap)]);
      }
    }
    if (toCredit.gt(0)) await insertAllocations(tx, p.tenant_id, id, [{ invoiceId: null, amount: money(toCredit) }]);
    await exec(tx, `UPDATE app.payments SET status = 'applied', cleared_at = ($3::date)::timestamptz WHERE tenant_id = $1 AND id = $2`,
      [p.tenant_id, id, clearedOn]);
    const settled = await settleAppliedPayment(tx, p.tenant_id, id, cfg, actor, today);
    await writeAudit(tx, actor, { action: 'payment.cheque_cleared', entity: 'payment', entityId: id, after: { clearedOn } }, meta);
    const ev = await evaluateTenant(tx, p.tenant_id, { actor, cause: 'payment', note: 'Cheque cleared' });
    return { tenantId: p.tenant_id, ...settled, outbox: [...settled.outbox, ...ev.outbox] };
  });
  await afterPayment(r.tenantId, r);
  return getPayment(ctx, id);
}

/** OFF-02/E16: bounce → nothing applied, pause ends, the clock resumes; optional bounce charge invoice; N-B09. */
export async function bounceCheque(
  ctx: AdminTxCtx, id: string, input: { bouncedOn: string; reason: string; chargeAmount?: string }, meta: RequestMeta,
) {
  const today = todayIST();
  const r = await withAdmin(ctx, async (tx) => {
    const p = await lockPayment(tx, id);
    if (p.mode !== 'cheque' || !['pending_clearance', 'applied'].includes(p.status)) {
      throw conflict('NOT_BOUNCEABLE', 'Only a pending or cleared cheque can be marked as bounced.');
    }
    await lockTenantBilling(tx, p.tenant_id);
    const cfg = await loadBillingConfig(tx);
    const actor = adminActor(ctx.adminId, p.tenant_id);
    await exec(tx,
      `UPDATE app.payments SET status = 'bounced', bounced_at = ($3::date)::timestamptz, bounce_reason = $4 WHERE tenant_id = $1 AND id = $2`,
      [p.tenant_id, id, input.bouncedOn, input.reason]);
    const invoiceIds = await unsettlePayment(tx, p.tenant_id, id, cfg, actor, today, p.status === 'applied');
    const numbers = await many<{ number: string | null }>(
      tx, 'SELECT number FROM app.invoices WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [p.tenant_id, invoiceIds]);
    await writeAudit(tx, actor, { action: 'payment.cheque_bounced', entity: 'payment', entityId: id, after: input, reason: input.reason }, meta);
    const outbox = await notifyClientBilling(tx, {
      tenantId: p.tenant_id, code: 'N-B09', title: `Cheque ${p.reference ?? ''} bounced`, body: input.reason,
      vars: { reference: p.reference ?? '', amount: formatMoney(p.amount), reason: input.reason, settles: numbers.map((n) => n.number).join(', ') },
      dedupeKey: `N-B09:${id}`,
    });
    const ev = await evaluateTenant(tx, p.tenant_id, { actor, cause: 'payment', note: 'Cheque bounced' });
    return { tenantId: p.tenant_id, invoiceIds, outbox: [...outbox, ...ev.outbox] };
  });
  await afterPayment(r.tenantId, { ...r, receiptId: null });
  if (input.chargeAmount) {
    await createManualInvoice(ctx, {
      clientId: r.tenantId, issueNow: true,
      lines: [{ description: `Cheque return charges – cheque ${input.reason ? `(${input.reason})` : ''}`.trim(), qty: 1, rate: input.chargeAmount }],
    }, meta);
  }
  return getPayment(ctx, id);
}

/** OFF-05: corrections after the fact are reversal entries (the original stays visible). */
export async function reversePayment(ctx: AdminTxCtx, id: string, reason: string, meta: RequestMeta) {
  const today = todayIST();
  const r = await withAdmin(ctx, async (tx) => {
    const p = await lockPayment(tx, id);
    if (!['applied', 'pending_clearance'].includes(p.status)) throw conflict('NOT_REVERSIBLE', 'This payment is already bounced or reversed.');
    if (p.mode === 'razorpay') throw conflict('NOT_REVERSIBLE', 'Online payments are refunded in Razorpay (P1: record a credit refund instead).');
    await lockTenantBilling(tx, p.tenant_id);
    const cfg = await loadBillingConfig(tx);
    const actor = adminActor(ctx.adminId, p.tenant_id);
    await exec(tx, `UPDATE app.payments SET status = 'reversed', reversed_at = now(), reverse_reason = $3 WHERE tenant_id = $1 AND id = $2`,
      [p.tenant_id, id, reason]);
    const invoiceIds = await unsettlePayment(tx, p.tenant_id, id, cfg, actor, today, p.status === 'applied');
    await writeAudit(tx, actor, { action: 'payment.reverse', entity: 'payment', entityId: id, reason }, meta);
    const ev = await evaluateTenant(tx, p.tenant_id, { actor, cause: 'payment', note: 'Payment reversed' });
    return { tenantId: p.tenant_id, invoiceIds, outbox: ev.outbox };
  });
  await afterPayment(r.tenantId, { ...r, receiptId: null });
  return getPayment(ctx, id);
}

/** OFF-04: re-split an applied payment across open invoices (same total). */
export async function reallocate(ctx: AdminTxCtx, id: string, allocations: Array<{ invoiceId: string; amount: string }>, meta: RequestMeta) {
  const today = todayIST();
  const r = await withAdmin(ctx, async (tx) => {
    const p = await lockPayment(tx, id);
    if (p.status !== 'applied') throw conflict('NOT_APPLIED', 'Only an applied payment can be re-allocated.');
    await lockTenantBilling(tx, p.tenant_id);
    const cfg = await loadBillingConfig(tx);
    const actor = adminActor(ctx.adminId, p.tenant_id);
    const before = await many<{ invoice_id: string | null; amount: string }>(
      tx, 'SELECT invoice_id, amount FROM app.payment_allocations WHERE tenant_id = $1 AND payment_id = $2', [p.tenant_id, id]);
    // Temporarily take the payment out (so its own allocations count as open balance), then re-plan.
    await exec(tx, `UPDATE app.payments SET status = 'reversed' WHERE tenant_id = $1 AND id = $2`, [p.tenant_id, id]);
    const oldInvoices = await unsettlePayment(tx, p.tenant_id, id, cfg, actor, today, true);
    await exec(tx, 'DELETE FROM app.payment_allocations WHERE tenant_id = $1 AND payment_id = $2', [p.tenant_id, id]);
    const plan = await planAllocations(tx, p.tenant_id, p.amount, allocations);
    await insertAllocations(tx, p.tenant_id, id, plan);
    await exec(tx, `UPDATE app.payments SET status = 'applied' WHERE tenant_id = $1 AND id = $2`, [p.tenant_id, id]);
    const touched = [...new Set([...oldInvoices, ...plan.map((a) => a.invoiceId).filter((x): x is string => !!x)])];
    for (const inv of touched) {
      await recomputeInvoice(tx, p.tenant_id, inv, { tolerance: cfg.tax.closeTolerance, today, actor });
    }
    const credit = plan.filter((a) => !a.invoiceId).reduce((s, a) => s.plus(a.amount), D(0));
    if (credit.gt(0)) {
      await addCreditEntry(tx, p.tenant_id, { kind: 'excess_payment', amount: credit, date: today, refType: 'payment', refId: id, by: actor.actorId });
    }
    await writeAudit(tx, actor, { action: 'payment.reallocate', entity: 'payment', entityId: id, before, after: plan }, meta);
    const ev = await evaluateTenant(tx, p.tenant_id, { actor, cause: 'payment', note: 'Payment re-allocated' });
    return { tenantId: p.tenant_id, invoiceIds: touched, outbox: ev.outbox };
  });
  await afterPayment(r.tenantId, { ...r, receiptId: null });
  return getPayment(ctx, id);
}

/** OFF-01 proof upload (image/PDF ≤ 5 MB) under the billing prefix. */
export async function setPaymentProof(ctx: AdminTxCtx, id: string, file: { ext: string; mime: string; buffer: Buffer }, meta: RequestMeta) {
  const tenantId = await withAdmin(ctx, async (tx) => (await lockPayment(tx, id)).tenant_id);
  const key = billingKey(tenantId, 'proofs', `${id}.${file.ext}`);
  await storage.put(key, file.buffer, file.mime);
  await withAdmin(ctx, async (tx) => {
    await exec(tx, 'UPDATE app.payments SET proof_key = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, id, key]);
    await writeAudit(tx, adminActor(ctx.adminId, tenantId), { action: 'payment.proof_upload', entity: 'payment', entityId: id }, meta);
  });
  return getPayment(ctx, id);
}

/** Marks a Razorpay payment flagged for review as reviewed. */
export async function markReviewed(ctx: AdminTxCtx, id: string, note: string, meta: RequestMeta) {
  await withAdmin(ctx, async (tx) => {
    const p = await lockPayment(tx, id);
    await exec(tx, 'UPDATE app.payments SET needs_review = false, review_note = $3 WHERE tenant_id = $1 AND id = $2', [p.tenant_id, id, note]);
    await writeAudit(tx, adminActor(ctx.adminId, p.tenant_id), { action: 'payment.reviewed', entity: 'payment', entityId: id, reason: note }, meta);
  });
  return getPayment(ctx, id);
}
