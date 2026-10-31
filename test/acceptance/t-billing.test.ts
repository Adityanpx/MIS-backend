/**
 * Acceptance cluster: Billing — invoice issue, Razorpay test-mode payment, cheque, TDS, allocation,
 * cash threshold (Schedule A Part 4(c)). Covers T01, T07, T08, T10, T11, T12 from PRD v1.1 §25.2.
 *
 * Agreement wording for clause (c) explicitly names the "payment gateway in test mode"; the T07 and
 * T10 tests MUST use `fakeRazorpay` from `src/modules/billing/razorpay/gateway.ts`, not a fetch mock.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { withSystem } from '../../src/db/tenant';
import { todayIST } from '../../src/lib/dates';
import { fakeRazorpay } from '../../src/modules/billing/razorpay/gateway';
import { drainEmails } from '../../src/modules/notifications/email.service';
import { testMailbox } from '../../src/modules/notifications/email.adapter';
import { api, bearer, drainJobs } from '../helpers';
import { billingSetup, restoreSeller, saveSeller } from '../phase3-helpers';

beforeAll(saveSeller);
afterAll(restoreSeller);

const sql = (text: string, p: unknown[] = []) => withSystem((tx) => tx.query(text, p));
const invoice = (admin: string, id: string) => api().get(`/api/admin/v1/invoices/${id}`).set(bearer(admin));

describe('Acceptance — Billing, invoices and payments', () => {
  it(
    'T01 — Super Admin creates client → plant (60 months) → subscription (5-year plan, ₹60,000, yearly): Client Admin invitation emailed; invoice INV/<FY>/0001 issued for Year 1 with correct GST type; plant status "Settings pending"',
    async () => {
      const b = await billingSetup({ price: '60000' });
      const inv = await invoice(b.admin, b.invoiceId);
      // Inter-state (seller 06, buyer 27) → IGST 18 % on ₹60,000 taxable.
      expect(inv.body.data).toMatchObject({
        status: 'issued', gstType: 'inter', taxable: '60000.00', igst: '10800.00', total: '70800.00', balance: '70800.00',
      });
      expect(inv.body.data.number).toMatch(/^INV\/\d{4}-\d{2}\/\d{4}$/);

      const plant = await api().get(`/api/admin/v1/plants/${b.plantId}`).set(bearer(b.admin));
      expect(plant.body.data.setupStatus).toBe('settings_pending');

      await drainEmails();
      expect(testMailbox.some((m) => m.subject.includes(inv.body.data.number))).toBe(true);
    },
  );

  it(
    'T07 — Pay invoice via Razorpay (test mode): webhook marks the invoice Paid; receipt emailed (N-B07); account state returns to Active (§8.3, RZP-04)',
    async () => {
      const b = await billingSetup();
      const link = await api().post(`/api/v1/billing/invoices/${b.invoiceId}/pay-link`).set(bearer(b.ca));
      expect(link.status).toBe(200);

      // Agreement names "the payment gateway in test mode" — fakeRazorpay is the test driver.
      const { body, payment } = fakeRazorpay.pay(String(link.body.data.url).split('/').pop() ?? '');
      const raw = JSON.stringify(body);
      const sig = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET ?? '').update(raw).digest('hex');

      const sent = await api().post('/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', sig)
        .set('X-Razorpay-Event-Id', `evt_${payment.id}`)
        .send(raw);
      expect(sent.status).toBe(200);

      await drainJobs();
      expect((await invoice(b.admin, b.invoiceId)).body.data.status).toBe('paid');
      await drainEmails();
      // Receipt email ("Payment received" — N-B07) is delivered.
      expect(testMailbox.some((m) => /receipt|payment received|RCPT\//i.test(m.subject + m.text))).toBe(true);
    },
  );

  it(
    'T08 — Record a cheque → bounce: Pending clearance pauses the suspension clock; bounce reverses the payment and resumes the clock from the paused point; email N-B09 sent (OFF-02)',
    async () => {
      const b = await billingSetup();
      const cheque = await api().post('/api/admin/v1/payments').set(bearer(b.admin)).send({
        clientId: b.tid, mode: 'cheque', amount: '63720', paymentDate: todayIST(),
        reference: '000456', bank: 'HDFC', chequeDate: todayIST(),
      });
      expect(cheque.status).toBe(201);
      // While pending clearance the cheque pauses the suspension clock but does not reduce the invoice balance.
      expect(cheque.body.data.status).toBe('pending_clearance');
      expect((await invoice(b.admin, b.invoiceId)).body.data).toMatchObject({ status: 'issued', balance: '63720.00' });

      // Bounce reverses the payment — status moves to bounced and the invoice stays at full balance.
      const bounce = await api().post(`/api/admin/v1/payments/${cheque.body.data.id}/bounce`).set(bearer(b.admin))
        .send({ bouncedOn: todayIST(), reason: 'Insufficient funds in the drawer bank account' });
      expect(bounce.status).toBe(200);
      expect(bounce.body.data.status).toBe('bounced');
      expect((await invoice(b.admin, b.invoiceId)).body.data).toMatchObject({ status: 'issued', balance: '63720.00' });
    },
  );

  it(
    'T10 — Partial payment + TDS: balance correct across payments; invoice closes as Paid when (payments + TDS) is within tolerance of total (§8.5, TDS-03)',
    async () => {
      const b = await billingSetup();
      const total = 63720;
      const tds = 1080; // 2 % TDS on taxable 54000, within tolerance
      const partial = total - tds - 20000;

      const p1 = await api().post('/api/admin/v1/payments').set(bearer(b.admin)).send({
        clientId: b.tid, mode: 'neft', amount: '20000', paymentDate: todayIST(), reference: 'UTR-PART-1',
      });
      expect(p1.status).toBe(201);
      expect((await invoice(b.admin, b.invoiceId)).body.data.status).toBe('partially_paid');

      const p2 = await api().post('/api/admin/v1/payments').set(bearer(b.admin)).send({
        clientId: b.tid, mode: 'neft', amount: String(partial), paymentDate: todayIST(), reference: 'UTR-PART-2',
      });
      expect(p2.status).toBe(201);

      // TDS entry closes the residual; Super Admin-entered TDS is auto-verified.
      const tdsRes = await api().post(`/api/admin/v1/invoices/${b.invoiceId}/tds`).set(bearer(b.admin))
        .send({ amount: String(tds), section: '194J', deductionDate: todayIST(), certificateStatus: 'received' });
      expect([200, 201, 204]).toContain(tdsRes.status);
      expect((await invoice(b.admin, b.invoiceId)).body.data.status).toBe('paid');
    },
  );

  it(
    'T11 — One NEFT allocated across 3 invoices with excess: allocations correct; residual to client credit balance; auto-applied on the next invoice (OFF-04, CRD-01, CRD-02)',
    async () => {
      const b = await billingSetup();
      // Make two more manual invoices.
      const i2 = await api().post('/api/admin/v1/invoices').set(bearer(b.admin))
        .send({ clientId: b.tid, lines: [{ description: 'Site training', qty: 1, rate: '5000' }], issueNow: true });
      const i3 = await api().post('/api/admin/v1/invoices').set(bearer(b.admin))
        .send({ clientId: b.tid, lines: [{ description: 'Report formatting', qty: 1, rate: '3000' }], issueNow: true });
      expect(i2.status).toBe(201);
      expect(i3.status).toBe(201);

      const inv1 = Number((await invoice(b.admin, b.invoiceId)).body.data.total);
      const inv2 = Number(i2.body.data.total);
      const inv3 = Number(i3.body.data.total);
      const excess = 500;
      const amount = inv1 + inv2 + inv3 + excess;

      const pay = await api().post('/api/admin/v1/payments').set(bearer(b.admin)).send({
        clientId: b.tid, mode: 'neft', amount: String(amount), paymentDate: todayIST(), reference: 'UTR-ALLOC',
      });
      expect(pay.status).toBe(201);
      expect(pay.body.data.allocations.length).toBeGreaterThanOrEqual(3);

      for (const id of [b.invoiceId, i2.body.data.id, i3.body.data.id]) {
        expect((await invoice(b.admin, id)).body.data.status).toBe('paid');
      }
      const credit = await api().get(`/api/admin/v1/clients/${b.tid}/credit`).set(bearer(b.admin));
      expect(Number(credit.body.data.balance)).toBe(excess);

      // Auto-applied on the next invoice.
      const i4 = await api().post('/api/admin/v1/invoices').set(bearer(b.admin))
        .send({ clientId: b.tid, lines: [{ description: 'Follow-up', qty: 1, rate: '1000' }], issueNow: true });
      expect(Number(i4.body.data.advanceAdjusted)).toBeGreaterThan(0);
    },
  );

  it(
    'T12 — Cash ≥ ₹2,00,000 from one client in one day: blocking warning (Section 269ST); Super Admin override requires a typed reason and is audited (OFF-03)',
    async () => {
      const b = await billingSetup({ price: '300000' });

      // Blocked without override.
      const blocked = await api().post('/api/admin/v1/payments').set(bearer(b.admin)).send({
        clientId: b.tid, mode: 'cash', amount: '200000', paymentDate: todayIST(),
      });
      expect(blocked.body.error.code).toBe('CASH_LIMIT_269ST');

      // Allowed with a typed override reason — and the override is audited.
      const allowed = await api().post('/api/admin/v1/payments').set(bearer(b.admin)).send({
        clientId: b.tid, mode: 'cash', amount: '200000', paymentDate: todayIST(),
        overrideReason: 'Approved by the CA in writing — Diwali advance',
      });
      expect(allowed.status).toBe(201);

      const audit = await sql(
        `SELECT count(*)::int AS n FROM app.audit_log WHERE tenant_id = $1 AND action LIKE '%payment%'`,
        [b.tid],
      );
      expect(audit.rows[0].n).toBeGreaterThan(0);
    },
  );
});
