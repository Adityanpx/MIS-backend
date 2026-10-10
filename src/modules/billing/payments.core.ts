import { exec, many, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { formatDisplayDate, type ISODate } from '../../lib/dates';
import { unprocessable } from '../../lib/errors';
import { D, money } from '../../lib/money';
import { formatMoney } from '../../shared/format';
import type { AuditActor } from '../audit/audit.service';
import { allocateOldestFirst, type Allocation } from './allocation';
import type { BillingConfig } from './billing-config';
import { notifyClientBilling } from './billing-notify';
import { addCreditEntry } from './credit';
import { recomputeInvoice } from './invoice-totals';
import { nextDocNumber } from './numbering';

export async function openInvoices(tx: Tx, tenantId: string) {
  return many<{ id: string; balance: string; dueDate: string | null; issueDate: string | null }>(
    tx,
    `SELECT id, balance, due_date AS "dueDate", issue_date AS "issueDate" FROM app.invoices
      WHERE tenant_id = $1 AND status IN ('issued', 'partially_paid', 'overdue') AND balance > 0`,
    [tenantId],
  );
}

/**
 * Validates requested allocations (or builds oldest-first ones) for `amount`.
 * Requested invoices must be open invoices OF THIS TENANT (a foreign id behaves like a missing one: 404-style error).
 */
export async function planAllocations(tx: Tx, tenantId: string, amount: string, requested?: Array<{ invoiceId: string; amount: string }>): Promise<Allocation[]> {
  const open = await openInvoices(tx, tenantId);
  if (!requested || requested.length === 0) return allocateOldestFirst(amount, open);
  let sum = D(0);
  const out: Allocation[] = [];
  for (const r of requested) {
    const inv = open.find((o) => o.id === r.invoiceId);
    if (!inv) throw unprocessable('INVOICE_NOT_OPEN', 'An allocation refers to an invoice that is not open for this client.', { invoiceId: r.invoiceId });
    if (D(r.amount).gt(inv.balance)) throw unprocessable('ALLOCATION_EXCEEDS_BALANCE', 'An allocation is larger than the invoice balance.', { invoiceId: r.invoiceId });
    sum = sum.plus(r.amount);
    out.push({ invoiceId: r.invoiceId, amount: money(r.amount) });
  }
  if (sum.gt(amount)) throw unprocessable('ALLOCATION_EXCEEDS_PAYMENT', 'Allocations are larger than the payment amount.');
  if (D(amount).minus(sum).gt(0)) out.push({ invoiceId: null, amount: money(D(amount).minus(sum)) });
  return out;
}

export async function insertAllocations(tx: Tx, tenantId: string, paymentId: string, allocations: Allocation[]): Promise<void> {
  for (const a of allocations) {
    await exec(tx, 'INSERT INTO app.payment_allocations (tenant_id, payment_id, invoice_id, amount) VALUES ($1, $2, $3, $4)',
      [tenantId, paymentId, a.invoiceId, a.amount]);
  }
}

/**
 * The payment is now APPLIED: refresh the invoices it touches, move the unallocated part to credit,
 * issue the receipt (RCT-01) and queue N-B07. Returns the receipt id and the touched invoice ids.
 */
export async function settleAppliedPayment(
  tx: Tx, tenantId: string, paymentId: string, cfg: BillingConfig, actor: AuditActor, today: ISODate,
): Promise<{ receiptId: string; invoiceIds: string[]; outbox: Array<string | null> }> {
  const p = await one<{ amount: string; mode: string; reference: string | null; payment_date: string }>(
    tx, 'SELECT amount, mode, reference, payment_date FROM app.payments WHERE tenant_id = $1 AND id = $2', [tenantId, paymentId]);
  const allocs = await many<{ invoice_id: string | null; amount: string; number: string | null }>(
    tx,
    `SELECT a.invoice_id, a.amount, i.number FROM app.payment_allocations a
       LEFT JOIN app.invoices i ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
      WHERE a.tenant_id = $1 AND a.payment_id = $2`,
    [tenantId, paymentId],
  );
  const invoiceIds = [...new Set(allocs.map((a) => a.invoice_id).filter((x): x is string => !!x))];
  for (const id of invoiceIds) await recomputeInvoice(tx, tenantId, id, { tolerance: cfg.tax.closeTolerance, today, actor });
  const toCredit = allocs.filter((a) => !a.invoice_id).reduce((s, a) => s.plus(a.amount), D(0));
  await addCreditEntry(tx, tenantId, { kind: 'excess_payment', amount: toCredit, date: today, refType: 'payment', refId: paymentId, by: actor.actorId });
  const { number } = await nextDocNumber(tx, 'receipt', today, cfg.numbering);
  const { id: receiptId } = await one<{ id: string }>(
    tx, 'INSERT INTO app.receipts (tenant_id, number, payment_id, receipt_date) VALUES ($1, $2, $3, $4) RETURNING id',
    [tenantId, number, paymentId, today]);
  const settles = allocs.map((a) => `${a.number ?? 'credit balance'} ${formatMoney(a.amount)}`).join(', ');
  const outbox = await notifyClientBilling(tx, {
    tenantId, code: 'N-B07', title: `Payment received: ${formatMoney(p.amount)}`, body: `Receipt ${number}. Settles: ${settles}.`,
    link: '/billing/payments',
    vars: {
      receiptNo: number, amount: formatMoney(p.amount), mode: p.mode.toUpperCase(), reference: p.reference ? ` – ${p.reference}` : '',
      paymentDate: formatDisplayDate(p.payment_date), settles,
    },
    dedupeKey: `N-B07:${paymentId}`,
  });
  return { receiptId, invoiceIds, outbox };
}

/** Re-opens the invoices of a payment that stopped counting (bounced/reversed) and removes its credit part. */
export async function unsettlePayment(
  tx: Tx, tenantId: string, paymentId: string, cfg: BillingConfig, actor: AuditActor, today: ISODate, wasApplied: boolean,
): Promise<string[]> {
  const allocs = await many<{ invoice_id: string | null; amount: string }>(
    tx, 'SELECT invoice_id, amount FROM app.payment_allocations WHERE tenant_id = $1 AND payment_id = $2', [tenantId, paymentId]);
  const invoiceIds = [...new Set(allocs.map((a) => a.invoice_id).filter((x): x is string => !!x))];
  for (const id of invoiceIds) await recomputeInvoice(tx, tenantId, id, { tolerance: cfg.tax.closeTolerance, today, actor });
  const credit = allocs.filter((a) => !a.invoice_id).reduce((s, a) => s.plus(a.amount), D(0));
  if (wasApplied && credit.gt(0)) {
    const { b } = await one<{ b: string }>(tx, 'SELECT coalesce(sum(amount), 0) AS b FROM app.client_credit_ledger WHERE tenant_id = $1', [tenantId]);
    if (D(b).lt(credit)) {
      throw unprocessable('CREDIT_ALREADY_USED', 'Part of this payment was kept as credit and has already been used. Cancel the credit use first.');
    }
    await addCreditEntry(tx, tenantId, { kind: 'reversal', amount: credit.neg(), date: today, refType: 'payment', refId: paymentId, by: actor.actorId });
  }
  return invoiceIds;
}
