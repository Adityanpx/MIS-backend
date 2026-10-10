import crypto from 'node:crypto';
import { env } from '../../src/config/env';
import { withSystem } from '../../src/db/tenant';
import { addDays, todayIST } from '../../src/lib/dates';
import { fakeRazorpay } from '../../src/modules/billing/razorpay/gateway';
import { testMailbox } from '../../src/modules/notifications/email.adapter';
import { drainEmails } from '../../src/modules/notifications/email.service';
import { api, bearer, drainJobs, uniq } from '../helpers';
import { billingSetup, restoreSeller, saveSeller } from '../phase3-helpers';

beforeAll(saveSeller);
afterAll(restoreSeller);
const cron = (job: string) => api().post(`/internal/cron/${job}`).set('X-Cron-Secret', env.CRON_SECRET);
const sql = (text: string, p: unknown[] = []) => withSystem((tx) => tx.query(text, p));
const invoice = (admin: string, id: string) => api().get(`/api/admin/v1/invoices/${id}`).set(bearer(admin));
const plantState = async (admin: string, id: string) => (await api().get(`/api/admin/v1/plants/${id}`).set(bearer(admin))).body.data.accountState;

describe('invoices (INV-01…12)', () => {
  it('first invoice on plant creation: IGST, gap-free number, pay link, N-B01, visible to the client', async () => {
    const b = await billingSetup();
    const inv = await invoice(b.admin, b.invoiceId);
    expect(inv.body.data).toMatchObject({ status: 'issued', gstType: 'inter', taxable: '54000.00', igst: '9720.00', total: '63720.00', balance: '63720.00' });
    expect(inv.body.data.number).toMatch(/^INV\/\d{4}-\d{2}\/\d{4}$/);
    expect(inv.body.data.payUrl).toMatch(/^https:\/\/rzp\.test\//);
    const list = await api().get('/api/v1/billing/invoices').set(bearer(b.ca));
    expect(list.body.data.map((i: { id: string }) => i.id)).toContain(b.invoiceId);
    await drainEmails();
    expect(testMailbox.some((m) => m.subject.includes(inv.body.data.number))).toBe(true);
  });

  it('same state → CGST+SGST; manual invoice with round-off; credit note; cancel', async () => {
    const b = await billingSetup({ sellerState: '27' });
    expect((await invoice(b.admin, b.invoiceId)).body.data).toMatchObject({ gstType: 'intra', cgst: '4860.00', sgst: '4860.00', total: '63720.00' });
    const man = await api().post('/api/admin/v1/invoices').set(bearer(b.admin))
      .send({ clientId: b.tid, lines: [{ description: 'On-site training', qty: 1, rate: '10000.55' }], issueNow: true });
    expect(man.status).toBe(201);
    expect(man.body.data).toMatchObject({ taxable: '10000.55', cgst: '900.05', sgst: '900.05', roundOff: '0.35', total: '11801.00' });
    const cn = await api().post(`/api/admin/v1/invoices/${man.body.data.id}/credit-notes`).set(bearer(b.admin))
      .send({ amount: '1000.00', reason: 'Discount agreed with the client' });
    expect(cn.status).toBe(201);
    expect(cn.body.data).toMatchObject({ total: '1180.00' });
    expect(cn.body.data.number).toMatch(/^CN\//);
    const cancel = await api().post(`/api/admin/v1/invoices/${man.body.data.id}/cancel`).set(bearer(b.admin)).send({ reason: 'Raised in error, will reissue' });
    expect(cancel.body.data).toMatchObject({ status: 'cancelled', balance: '0.00' });
    expect(cancel.body.data.creditNotes).toHaveLength(2);
  });
});

describe('payments (OFF-01…05, CRD-01/02, RCT-01)', () => {
  it('partial NEFT, then full; excess becomes credit and is auto-applied to the next invoice', async () => {
    const b = await billingSetup();
    const pay = (amount: string, reference: string) => api().post('/api/admin/v1/payments').set(bearer(b.admin))
      .send({ clientId: b.tid, mode: 'neft', amount, paymentDate: todayIST(), reference });
    const p1 = await pay('20000', 'UTR0001');
    expect(p1.status).toBe(201);
    expect(p1.body.data.allocations[0]).toMatchObject({ invoiceId: b.invoiceId, amount: '20000.00' });
    expect((await invoice(b.admin, b.invoiceId)).body.data).toMatchObject({ status: 'partially_paid', balance: '43720.00' });
    const p2 = await pay('50000', 'UTR0002');
    expect(p2.body.data.receiptNo).toMatch(/^RCPT\//);
    expect((await invoice(b.admin, b.invoiceId)).body.data).toMatchObject({ status: 'paid', balance: '0.00' });
    expect((await api().get(`/api/admin/v1/clients/${b.tid}/credit`).set(bearer(b.admin))).body.data.balance).toBe('6280.00');
    const man = await api().post('/api/admin/v1/invoices').set(bearer(b.admin))
      .send({ clientId: b.tid, lines: [{ description: 'Data migration', qty: 1, rate: '10000' }], issueNow: true });
    expect(man.body.data).toMatchObject({ total: '11800.00', advanceAdjusted: '6280.00', balance: '5520.00', status: 'partially_paid' });
    expect((await api().get('/api/v1/billing/credit').set(bearer(b.ca))).body.data.balance).toBe('0.00');
  });

  it('269ST cash block + override; cheque pending → clear; Idempotency-Key replays', async () => {
    const b = await billingSetup({ price: '300000' }); // total 3,54,000
    const post = (body: object, key?: string) => {
      const r = api().post('/api/admin/v1/payments').set(bearer(b.admin));
      return key ? r.set('Idempotency-Key', key).send(body) : r.send(body);
    };
    const cash = { clientId: b.tid, mode: 'cash', amount: '200000', paymentDate: todayIST() };
    expect((await post(cash)).body.error.code).toBe('CASH_LIMIT_269ST');
    expect((await post({ ...cash, overrideReason: 'Approved by the CA in writing' })).status).toBe(201);
    const cheque = { clientId: b.tid, mode: 'cheque', amount: '154000', paymentDate: todayIST(), reference: '000123', bank: 'HDFC', chequeDate: todayIST() };
    const key = `chq-${uniq()}`;
    const c1 = await post(cheque, key);
    const c2 = await post(cheque, key);
    expect(c1.status).toBe(201);
    expect(c2.body.data.id).toBe(c1.body.data.id);
    const n = await sql(`SELECT count(*)::int AS n FROM app.payments WHERE tenant_id = $1 AND mode = 'cheque'`, [b.tid]);
    expect(n.rows[0].n).toBe(1);
    expect(c1.body.data.status).toBe('pending_clearance');
    expect((await invoice(b.admin, b.invoiceId)).body.data).toMatchObject({ status: 'partially_paid', balance: '154000.00' });
    const cleared = await api().post(`/api/admin/v1/payments/${c1.body.data.id}/clear`).set(bearer(b.admin)).send({ clearedOn: todayIST() });
    expect(cleared.body.data.status).toBe('applied');
    expect((await invoice(b.admin, b.invoiceId)).body.data.status).toBe('paid');
  });

  it('"I have paid" notification → Super Admin verifies → payment applied', async () => {
    const b = await billingSetup();
    const n = await api().post(`/api/v1/billing/invoices/${b.invoiceId}/payment-notifications`).set(bearer(b.ca))
      .field('amount', '63720').field('paidOn', todayIST()).field('reference', 'UTR-CLIENT-1');
    expect(n.status).toBe(201);
    const v = await api().post(`/api/admin/v1/payment-notifications/${n.body.data.id}/verify`).set(bearer(b.admin)).send({ mode: 'neft' });
    expect(v.status).toBe(200);
    expect((await invoice(b.admin, b.invoiceId)).body.data.status).toBe('paid');
  });
});

describe('Razorpay (RZP-01…05, E12)', () => {
  it('webhook: signature checked, payment recorded once, invoice paid', async () => {
    const b = await billingSetup();
    const link = await api().post(`/api/v1/billing/invoices/${b.invoiceId}/pay-link`).set(bearer(b.ca));
    expect(link.status).toBe(200);
    const { body, payment } = fakeRazorpay.pay(String(link.body.data.url).split('/').pop() ?? '');
    const raw = JSON.stringify(body);
    const sig = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET ?? '').update(raw).digest('hex');
    const send = (signature: string) => api().post('/webhooks/razorpay').set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature).set('X-Razorpay-Event-Id', `evt_${payment.id}`).send(raw);
    expect((await send('not-the-signature')).status).toBe(400);
    expect((await send(sig)).status).toBe(200);
    expect((await send(sig)).body).toMatchObject({ duplicate: true });
    await drainJobs();
    const n = await sql('SELECT count(*)::int AS n FROM app.payments WHERE rzp_payment_id = $1', [payment.id]);
    expect(n.rows[0].n).toBe(1);
    expect((await invoice(b.admin, b.invoiceId)).body.data.status).toBe('paid');
    // reconciliation finds nothing new and never duplicates
    expect((await cron('razorpay.reconcile')).status).toBe(202);
    await drainJobs();
    expect((await sql('SELECT count(*)::int AS n FROM app.payments WHERE rzp_payment_id = $1', [payment.id])).rows[0].n).toBe(1);
  });
});

describe('lifecycle (LC-01…09)', () => {
  it('overdue → read-only → payment restores at once; manual suspension keeps Billing reachable', async () => {
    const b = await billingSetup();
    await sql('UPDATE app.invoices SET due_date = $3 WHERE tenant_id = $1 AND id = $2', [b.tid, b.invoiceId, addDays(todayIST(), -20)]);
    expect((await cron('lifecycle.evaluate')).status).toBe(202);
    await drainJobs();
    expect(await plantState(b.admin, b.plantId)).toBe('read_only');
    expect((await api().patch('/api/v1/company').set(bearer(b.ca)).send({ displayName: 'New Name' })).body.error.code).toBe('ACCOUNT_READ_ONLY');
    const banners = await api().get('/api/v1/banners').set(bearer(b.ca));
    expect(banners.body.data[0]).toMatchObject({ state: 'read_only', showPayNow: true, overdueAmount: '63720.00' });
    await api().post('/api/admin/v1/payments').set(bearer(b.admin))
      .send({ clientId: b.tid, mode: 'neft', amount: '63720', paymentDate: todayIST(), reference: 'UTR-LATE-1' });
    expect(await plantState(b.admin, b.plantId)).toBe('active');
    await drainEmails();
    expect(testMailbox.some((m) => m.subject.includes('reactivated'))).toBe(true);
    expect((await api().post(`/api/admin/v1/clients/${b.tid}/suspend`).set(bearer(b.admin)).send({ reason: 'Escalation test for suspension' })).status).toBe(204);
    expect((await api().get('/api/v1/company').set(bearer(b.ca))).body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await api().get('/api/v1/billing/invoices').set(bearer(b.ca))).status).toBe(200);
    expect((await api().post(`/api/admin/v1/clients/${b.tid}/reactivate`).set(bearer(b.admin)).send({ reason: 'Escalation test finished ok' })).status).toBe(204);
    expect(await plantState(b.admin, b.plantId)).toBe('active');
    const tl = await api().get(`/api/admin/v1/clients/${b.tid}/lifecycle`).set(bearer(b.admin));
    expect(tl.body.data.length).toBeGreaterThanOrEqual(4);
  });
});

