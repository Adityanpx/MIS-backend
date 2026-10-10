import { D, Decimal, money } from '../../lib/money';

export interface OpenInvoiceForAlloc { id: string; balance: string; dueDate: string | null; issueDate: string | null }
export interface Allocation { invoiceId: string | null; amount: string } // null = client credit

/** Oldest due date first (then oldest issue date). The remainder becomes client credit. */
export function allocateOldestFirst(amount: string, open: OpenInvoiceForAlloc[]): Allocation[] {
  let left = D(amount);
  const out: Allocation[] = [];
  const sorted = [...open].sort((a, b) => `${a.dueDate ?? '9999'}${a.issueDate ?? ''}`.localeCompare(`${b.dueDate ?? '9999'}${b.issueDate ?? ''}`));
  for (const inv of sorted) {
    if (left.lte(0)) break;
    const take = Decimal.min(left, D(inv.balance));
    if (take.lte(0)) continue;
    out.push({ invoiceId: inv.id, amount: money(take) });
    left = left.minus(take);
  }
  if (left.gt(0)) out.push({ invoiceId: null, amount: money(left) });
  return out;
}
