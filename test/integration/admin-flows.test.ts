import { api, bearer, loginAdmin, PASSWORD, seedSuperAdmin, seedTenant, uniq } from '../helpers';

let token: string;
beforeAll(async () => {
  token = (await loginAdmin(await seedSuperAdmin())).token;
});
const A = () => ({ ...bearer(token) });

async function createPlan(over: Record<string, unknown> = {}) {
  const r = await api().post('/api/admin/v1/plans').set(A()).send({
    name: `Standard ${uniq()}`, code: `STD-${uniq()}`.toUpperCase(), termYears: 5, pricePerYear: '54000',
    escalationPct: 5, upfrontDiscountPct: 10, maxUsersPerPlant: 3, ...over,
  });
  expect(r.status).toBe(201);
  return r.body.data as { id: string };
}
function clientBody(email: string) {
  return {
    displayName: `Acme ${uniq()}`, legalName: 'Acme Water Pvt Ltd', stateCode: '27', gstin: '27AAACA1234A1Z5',
    address: { line1: '1 Main Road', city: 'Pune', pin: '411001' },
    primaryContact: { name: 'Ravi Kumar', email: 'ravi@acme.test' }, billingEmails: ['accounts@acme.test'],
    firstAdmin: { name: 'Ravi Kumar', email, password: PASSWORD },
  };
}

describe('plans', () => {
  it('creates a plan, previews prices, rejects terms not allowed', async () => {
    await createPlan();
    const p = await api().post('/api/admin/v1/plans/preview').set(A())
      .send({ termYears: 10, pricePerYear: '54000', escalationPct: 5 });
    expect(p.body.data.years[9].amount).toBe('83771.72');
    expect(p.body.data.totalExGst).toBe('679206.18');
    const bad = await api().post('/api/admin/v1/plans').set(A())
      .send({ name: 'Odd', code: `ODD-${uniq()}`.toUpperCase(), termYears: 7, pricePerYear: '1000' });
    expect(bad.body.error.code).toBe('TERM_NOT_ALLOWED');
  });
});

describe('clients', () => {
  it('creates a client with its first admin, who signs in with the set password and must accept terms', async () => {
    const email = `ca-${uniq()}@test.local`;
    const c = await api().post('/api/admin/v1/clients').set(A()).send(clientBody(email));
    expect(c.status).toBe(201);
    expect(c.body.data.code).toMatch(/^CL-\d{4}$/);
    const acc = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(acc.status).toBe(200);
    expect(acc.body.data).toMatchObject({ mfaRequired: false, mustAcceptTerms: true });
    const weak = await api().post('/api/admin/v1/clients').set(A())
      .send({ ...clientBody(`w-${uniq()}@test.local`), firstAdmin: { name: 'Ravi Kumar', email: `w-${uniq()}@test.local`, password: 'alllettersnodigits' } });
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    const dup = await api().post('/api/admin/v1/clients').set(A()).send(clientBody(email));
    expect(dup.body.error.code).toBe('EMAIL_IN_USE');
  });

  it('rejects a GSTIN from another state', async () => {
    const r = await api().post('/api/admin/v1/clients').set(A())
      .send({ ...clientBody(`x-${uniq()}@test.local`), gstin: '29AAACA1234A1Z5' });
    expect(r.status).toBe(400);
  });

  it('client users tab is filtered by the client in the path', async () => {
    const t1 = await seedTenant();
    const t2 = await seedTenant();
    const r = await api().post(`/api/admin/v1/clients/${t1.tenantId}/users/${t2.admin.id}/disable`).set(A());
    expect(r.status).toBe(404);
    const list = await api().get(`/api/admin/v1/clients/${t1.tenantId}/users`).set(A());
    expect(list.body.data.map((u: { id: string }) => u.id)).toEqual([t1.admin.id]);
  });
});

describe('plants wizard', () => {
  it('preview and create: contract years, subscription snapshot, schedule', async () => {
    const t = await seedTenant();
    const body = {
      clientId: t.tenantId, name: 'Bherampur STP', type: 'STP', capacityMld: 120, stateCode: '27',
      omStart: '2024-09-01', omTenureMonths: 60,
      subscription: { startDate: '2026-10-01', termYears: 5, pricePerYear: '54000.00', escalationPct: 5 },
    };
    const pv = await api().post('/api/admin/v1/plants/preview').set(A()).send(body);
    expect(pv.status).toBe(200);
    expect(pv.body.data.contractYears).toHaveLength(5);
    expect(pv.body.data.schedule).toHaveLength(5);
    expect(pv.body.data.warnings).toContain('SUBSCRIPTION_ENDS_AFTER_OM_END');
    const cr = await api().post('/api/admin/v1/plants').set(A()).send(body);
    expect(cr.status).toBe(201);
    expect(cr.body.data.code).toBe('P-001');
    expect(cr.body.data.omEnd).toBe('2029-08-31');
    // Typed terms (no plan): compounding 5% hike, yearly billing, global default limits.
    expect(cr.body.data.subscription.planId).toBeNull();
    expect(cr.body.data.subscription.billingMode).toBe('yearly');
    expect(cr.body.data.subscription.plan).toMatchObject({ termYears: 5, pricePerYear: '54000.00', escalationPct: '5' });
    expect(cr.body.data.subscription.plan.maxUsersPerPlant).toBe(10);
    expect(cr.body.data.subscription.schedule.map((s: { amount: string }) => s.amount))
      .toEqual(['54000.00', '56700.00', '59535.00', '62511.75', '65637.34']);

    // extend tenure 60 → 90 months: 8 years, last one partial
    const ext = await api().post(`/api/admin/v1/plants/${cr.body.data.id}/extend-tenure`).set(A())
      .send({ omTenureMonths: 90, reason: 'Contract extended by the authority' });
    expect(ext.status).toBe(200);
    expect(ext.body.data.contractYears).toHaveLength(8);
    expect(ext.body.data.contractYears[7]).toMatchObject({ endDate: '2032-02-29', days: 182 });
  });

  it('no hike = flat yearly amounts; plan/upfront fields and tenure > 180 months are refused', async () => {
    const t = await seedTenant();
    const body = {
      clientId: t.tenantId, name: 'Flat Plant', type: 'WTP', capacityMld: 10, stateCode: '27',
      omStart: '2026-10-01', omTenureMonths: 60,
      subscription: { startDate: '2026-10-01', termYears: 3, pricePerYear: '40000' },
    };
    const pv = await api().post('/api/admin/v1/plants/preview').set(A()).send(body);
    expect(pv.status).toBe(200);
    expect(pv.body.data.schedule.map((s: { amount: string }) => s.amount)).toEqual(['40000.00', '40000.00', '40000.00']);
    const upfront = await api().post('/api/admin/v1/plants/preview').set(A())
      .send({ ...body, subscription: { ...body.subscription, billingMode: 'upfront' } });
    expect(upfront.status).toBe(400);
    const tooLong = await api().post('/api/admin/v1/plants/preview').set(A()).send({ ...body, omTenureMonths: 181 });
    expect(tooLong.status).toBe(400);
  });
});
