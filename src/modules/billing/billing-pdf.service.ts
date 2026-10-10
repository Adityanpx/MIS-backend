import { many, maybeOne } from '../../db/sql';
import { withSystem } from '../../db/tenant';
import { financialYear } from '../../lib/dates';
import { notFound } from '../../lib/errors';
import { signedUrlOrNull } from '../files/storage';
import {
  creditNoteHtml, invoiceHtml, receiptHtml, type PartyBlock, type SellerBlock,
} from '../pdf/templates/billing';
import { DEFAULT_SELLER, loadBillingConfig } from './billing-config';
import { stateName } from '../../shared/indian-states';

export type BillingDocKind = 'invoice' | 'credit_note' | 'receipt';

const sellerOf = (snap: Record<string, unknown> | null, fallback: SellerBlock): SellerBlock =>
  snap ? ({ ...fallback, ...(snap as Partial<SellerBlock>) } as SellerBlock) : fallback;

/** HTML + number + FY of one billing document. Every query filters by tenant_id. */
export async function billingDocHtml(tenantId: string, kind: BillingDocKind, id: string) {
  return withSystem(async (tx) => {
    const cfg = await loadBillingConfig(tx);
    const liveSeller: SellerBlock = { ...DEFAULT_SELLER, ...cfg.seller, sac: cfg.tax.sac };
    const logo = await signedUrlOrNull(cfg.seller.logoKey);
    const client = await maybeOne<{ legal_name: string; gstin: string | null; state_code: string; address: PartyBlock['address'] }>(
      tx, 'SELECT legal_name, gstin, state_code, address FROM app.clients WHERE id = $1', [tenantId]);
    if (!client) throw notFound('Client');
    const liveBuyer: PartyBlock = {
      legalName: client.legal_name, gstin: client.gstin, stateCode: client.state_code, stateName: stateName(client.state_code), address: client.address,
    };

    if (kind === 'invoice') {
      const i = await maybeOne<Record<string, string | null> & { seller_snapshot: Record<string, unknown> | null; buyer_snapshot: PartyBlock | null; gst_rate_pct: string }>(
        tx,
        `SELECT number, fy, issue_date, due_date, status, place_of_supply, gst_type, gst_rate_pct, taxable, cgst, sgst, igst,
                round_off, total, credit_applied, paid, tds, credit_noted, balance, notes, rzp_link_url, seller_snapshot, buyer_snapshot
           FROM app.invoices WHERE tenant_id = $1 AND id = $2 AND number IS NOT NULL`,
        [tenantId, id],
      );
      if (!i) throw notFound('Invoice');
      const lines = await many<{ description: string; sac: string | null; qty: string; rate: string; taxable: string }>(
        tx, 'SELECT description, sac, qty, rate, taxable FROM app.invoice_lines WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY id', [tenantId, id]);
      const html = await invoiceHtml({
        number: i.number ?? '', issueDate: i.issue_date ?? '', dueDate: i.due_date ?? '', status: i.status ?? '',
        placeOfSupply: i.place_of_supply ?? null, gstType: i.gst_type ?? null, gstRatePct: Number(i.gst_rate_pct), taxable: i.taxable ?? '0',
        cgst: i.cgst ?? '0', sgst: i.sgst ?? '0', igst: i.igst ?? '0', roundOff: i.round_off ?? '0', total: i.total ?? '0',
        creditApplied: i.credit_applied ?? '0', paid: i.paid ?? '0', tds: i.tds ?? '0', creditNoted: i.credit_noted ?? '0',
        balance: i.balance ?? '0', notes: i.notes ?? null, payUrl: i.rzp_link_url ?? null,
        seller: sellerOf(i.seller_snapshot, liveSeller), buyer: i.buyer_snapshot ?? liveBuyer, lines,
      }, logo);
      return { html, number: i.number ?? '', fy: i.fy ?? financialYear(i.issue_date ?? '') };
    }

    if (kind === 'credit_note') {
      const c = await maybeOne<{
        number: string; cn_date: string; reason: string; taxable: string; cgst: string; sgst: string; igst: string; total: string;
        inv_number: string; inv_date: string; gst_type: string | null; gst_rate_pct: string; place_of_supply: string | null;
        seller_snapshot: Record<string, unknown> | null; buyer_snapshot: PartyBlock | null;
      }>(
        tx,
        `SELECT cn.number, cn.cn_date, cn.reason, cn.taxable, cn.cgst, cn.sgst, cn.igst, cn.total,
                i.number AS inv_number, i.issue_date AS inv_date, i.gst_type, i.gst_rate_pct, i.place_of_supply,
                i.seller_snapshot, i.buyer_snapshot
           FROM app.credit_notes cn JOIN app.invoices i ON i.tenant_id = cn.tenant_id AND i.id = cn.invoice_id
          WHERE cn.tenant_id = $1 AND cn.id = $2`,
        [tenantId, id],
      );
      if (!c) throw notFound('Credit note');
      const html = creditNoteHtml({
        number: c.number, date: c.cn_date, invoiceNumber: c.inv_number, invoiceDate: c.inv_date, reason: c.reason,
        gstType: c.gst_type, gstRatePct: Number(c.gst_rate_pct), taxable: c.taxable, cgst: c.cgst, sgst: c.sgst, igst: c.igst,
        total: c.total, placeOfSupply: c.place_of_supply, seller: sellerOf(c.seller_snapshot, liveSeller), buyer: c.buyer_snapshot ?? liveBuyer,
      }, logo);
      return { html, number: c.number, fy: financialYear(c.cn_date) };
    }

    const r = await maybeOne<{
      number: string; receipt_date: string; payment_id: string; payment_date: string; mode: string; reference: string | null;
      bank: string | null; amount: string; gateway_fee: string;
    }>(
      tx,
      `SELECT r.number, r.receipt_date, r.payment_id, p.payment_date, p.mode, p.reference, p.bank, p.amount, p.gateway_fee
         FROM app.receipts r JOIN app.payments p ON p.tenant_id = r.tenant_id AND p.id = r.payment_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, id],
    );
    if (!r) throw notFound('Receipt');
    const allocations = await many<{ invoiceNumber: string | null; amount: string }>(
      tx,
      `SELECT i.number AS "invoiceNumber", a.amount FROM app.payment_allocations a
         LEFT JOIN app.invoices i ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
        WHERE a.tenant_id = $1 AND a.payment_id = $2 ORDER BY i.number NULLS LAST`,
      [tenantId, r.payment_id],
    );
    const html = receiptHtml({
      number: r.number, date: r.receipt_date, paymentDate: r.payment_date, mode: r.mode, reference: r.reference, bank: r.bank,
      amount: r.amount, gatewayFee: r.gateway_fee, toCredit: '0', seller: liveSeller, buyer: liveBuyer, allocations,
    }, logo);
    return { html, number: r.number, fy: financialYear(r.receipt_date) };
  });
}