describe('subscriptions (SUB-04…07)', () => {
  it('extend ≤ 15 years, change plan from the next year, cancel with credit notes', async () => {
    const b = await billingSetup();
    const sub = (await api().get(`/api/admin/v1/plants/${b.plantId}`).set(bearer(b.admin))).body.data.subscription;
    const ext = (addYears: number) => api().post(`/api/admin/v1/subscriptions/${sub.id}/extend`).set(bearer(b.admin))
      .send({ addYears, reason: 'Client extended the contract' });
    expect((await ext(11)).body.error.code).toBe('CONTRACT_TOO_LONG');
    const e = await ext(2);
    expect(e.body.data.schedule).toHaveLength(7);
    const plan2 = await api().post('/api/admin/v1/plans').set(bearer(b.admin))
      .send({ name: `C ${uniq()}`, code: `C-${uniq()}`.toUpperCase(), termYears: 5, pricePerYear: '60000' });
    const ch = await api().post(`/api/admin/v1/subscriptions/${sub.id}/change-plan`).set(bearer(b.admin))
      .send({ planId: plan2.body.data.id, reason: 'Upgrade requested by client' });
    expect(ch.body.data.schedule[1].amount).toBe('60000.00');
    const c = await api().post(`/api/admin/v1/subscriptions/${sub.id}/cancel`).set(bearer(b.admin))
      .send({ reason: 'Client closed the plant early', unpaidInvoices: 'credit_note' });
    expect(c.body.data.status).toBe('cancelled');
    expect(c.body.data.schedule).toHaveLength(1);
    expect((await invoice(b.admin, b.invoiceId)).body.data.status).toBe('cancelled');
  });
});

