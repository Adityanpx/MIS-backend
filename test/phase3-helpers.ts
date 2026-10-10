import { withSystem } from '../src/db/tenant';
import { todayIST } from '../src/lib/dates';
import { api, bearer, drainJobs, loginAdmin, loginClient, seedSuperAdmin, seedTenant, uniq } from './helpers';

export const SELLER = {
  legalName: 'Platform Owner Pvt Ltd', tradeName: 'OMMIS', address: { line1: 'Plot 1, Sector 44', city: 'Gurugram', pin: '122003' },
  stateCode: '06', gstin: '06ABCDE1234F1Z5', pan: 'ABCDE1234F', cin: '', email: 'billing@owner.test', phone: '9999999999',
  bank: { accountName: 'Platform Owner Pvt Ltd', accountNo: '1234567890', ifsc: 'HDFC0001234', branch: 'Gurugram' },
  upiId: 'owner@hdfc', signatory: { name: 'A. Owner', designation: 'Director' }, footerTerms: 'Payable by the due date.',
};

let saved: unknown = null;
export async function saveSeller() {
  saved = await withSystem(async (tx) => (await tx.query(`SELECT value FROM app.platform_settings WHERE key = 'seller.company'`)).rows[0]?.value ?? null);
}
export async function restoreSeller() {
  await withSystem((tx) => tx.query(`UPDATE app.platform_settings SET value = $1::jsonb WHERE key = 'seller.company'`, [JSON.stringify(saved ?? {})]));
}

/** Seller configured, plan, client (state 27), plant created through the wizard → first invoice issued by the inline job. */
export async function billingSetup(opts: { sellerState?: '06' | '27'; price?: string } = {}) {
  const sa = await seedSuperAdmin();
  const admin = (await loginAdmin(sa)).token;
  const st = opts.sellerState ?? '06';
  const put = await api().put('/api/admin/v1/settings/company').set(bearer(admin)).send({ ...SELLER, stateCode: st, gstin: `${st}ABCDE1234F1Z5` });
  if (put.status !== 200) throw new Error(`seller: ${JSON.stringify(put.body)}`);
  const plan = await api().post('/api/admin/v1/plans').set(bearer(admin))
    .send({ name: `B ${uniq()}`, code: `B-${uniq()}`.toUpperCase(), termYears: 5, pricePerYear: opts.price ?? '54000' });
  const tenant = await seedTenant();
  const plant = await api().post('/api/admin/v1/plants').set(bearer(admin)).send({
    clientId: tenant.tenantId, name: 'Billing STP', type: 'STP', capacityMld: 120, stateCode: '27', omStart: '2024-09-01',
    omTenureMonths: 60, subscription: { planId: plan.body.data.id, startDate: todayIST(), billingMode: 'yearly' },
  });
  if (plant.status !== 201) throw new Error(`plant: ${JSON.stringify(plant.body)}`);
  await drainJobs();
  const ca = (await loginClient(tenant.admin.email)).token;
  const inv = await withSystem(async (tx) => (await tx.query<{ id: string }>(
    'SELECT id FROM app.invoices WHERE tenant_id = $1 ORDER BY created_at LIMIT 1', [tenant.tenantId])).rows[0]);
  if (!inv) throw new Error('no invoice generated');
  return { sa, admin, tenant, tid: tenant.tenantId, plantId: plant.body.data.id as string, ca, invoiceId: inv.id, planId: plan.body.data.id as string };
}
