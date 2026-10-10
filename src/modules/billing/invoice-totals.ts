import { exec, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import type { ISODate } from '../../lib/dates';
import { D, money } from '../../lib/money';
import { writeAudit, type AuditActor } from '../audit/audit.service';

export interface RecomputeResult {
  invoiceId: string; prevStatus: string; status: string; prevBalance: string; balance: string; overflow: string;
}
interface InvRow {
  id: string; status: string; total: string; credit_applied: string; excess_to_credit: string; balance: string;
  due_date: string | null; tolerance_written_off: string; number: string | null;
}
const FROZEN = ['draft', 'cancelled', 'written_off'];

export async function recomputeInvoice(
  tx: Tx,
  tenantId: string,
  invoiceId: string,
  opts: { tolerance: string; today: ISODate; actor: AuditActor; overflowKind?: 'credit_note' | 'adjustment' },
): Promise<RecomputeResult> {
  const inv = await one<InvRow>(
    tx,
    `SELECT id, status, total, credit_applied, excess_to_credit, balance, due_date, tolerance_written_off, number
       FROM app.invoices WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, invoiceId],
  );
  const s = await one<{ paid: string; tds: string; cn: string }>(
    tx,
    `SELECT
       coalesce((SELECT sum(a.amount) FROM app.payment_allocations a
                   JOIN app.payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
                  WHERE a.tenant_id = $1 AND a.invoice_id = $2 AND p.status = 'applied'), 0) AS paid,
       coalesce((SELECT sum(t.amount) FROM app.tds_entries t WHERE t.tenant_id = $1 AND t.invoice_id = $2 AND t.verified), 0) AS tds,
       coalesce((SELECT sum(c.total) FROM app.credit_notes c WHERE c.tenant_id = $1 AND c.invoice_id = $2), 0) AS cn`,
    [tenantId, invoiceId],
  );
  let excess = D(inv.excess_to_credit);
  let raw = D(inv.total).minus(s.paid).minus(s.tds).minus(s.cn).minus(inv.credit_applied).plus(excess);
  let overflow = D(0);
  if (raw.lt(0) && inv.status !== 'draft') {
    overflow = raw.neg();
    excess = excess.plus(overflow);
    raw = D(0);
    await exec(
      tx,
      `INSERT INTO app.client_credit_ledger (tenant_id, entry_date, kind, amount, ref_type, ref_id, created_by)
       VALUES ($1, $2, $3, $4, 'invoice', $5, $6)`,
      [tenantId, opts.today, opts.overflowKind ?? 'adjustment', money(overflow), invoiceId, opts.actor.actorId],
    );
  }
  const settled = D(s.paid).plus(s.tds).plus(inv.credit_applied).plus(s.cn);
  const writeOff = raw.gt(0) && raw.lte(opts.tolerance) && settled.gt(0) && !FROZEN.includes(inv.status) ? raw : D(0);
  const balance = raw.minus(writeOff);

  let status = inv.status;
  if (!FROZEN.includes(inv.status)) {
    if (balance.lte(0)) status = 'paid';
    else if (inv.due_date && inv.due_date < opts.today) status = 'overdue';
    else if (settled.gt(0)) status = 'partially_paid';
    else status = 'issued';
  }
  await exec(
    tx,
    `UPDATE app.invoices SET paid = $3, tds = $4, credit_noted = $5, excess_to_credit = $6, tolerance_written_off = $7,
            balance = $8, status = $9
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, invoiceId, money(s.paid), money(s.tds), money(s.cn), money(excess), money(writeOff), money(balance), status],
  );
  if (writeOff.gt(0) && D(inv.tolerance_written_off).eq(0)) {
    await writeAudit(tx, opts.actor, {
      action: 'invoice.tolerance_writeoff', entity: 'invoice', entityId: invoiceId,
      after: { number: inv.number, writtenOff: money(writeOff) },
    });
  }
  return {
    invoiceId, prevStatus: inv.status, status, prevBalance: inv.balance, balance: money(balance), overflow: money(overflow),
  };
}

/** Marks issued/partially-paid invoices past their due date as overdue (daily job and lists). */
export async function markOverdue(tx: Tx, tenantId: string, today: ISODate): Promise<number> {
  return exec(
    tx,
    `UPDATE app.invoices SET status = 'overdue'
      WHERE tenant_id = $1 AND status IN ('issued', 'partially_paid') AND due_date < $2 AND balance > 0`,
    [tenantId, today],
  );
}
