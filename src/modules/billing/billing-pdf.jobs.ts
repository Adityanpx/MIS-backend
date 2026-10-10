import { env } from '../../config/env';
import { exec, one } from '../../db/sql';
import { withSystem } from '../../db/tenant';
import { registerHandler } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { formatDisplayDate } from '../../lib/dates';
import { formatMoney } from '../../shared/format';
import { billingKey, docFileName, storage } from '../files/storage';
import { sendInBackground } from '../notifications/email.service';
import { renderPdf } from '../pdf/browser';
import { loadBillingConfig } from './billing-config';
import { notifyClientBilling } from './billing-notify';
import { billingDocHtml, type BillingDocKind } from './billing-pdf.service';

const TABLE: Record<BillingDocKind, string> = { invoice: 'app.invoices', credit_note: 'app.credit_notes', receipt: 'app.receipts' };

registerHandler(QUEUES.pdfInvoice, async (data) => {
  const { tenantId, kind, id, notify } = data as { tenantId: string; kind: BillingDocKind; id: string; notify?: boolean };
  if (env.PDF_ENABLED) {
    const doc = await billingDocHtml(tenantId, kind, id);
    const pdf = await renderPdf(doc.html, { format: 'A4', landscape: false });
    const key = billingKey(tenantId, doc.fy, `${docFileName(doc.number)}.pdf`);
    await storage.put(key, pdf, 'application/pdf');
    await withSystem((tx) => exec(tx, `UPDATE ${TABLE[kind]} SET pdf_key = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, id, key]));
  }
  if (notify && kind === 'invoice') {
    const outbox = await withSystem(async (tx) => {
      const cfg = await loadBillingConfig(tx);
      const i = await one<{ number: string; issue_date: string; due_date: string; total: string; balance: string; rzp_link_url: string | null; description: string }>(
        tx,
        `SELECT i.number, i.issue_date, i.due_date, i.total, i.balance, i.rzp_link_url,
                coalesce((SELECT string_agg(l.description, '; ') FROM app.invoice_lines l WHERE l.tenant_id = i.tenant_id AND l.invoice_id = i.id), '') AS description
           FROM app.invoices i WHERE i.tenant_id = $1 AND i.id = $2`,
        [tenantId, id],
      );
      return notifyClientBilling(tx, {
        tenantId, code: 'N-B01', title: `Invoice ${i.number} issued`, body: `${formatMoney(i.total)} due on ${formatDisplayDate(i.due_date)}.`,
        link: `/billing/invoices/${id}`,
        vars: {
          invoiceNo: i.number, invoiceDate: formatDisplayDate(i.issue_date), dueDate: formatDisplayDate(i.due_date),
          amount: formatMoney(i.balance), description: i.description, sellerName: cfg.seller.legalName,
          ...(i.rzp_link_url ? { payLink: i.rzp_link_url } : {}),
        },
        dedupeKey: `N-B01:${id}`,
      });
    });
    sendInBackground(outbox);
  }
});
