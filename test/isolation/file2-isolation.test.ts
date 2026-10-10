import { withSystem } from '../../src/db/tenant';
import { api, bearer, loginClient, seedPlant, seedTenant } from '../helpers';

describe('tenant isolation: File 2 endpoints', () => {
  it("overview lists only the tenant's plants; another tenant's layout is invisible and untouchable", async () => {
    const A = await seedTenant();
    const B = await seedTenant();
    const aPlant = await seedPlant(A.tenantId);
    const bPlant = await seedPlant(B.tenantId);
    await withSystem((tx) => tx.query(
      `INSERT INTO app.dashboard_layouts (tenant_id, user_id, plant_id, layout) VALUES ($1, $2, $3, '{"version":1,"widgets":["kpis"]}')`,
      [B.tenantId, B.admin.id, bPlant],
    ));
    const { token } = await loginClient(A.admin.email);

    const ov = await api().get('/api/v1/overview').set(bearer(token));
    expect(ov.status).toBe(200);
    expect((ov.body.data.plants as Array<{ plantId: string }>).map((p) => p.plantId)).toEqual([aPlant]);
    const text = JSON.stringify(ov.body);
    for (const id of [B.tenantId, bPlant, B.admin.id]) expect(text).not.toContain(id);

    for (const m of ['get', 'put', 'delete'] as const) {
      const res = await api()[m](`/api/v1/plants/${bPlant}/dashboard/layout`).set(bearer(token)).send({ layout: { version: 1, widgets: [] } });
      expect(res.status, `${m} → ${res.status}`).toBe(404);
    }
    const rows = await withSystem((tx) => tx.query('SELECT layout FROM app.dashboard_layouts WHERE tenant_id = $1', [B.tenantId]));
    expect(rows.rows).toEqual([{ layout: { version: 1, widgets: ['kpis'] } }]);
  });
});