describe('act-as (ACT-01…05)', () => {
  it('view session: reads work, writes are blocked, everything is audited, the session can be ended', async () => {
    const b = await billingSetup();
    const s = await api().post(`/api/admin/v1/clients/${b.tid}/act-as`).set(bearer(b.admin)).send({ mode: 'view' });
    expect(s.status).toBe(201);
    const ex = await api().post('/api/v1/auth/act-as/exchange').send({ code: s.body.data.code });
    expect(ex.status).toBe(200);
    expect(ex.body.data.actingAs).toMatchObject({ adminId: b.sa.id, mode: 'view' });
    expect(ex.headers['set-cookie']).toBeUndefined();
    const t = ex.body.data.accessToken as string;
    expect((await api().get('/api/v1/company').set(bearer(t))).status).toBe(200);
    expect((await api().patch('/api/v1/company').set(bearer(t)).send({ displayName: 'X' })).body.error.code).toBe('ACT_AS_READ_ONLY');
    expect((await api().post('/api/v1/auth/act-as/exchange').send({ code: s.body.data.code })).status).toBe(401); // single use
    const audit = await sql('SELECT count(*)::int AS n FROM app.audit_log WHERE tenant_id = $1 AND acting_as_admin_id = $2', [b.tid, b.sa.id]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
    expect((await api().post(`/api/admin/v1/act-as/${s.body.data.sessionId}/end`).set(bearer(b.admin))).status).toBe(204);
    expect((await api().get('/api/v1/company').set(bearer(t))).status).toBe(401);
  });
});

describe('export and deletion (EXP-01…03, DEL-01…03)', () => {
  it('full client export; deletion after retention keeps financial records', async () => {
    const b = await billingSetup();
    const e = await api().post('/api/v1/company/exports').set(bearer(b.ca)).send({});
    expect(e.status).toBe(202);
    await drainJobs();
    expect((await api().get(`/api/v1/exports/${e.body.data.exportId}`).set(bearer(b.ca))).body.data.status).toBe('ready');
    expect((await api().post(`/api/admin/v1/clients/${b.tid}/terminate`).set(bearer(b.admin)).send({ reason: 'Contract ended, client left' })).status).toBe(204);
    await sql(`UPDATE app.clients SET terminated_at = now() - interval '100 days' WHERE id = $1`, [b.tid]);
    await cron('deletion.queue');
    await drainJobs();
    const del = (confirmCode: string) => api().post(`/api/admin/v1/clients/${b.tid}/delete`).set(bearer(b.admin))
      .send({ confirmCode, reason: 'Retention period is over' });
    expect((await del('WRONG')).body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect((await del(b.tenant.code)).status).toBe(202);
    await drainJobs();
    const r = await sql(`SELECT (SELECT status FROM app.clients WHERE id = $1) AS status,
                                (SELECT count(*)::int FROM app.users WHERE tenant_id = $1) AS users,
                                (SELECT count(*)::int FROM app.invoices WHERE tenant_id = $1) AS invoices`, [b.tid]);
    expect(r.rows[0]).toMatchObject({ status: 'deleted', users: 0 });
    expect(r.rows[0].invoices).toBeGreaterThan(0);
    expect((await api().post('/api/v1/auth/login').send({ email: b.tenant.admin.email, password: 'Passw0rd-123' })).status).toBe(401);
  });
});

describe('Super Admin dashboard, reports, audit', () => {
  it('dashboard, GST register (xlsx), ageing, audit list', async () => {
    const b = await billingSetup();
    const d = await api().get('/api/admin/v1/dashboard').set(bearer(b.admin));
    expect(d.status).toBe(200);
    expect(d.body.data.money.outstanding).toBeDefined();
    const x = await api().get('/api/admin/v1/reports/gst-register?format=xlsx').set(bearer(b.admin));
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const ageing = await api().get(`/api/admin/v1/reports/ageing?clientId=${b.tid}`).set(bearer(b.admin));
    expect(ageing.body.data.rows).toHaveLength(1);
    const audit = await api().get(`/api/admin/v1/audit?clientId=${b.tid}&pageSize=5`).set(bearer(b.admin));
    expect(audit.body.meta.total).toBeGreaterThan(0);
    expect((await api().get('/api/admin/v1/dashboard/action-list').set(bearer(b.admin))).status).toBe(200);
  });
});
