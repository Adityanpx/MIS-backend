import { exec, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import type { ISODate } from '../../lib/dates';
import { conflict } from '../../lib/errors';
import { D, Decimal, money } from '../../lib/money';
import type { AuditActor } from '../audit/audit.service';
import { recomputeInvoice } from './invoice-totals';

export type CreditKind = 'excess_payment' | 'credit_note' | 'applied' | 'refunded' | 'reversal' | 'adjustment';

export async function creditBalance(tx: Tx, tenantId: string): Promise<string> {
  const r = await one<{ b: string }>(
    tx, 'SELECT coalesce(sum(amount), 0) AS b FROM app.client_credit_ledger WHERE tenant_id = $1', [tenantId]);
  return money(r.b);
}

export async function addCreditEntry(
  tx: Tx, tenantId: string, e: { kind: CreditKind; amount: Decimal.Value; date: ISODate; refType?: string; refId?: string; by: string | null },
): Promise<void> {
  if (D(e.amount).eq(0)) return;
  await exec(
    tx,
    `INSERT INTO app.client_credit_ledger (tenant_id, entry_date, kind, amount, ref_type, ref_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, e.date, e.kind, money(e.amount), e.refType ?? null, e.refId ?? null, e.by],
  );
}

/**
 * CRD-02: uses the client's credit on an open invoice ("Advance adjusted").
 * Applies min(credit, invoice balance, maxAmount). Call after lockTenantBilling().
 */
export async function applyCreditToInvoice(
  tx: Tx,
  tenantId: string,
  invoiceId: string,
  o: { maxAmount?: string; tolerance: string; today: ISODate; actor: AuditActor },
): Promise<string> {
  const inv = await one<{ balance: string; status: string }>(
    tx, 'SELECT balance, status FROM app.invoices WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, invoiceId]);
  if (!['issued', 'partially_paid', 'overdue'].includes(inv.status)) {
    throw conflict('INVOICE_NOT_OPEN', 'Credit can only be applied to an issued, unpaid invoice.');
  }
  const available = D(await creditBalance(tx, tenantId));
  let amount = Decimal.min(available, D(inv.balance));
  if (o.maxAmount) amount = Decimal.min(amount, D(o.maxAmount));
  if (amount.lte(0)) return '0.00';
  await exec(tx, 'UPDATE app.invoices SET credit_applied = credit_applied + $3 WHERE tenant_id = $1 AND id = $2',
    [tenantId, invoiceId, money(amount)]);
  await addCreditEntry(tx, tenantId, {
    kind: 'applied', amount: amount.neg(), date: o.today, refType: 'invoice', refId: invoiceId, by: o.actor.actorId,
  });
  await recomputeInvoice(tx, tenantId, invoiceId, { tolerance: o.tolerance, today: o.today, actor: o.actor });
  return money(amount);
}
