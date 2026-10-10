import { many, maybeOne } from '../../../db/sql';
import { withSystem } from '../../../db/tenant';
import { enqueue, registerHandler } from '../../../jobs/boss';
import { QUEUES } from '../../../jobs/queues';
import { todayIST } from '../../../lib/dates';
import { logger } from '../../../lib/logger';
import { formatMoney } from '../../../shared/format';
import { sendInBackground } from '../../notifications/email.service';
import { notifySuperAdmins } from '../billing-notify';
import { notesOf, razorpay } from './gateway';
import { ensurePayLink } from './links';
import { processCapturedPayment } from './process';

/** data: { tenantId, invoiceId, then?: 'pdf' | 'pdf+notify' } */
registerHandler(QUEUES.razorpayLinkCreate, async (data) => {
  const { tenantId, invoiceId, then } = data as { tenantId: string; invoiceId: string; then?: 'pdf' | 'pdf+notify' };
  try {
    await ensurePayLink(tenantId, invoiceId);
  } catch (err) {
    logger.error({ err, invoiceId }, 'Payment link creation failed');
    const outbox = await withSystem((tx) => notifySuperAdmins(tx, {
      code: 'N-S06', title: 'Payment link could not be created', body: `Invoice ${invoiceId}: ${String((err as Error).message).slice(0, 200)}`,
      clientId: tenantId, dedupeKey: `N-S06:link:${invoiceId}:${todayIST()}`, email: true,
    }));
    sendInBackground(outbox);
  }
  if (then) await enqueue(QUEUES.pdfInvoice, { tenantId, kind: 'invoice', id: invoiceId, notify: then === 'pdf+notify' });
});

/** RZP-05 (02:00 IST): recover lost webhooks, flag unmatched payments, refresh/cancel links. */
registerHandler(QUEUES.razorpayReconcile, async () => {
  if (!(await razorpay.configured())) return;
  // 1) Links of open invoices: a paid link whose payment we never recorded.
  const withLinks = await withSystem((tx) => many<{ tenant_id: string; id: string; rzp_link_id: string }>(
    tx, `SELECT tenant_id, id, rzp_link_id FROM app.invoices
          WHERE rzp_link_id IS NOT NULL AND status IN ('issued', 'partially_paid', 'overdue')`));
  for (const inv of withLinks) {
    try {
      const link = await razorpay.fetchLink(inv.rzp_link_id);
      for (const p of link.payments ?? []) {
        if (p.status !== 'captured') continue;
        await processCapturedPayment({
          rzpPaymentId: p.payment_id, amountPaise: p.amount, tenantId: inv.tenant_id, invoiceId: inv.id, method: p.method,
          paidAtUnix: p.created_at ?? Math.floor(Date.now() / 1000), source: 'reconciliation',
        });
      }
    } catch (err) {
      logger.warn({ err, invoiceId: inv.id }, 'Reconciliation: link fetch failed');
    }
  }
  // 2) All captured payments of the last 3 days.
  const now = Math.floor(Date.now() / 1000);
  const payments = (await razorpay.listPayments(now - 3 * 86_400, now)).filter((p) => p.status === 'captured');
  for (const p of payments) {
    // rzp_payment_id is a platform-wide unique key: this lookup intentionally has no tenant filter.
    const known = await withSystem((tx) => maybeOne(tx, 'SELECT 1 FROM app.payments WHERE rzp_payment_id = $1', [p.id]));
    if (known) continue;
    const notes = notesOf(p);
    if (notes.tenantId && notes.invoiceId) {
      const r = await processCapturedPayment({
        rzpPaymentId: p.id, amountPaise: p.amount, tenantId: notes.tenantId, invoiceId: notes.invoiceId, method: p.method,
        paidAtUnix: p.created_at, source: 'reconciliation',
      });
      if (r.status !== 'unknown_invoice') continue;
    }
    const outbox = await withSystem((tx) => notifySuperAdmins(tx, {
      code: 'N-S03', title: 'Unmatched Razorpay payment', body: `${p.id} for ${formatMoney((p.amount / 100).toFixed(2))} could not be matched to an invoice. Record it manually.`,
      dedupeKey: `N-S03:unmatched:${p.id}`, email: true,
    }));
    sendInBackground(outbox);
  }
  // 3) Refresh: open invoices without/with an expiring or stale link; cancel links of closed invoices (ensurePayLink decides).
  const refresh = await withSystem((tx) => many<{ tenant_id: string; id: string }>(
    tx,
    `SELECT tenant_id, id FROM app.invoices
      WHERE (status IN ('issued', 'partially_paid', 'overdue') AND balance > 0 AND number IS NOT NULL)
         OR (rzp_link_id IS NOT NULL AND status IN ('paid', 'cancelled', 'written_off'))`,
  ));
  for (const r of refresh) {
    await enqueue(QUEUES.razorpayLinkCreate, { tenantId: r.tenant_id, invoiceId: r.id }, { singletonKey: `rzp-link:${r.id}` });
  }
  logger.info({ checkedLinks: withLinks.length, payments: payments.length, refreshed: refresh.length }, 'Razorpay reconciliation done');
});
