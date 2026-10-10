import { many, maybeOne, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { notFound } from '../../lib/errors';

export const INVOICE_COLS = `
  i.id, i.tenant_id, i.number, i.fy, i.kind, i.issue_date, i.due_date, i.place_of_supply, i.gst_type, i.gst_rate_pct,
  i.taxable, i.cgst, i.sgst, i.igst, i.round_off, i.total, i.paid, i.tds, i.credit_noted, i.credit_applied,
  i.excess_to_credit, i.tolerance_written_off, i.balance, i.status, i.pdf_key, i.rzp_link_url, i.rzp_link_expires_at,
  i.notes, i.cancel_reason, i.created_at, c.display_name AS client_name, c.code AS client_code,
  (SELECT string_agg(DISTINCT p.name, ', ') FROM app.invoice_lines l JOIN app.plants p ON p.tenant_id = l.tenant_id AND p.id = l.plant_id
    WHERE l.tenant_id = i.tenant_id AND l.invoice_id = i.id) AS plant_names`;
export const INVOICE_FROM = 'FROM app.invoices i JOIN app.clients c ON c.id = i.tenant_id';

export interface InvoiceRow {
  id: string; tenant_id: string; number: string | null; fy: string | null; kind: string; issue_date: string | null;
  due_date: string | null; place_of_supply: string | null; gst_type: string | null; gst_rate_pct: string; taxable: string;
  cgst: string; sgst: string; igst: string; round_off: string; total: string; paid: string; tds: string; credit_noted: string;
  credit_applied: string; excess_to_credit: string; tolerance_written_off: string; balance: string; status: string;
  pdf_key: string | null; rzp_link_url: string | null; rzp_link_expires_at: string | null; notes: string | null;
  cancel_reason: string | null; created_at: string; client_name: string; client_code: string; plant_names: string | null;
}
export const toInvoiceDto = (r: InvoiceRow) => ({
  id: r.id, clientId: r.tenant_id, clientName: r.client_name, clientCode: r.client_code, plants: r.plant_names,
  number: r.number, fy: r.fy, kind: r.kind, issueDate: r.issue_date, dueDate: r.due_date, placeOfSupply: r.place_of_supply,
  gstType: r.gst_type, gstRatePct: Number(r.gst_rate_pct), taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst,
  roundOff: r.round_off, total: r.total, paid: r.paid, tds: r.tds, creditNoted: r.credit_noted, advanceAdjusted: r.credit_applied,
  movedToCredit: r.excess_to_credit, writtenOff: r.tolerance_written_off, balance: r.balance, status: r.status,
  pdfReady: !!r.pdf_key, payUrl: r.rzp_link_url, payUrlExpiresAt: r.rzp_link_expires_at, notes: r.notes,
  cancelReason: r.cancel_reason, createdAt: r.created_at,
});
export type InvoiceDto = ReturnType<typeof toInvoiceDto>;

export interface InvoiceFilter {
  tenantId: string | null;              // client side: ALWAYS ctx.tenantId
  status?: string; fy?: string; month?: string; overdueDaysMin?: number; q?: string; includeDrafts?: boolean;
  page: number; pageSize: number;
}
export async function listInvoices(tx: Tx, f: InvoiceFilter) {
  const where = `($1::uuid IS NULL OR i.tenant_id = $1)
     AND ($2::text IS NULL OR i.status = $2)
     AND ($3::text IS NULL OR i.fy = $3)
     AND ($4::text IS NULL OR to_char(i.issue_date, 'YYYY-MM') = $4)
     AND ($5::int IS NULL OR (i.balance > 0 AND i.due_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date - $5))
     AND ($6::text IS NULL OR i.number ILIKE $6 OR c.display_name ILIKE $6 OR c.code ILIKE $6)
     AND ($7::boolean OR i.status <> 'draft')`;
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const params = [f.tenantId, f.status ?? null, f.fy ?? null, f.month ?? null, f.overdueDaysMin ?? null, like, f.includeDrafts ?? false];
  const { total } = await one<{ total: number }>(tx, `SELECT count(*) AS total ${INVOICE_FROM} WHERE ${where}`, params);
  const rows = await many<InvoiceRow>(
    tx,
    `SELECT ${INVOICE_COLS} ${INVOICE_FROM} WHERE ${where}
      ORDER BY i.issue_date DESC NULLS FIRST, i.created_at DESC LIMIT $8 OFFSET $9`,
    [...params, f.pageSize, (f.page - 1) * f.pageSize],
  );
  return { items: rows.map(toInvoiceDto), total };
}

/** One invoice with lines, payments, TDS and credit notes. 404 when it is not in `tenantId` (or a draft for clients). */
export async function invoiceDetail(tx: Tx, tenantId: string | null, id: string, opts: { includeDrafts: boolean }) {
  const r = await maybeOne<InvoiceRow>(
    tx, `SELECT ${INVOICE_COLS} ${INVOICE_FROM} WHERE i.id = $1 AND ($2::uuid IS NULL OR i.tenant_id = $2)`, [id, tenantId]);
  if (!r || (!opts.includeDrafts && r.status === 'draft')) throw notFound('Invoice');
  const t = r.tenant_id;
  const lines = await many(tx,
    `SELECT id, plant_id AS "plantId", subscription_id AS "subscriptionId", billing_year AS "billingYear", description, sac, qty, rate, taxable
       FROM app.invoice_lines WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY id`, [t, id]);
  const payments = await many(tx,
    `SELECT p.id AS "paymentId", p.mode, p.payment_date AS "paymentDate", p.reference, p.status, a.amount,
            (SELECT r.number FROM app.receipts r WHERE r.tenant_id = p.tenant_id AND r.payment_id = p.id LIMIT 1) AS "receiptNo"
       FROM app.payment_allocations a JOIN app.payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
      WHERE a.tenant_id = $1 AND a.invoice_id = $2 ORDER BY p.payment_date`, [t, id]);
  const tds = await many(tx,
    `SELECT id, amount, section, deduction_date AS "deductionDate", certificate_status AS "certificateStatus",
            certificate_key IS NOT NULL AS "certificateUploaded", entered_by_client AS "enteredByClient", verified, note
       FROM app.tds_entries WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY deduction_date`, [t, id]);
  const creditNotes = await many(tx,
    `SELECT id, number, cn_date AS "date", taxable, cgst, sgst, igst, total, reason, pdf_key IS NOT NULL AS "pdfReady"
       FROM app.credit_notes WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY cn_date`, [t, id]);
  return { ...toInvoiceDto(r), lines, payments, tds, creditNotes };
}

/** Super Admin helper: the tenant of a billing row (the ONLY way admin routes learn the tenant of an invoice). */
export async function tenantOfInvoice(tx: Tx, invoiceId: string): Promise<string> {
  const r = await maybeOne<{ tenant_id: string }>(tx, 'SELECT tenant_id FROM app.invoices WHERE id = $1', [invoiceId]);
  if (!r) throw notFound('Invoice');
  return r.tenant_id;
}
