import { addDays, todayIST } from '../src/lib/dates';
import { api, bearer, loginAdmin, loginClient, seedSuperAdmin, seedTenant, seedUser, uniq } from './helpers';

/** STP plant (template applied), all go-live settings filled, Live. O&M from 2024-09-01, 60 months. */
export async function livePlant(opts: { maxUsers?: number } = {}) {
  const admin = (await loginAdmin(await seedSuperAdmin())).token;
  const plan = await api().post('/api/admin/v1/plans').set(bearer(admin)).send({
    name: `P2 ${uniq()}`, code: `P2-${uniq()}`.toUpperCase(), termYears: 5, pricePerYear: '50000', maxUsersPerPlant: opts.maxUsers ?? 10 });
  const t = await seedTenant();
  const plant = await api().post('/api/admin/v1/plants').set(bearer(admin)).send({
    clientId: t.tenantId, name: 'Test STP', type: 'STP', capacityMld: 120, stateCode: '27', omStart: '2024-09-01', omTenureMonths: 60,
    subscription: { planId: plan.body.data.id, startDate: todayIST(), billingMode: 'yearly' } });
  if (plant.status !== 201) throw new Error(JSON.stringify(plant.body));
  const plantId = plant.body.data.id as string;
  const ca = (await loginClient(t.admin.email)).token;
  const base = `/api/v1/plants/${plantId}/settings`;
  for (let y = 1; y <= 5; y++) await api().patch(`${base}/contract-years/${y}`).set(bearer(ca)).send({ fixedFee: '20000000' });
  await api().post(`${base}/contract-years/1/components`).set(bearer(ca)).send({ name: 'BGE', parameterCode: 'BGE_KWH', rate: 4.14, stdQtyPerDay: 13000 });
  const items = await api().get(`${base}/stock-items`).set(bearer(ca));
  for (const i of items.body.data) {
    await api().patch(`${base}/stock-items/${i.id}`).set(bearer(ca)).send({ openingBalance: 5000, openingDate: '2024-08-31' });
  }
  await api().patch(`${base}/cash`).set(bearer(ca)).send({ cashOpening: 15000, cashOpeningDate: '2024-08-31' });
  const live = await api().post(`${base}/go-live`).set(bearer(ca));
  if (!live.body.data?.ready) throw new Error(`go-live failed: ${JSON.stringify(live.body)}`);
  const editor = await seedUser(t.tenantId, [{ plantId, role: 'editor' }]);
  const viewer = await seedUser(t.tenantId, [{ plantId, role: 'viewer' }]);
  return {
    tenant: t, plantId, ca, admin,
    editor: { ...editor, token: (await loginClient(editor.email)).token },
    viewer: { ...viewer, token: (await loginClient(viewer.email)).token },
    yesterday: addDays(todayIST(), -1),
  };
}

/** Builds valid values for every typed field of the form (within standards, staff = strength). */
export function validValues(form: { blocks: Array<{ fields: Array<Record<string, unknown>> }>; context: { staff: Array<{ presentCode: string; strength: number }> } }) {
  const present = new Map(form.context.staff.map((s) => [s.presentCode, s.strength]));
  return form.blocks.flatMap((b) => b.fields).filter((f) => f.inputMode !== 'calculated').map((f) => {
    const st = f.standard as { std: number | null; min: number | null; max: number | null } | null;
    let value: number | string | null;
    if (f.aggregation === 'text') value = 'ok';
    else if (present.has(f.code as string)) value = present.get(f.code as string)!;
    else if (String(f.code).startsWith('STAFF_')) value = 0;
    else if (st?.max != null) value = st.min != null ? (st.min + st.max) / 2 : Math.floor(st.max / 2);
    else if (st?.std != null) value = Math.min(st.std, (f.hardMax as number | null) ?? Infinity);
    else value = 1;
    return { parameterId: f.parameterId as string, value };
  });
}
