import { maybeOne } from '../../../db/sql';
import { withSystem } from '../../../db/tenant';
import { enqueue } from '../../../jobs/boss';
import { QUEUES } from '../../../jobs/queues';
import { todayIST } from '../../../lib/dates';
import { D, Decimal, money, round2 } from '../../../lib/money';
import { invalidateClientAuthCache } from '../../../middleware/auth-client';
import { formatMoney } from '../../../shared/format';
import { systemActor, writeAudit } from '../../audit/audit.service';
import { evaluateTenant } from '../../lifecycle/lifecycle.service';
import { sendInBackground } from '../../notifications/email.service';
import type { Allocation } from '../allocation';
import { loadBillingConfig, lockTenantBilling } from '../billing-config';
import { notifySuperAdmins } from '../billing-notify';
import { insertAllocations, openInvoices, settleAppliedPayment } from '../payments.core';

export interface CapturedPayment {
  rzpPaymentId: string; amountPaise: number; tenantId: string; invoiceId: string; method?: string; paidAtUnix: number;
  source: 'razorpay' | 'reconciliation';
}
export type ProcessResult = { status: 'recorded'; paymentId: string } | { status: 'duplicate' } | { status: 'unknown_invoice' };

/** Idempotent: the UNIQUE rzp_payment_id makes a second webhook / reconciliation run a no-op (E12, E13). */
export async function processCapturedPayment(p: CapturedPayment): Promise<ProcessResult> {
  const r = await withSystem(async (tx) => {
    // The invoice must exist IN the tenant named by the (signed) notes.
    const inv = await maybeOne<{ number: string | null; rzp_link_amount: string | null }>(
      tx, 'SELECT number, rzp_link_amount FROM app.invoices WHERE tenant_id = $1 AND id = $2', [p.tenantId, p.invoiceId]);
    if (!inv) return { status: 'unknown_invoice' as const };
    await lockTenantBilling(tx, p.tenantId);
    const cfg = await loadBillingConfig(tx);
    const actor = systemActor(p.tenantId);
    const amount = D(p.amountPaise).div(100);
    const fee = cfg.billing.gatewayFeeMode === 'convenience' && cfg.billing.gatewayFeePct > 0
      ? round2(amount.minus(amount.div(D(1).plus(D(cfg.billing.gatewayFeePct).div(100)))))
      : D(0);
    const mismatch = inv.rzp_link_amount !== null && !amount.eq(inv.rzp_link_amount);
    const needsReview = mismatch || p.source === 'reconciliation';
    const ins = await maybeOne<{ id: string }>(
      tx,
      `INSERT INTO app.payments (tenant_id, mode, amount, payment_date, reference, status, source, rzp_payment_id, method,
                                 gateway_fee, needs_review, review_note)
       VALUES ($1, 'razorpay', $2, $3, $4, 'applied', $5, $4, $6, $7, $8, $9)
       ON CONFLICT (rzp_payment_id) DO NOTHING RETURNING id`,
      [p.tenantId, money(amount), todayIST(new Date(p.paidAtUnix * 1000)), p.rzpPaymentId, p.source, p.method ?? null, money(fee),
        needsReview, mismatch ? `Paid ${money(amount)}, link amount ${inv.rzp_link_amount}` : p.source === 'reconciliation' ? 'Recorded by reconciliation' : null],
    );
    if (!ins) return { status: 'duplicate' as const };
    // This invoice first; anything above its balance becomes client credit (E14).
    const net = amount.minus(fee);
    const target = (await openInvoices(tx, p.tenantId)).find((o) => o.id === p.invoiceId);
    const first = target ? Decimal.min(net, D(target.balance)) : D(0);
    const plan: Allocation[] = [];
    if (first.gt(0)) plan.push({ invoiceId: p.invoiceId, amount: money(first) });
    if (net.minus(first).gt(0)) plan.push({ invoiceId: null, amount: money(net.minus(first)) });
    await insertAllocations(tx, p.tenantId, ins.id, plan);
    const settled = await settleAppliedPayment(tx, p.tenantId, ins.id, cfg, actor, todayIST());
    await writeAudit(tx, actor, {
      action: 'payment.razorpay', entity: 'payment', entityId: ins.id,
      after: { rzpPaymentId: p.rzpPaymentId, amount: money(amount), fee: money(fee), invoiceId: p.invoiceId, source: p.source, mismatch },
    });
    const outbox = [...settled.outbox];
    outbox.push(...await notifySuperAdmins(tx, {
      code: 'N-S01', title: `Online payment received: ${formatMoney(money(amount))}`, body: `Invoice ${inv.number ?? ''} · ${p.rzpPaymentId}`,
      link: `/payments/${ins.id}`, clientId: p.tenantId, dedupeKey: `N-S01:${ins.id}`, email: true,
    }));
    if (needsReview) {
      outbox.push(...await notifySuperAdmins(tx, {
        code: 'N-S03', title: mismatch ? 'Online payment amount mismatch' : 'Payment recorded by reconciliation',
        body: `Invoice ${inv.number ?? ''} · ${p.rzpPaymentId} · ${formatMoney(money(amount))}`,
        link: `/payments/${ins.id}`, clientId: p.tenantId, dedupeKey: `N-S03:${ins.id}`, email: true,
      }));
    }
    const ev = await evaluateTenant(tx, p.tenantId, { actor, cause: 'payment', note: `Razorpay ${p.rzpPaymentId}` });
    outbox.push(...ev.outbox);
    return { status: 'recorded' as const, paymentId: ins.id, receiptId: settled.receiptId, outbox };
  });
  if (r.status !== 'recorded') return r;
  invalidateClientAuthCache();
  sendInBackground(r.outbox);
  await enqueue(QUEUES.pdfInvoice, { tenantId: p.tenantId, kind: 'receipt', id: r.receiptId });
  await enqueue(QUEUES.razorpayLinkCreate, { tenantId: p.tenantId, invoiceId: p.invoiceId, then: 'pdf' }, { singletonKey: `rzp-link:${p.invoiceId}` });
  return { status: 'recorded', paymentId: r.paymentId };
}
