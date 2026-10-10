import { exec, maybeOne } from '../../../db/sql';
import { withSystem } from '../../../db/tenant';
import { addDays, maxDate, todayIST } from '../../../lib/dates';
import { logger } from '../../../lib/logger';
import { D, money, round2 } from '../../../lib/money';
import { loadBillingConfig } from '../billing-config';
import { razorpay } from './gateway';

const OPEN = ['issued', 'partially_paid', 'overdue'];

/**
 * Makes sure an open invoice has a link for its CURRENT balance (+ convenience fee, RZP-06) that is valid for at least
 * one more day. Closed invoices get their link cancelled. Returns the URL or null (no link / gateway not configured).
 */
export async function ensurePayLink(tenantId: string, invoiceId: string, opts: { force?: boolean } = {}): Promise<string | null> {
  if (!(await razorpay.configured())) return null;
  const { inv, cfg } = await withSystem(async (tx) => ({
    cfg: await loadBillingConfig(tx),
    inv: await maybeOne<{
      number: string | null; status: string; balance: string; due_date: string | null; rzp_link_id: string | null;
      rzp_link_url: string | null; rzp_link_expires_at: string | null; rzp_link_amount: string | null;
      legal_name: string; billing_emails: string[]; mobile: string | null;
    }>(
      tx,
      `SELECT i.number, i.status, i.balance, i.due_date, i.rzp_link_id, i.rzp_link_url, i.rzp_link_expires_at, i.rzp_link_amount,
              c.legal_name, c.billing_emails, c.primary_contact->>'mobile' AS mobile
         FROM app.invoices i JOIN app.clients c ON c.id = i.tenant_id
        WHERE i.tenant_id = $1 AND i.id = $2`,
      [tenantId, invoiceId],
    ),
  }));
  if (!inv || !inv.number) return null;
  const clear = async () => {
    if (inv.rzp_link_id) {
      await razorpay.cancelLink(inv.rzp_link_id).catch((err) => logger.warn({ err, invoiceId }, 'Could not cancel old payment link'));
      await withSystem((tx) => exec(tx,
        `UPDATE app.invoices SET rzp_link_id = NULL, rzp_link_url = NULL, rzp_link_expires_at = NULL, rzp_link_amount = NULL
          WHERE tenant_id = $1 AND id = $2`, [tenantId, invoiceId]));
    }
  };
  if (!OPEN.includes(inv.status) || !D(inv.balance).gt(0)) {
    await clear();
    return null;
  }
  const fee = cfg.billing.gatewayFeeMode === 'convenience' ? round2(D(inv.balance).mul(cfg.billing.gatewayFeePct).div(100)) : D(0);
  const amount = money(D(inv.balance).plus(fee));
  const stillValid = !!inv.rzp_link_id && inv.rzp_link_amount === amount && !!inv.rzp_link_expires_at
    && Date.parse(inv.rzp_link_expires_at) > Date.now() + 86_400_000;
  if (stillValid && !opts.force) return inv.rzp_link_url;
  await clear();
  const expiry = addDays(maxDate(inv.due_date ?? todayIST(), todayIST()), cfg.billing.linkExpiryDaysAfterDue);
  const expireBy = Math.floor(Date.parse(`${expiry}T23:59:59+05:30`) / 1000);
  const mobile = inv.mobile?.replace(/^\+91/, '');
  const link = await razorpay.createLink({
    amountPaise: Number(D(amount).mul(100).toFixed(0)),
    referenceId: `${inv.number}#${Date.now().toString(36)}`.slice(0, 40), // must be unique per link at Razorpay
    description: `Invoice ${inv.number}${fee.gt(0) ? ` (incl. convenience fee ${money(fee)})` : ''}`,
    customer: { name: inv.legal_name.slice(0, 100), email: inv.billing_emails[0], contact: mobile ? `+91${mobile}` : undefined },
    notes: { tenantId, invoiceId, invoiceNo: inv.number },
    expireBy,
  });
  await withSystem((tx) => exec(
    tx,
    `UPDATE app.invoices SET rzp_link_id = $3, rzp_link_url = $4, rzp_link_expires_at = to_timestamp($5), rzp_link_amount = $6
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, invoiceId, link.id, link.short_url, expireBy, amount],
  ));
  return link.short_url;
}
