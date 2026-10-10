import { withSystem } from '../../src/db/tenant';
import { api, bearer, seedTenant, uniq } from '../helpers';
import { billingSetup, restoreSeller, saveSeller } from '../phase3-helpers';

beforeAll(saveSeller);
afterAll(restoreSeller);

describe('Super Admin path filters', () => {
  it("a resource of client B addressed under /clients/A/… is 404", async () => {
    const a = await billingSetup();
    const B = await seedTenant();
    const ids = await withSystem(async (tx) => {
      const q = async (sql: string, p: unknown[]) => (await tx.query<{ id: string }>(sql, p)).rows[0]!.id;
      return {
        doc: await q(`INSERT INTO app.client_documents (tenant_id, doc_type, title, file_key) VALUES ($1, 'agreement', 'B agreement', $2) RETURNING id`,
          [B.tenantId, `t/${B.tenantId}/documents/x.pdf`]),
        exp: await q(`INSERT INTO app.exports (tenant_id, scope, status, file_key, expires_at) VALUES ($1, '{}'::jsonb, 'ready', $2, now() + interval '1 day') RETURNING id`,
          [B.tenantId, `t/${B.tenantId}/exports/x.zip`]),
        inv: await q(`INSERT INTO app.invoices (tenant_id, number, kind, status, total, balance) VALUES ($1, $2, 'manual', 'issued', 1, 1) RETURNING id`,
          [B.tenantId, `PF/${uniq()}`]),
      };
    });
    const A = a.tid;
    const H = bearer(a.admin);
    expect((await api().get(`/api/admin/v1/clients/${A}/documents/${ids.doc}/download`).set(H)).status).toBe(404);
    expect((await api().delete(`/api/admin/v1/clients/${A}/documents/${ids.doc}`).set(H)).status).toBe(404);
    expect((await api().get(`/api/admin/v1/clients/${A}/exports/${ids.exp}/download`).set(H)).status).toBe(404);
    expect((await api().post(`/api/admin/v1/clients/${A}/credit/apply`).set(H).send({ invoiceId: ids.inv })).status).toBe(404);
    const still = await withSystem((tx) => tx.query('SELECT count(*)::int AS n FROM app.client_documents WHERE id = $1', [ids.doc]));
    expect(still.rows[0].n).toBe(1);
  });
});
