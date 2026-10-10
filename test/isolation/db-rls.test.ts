import { adminPool, appPool } from '../../src/db/pools';
import { seedPlant, seedTenant } from '../helpers';

async function asTenant<T>(tenantId: string | null, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: T[] }>) => Promise<void>) {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await fn((sql, p) => c.query(sql, p as unknown[]) as unknown as Promise<{ rows: T[] }>);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('row-level security (app_user)', () => {
  it('no tenant set → zero rows everywhere (fails closed)', async () => {
    await seedTenant();
    await asTenant(null, async (q) => {
      expect((await q('SELECT count(*)::int AS n FROM app.users')).rows[0]).toEqual({ n: 0 });
      expect((await q('SELECT count(*)::int AS n FROM app.clients')).rows[0]).toEqual({ n: 0 });
    });
  });

  it("tenant A can't see B's rows even without a WHERE clause", async () => {
    const A = await seedTenant();
    const B = await seedTenant();
    await seedPlant(B.tenantId);
    await asTenant(A.tenantId, async (q) => {
      const r = await q('SELECT DISTINCT tenant_id FROM app.users');
      expect(r.rows).toEqual([{ tenant_id: A.tenantId }]);
      expect((await q('SELECT count(*)::int AS n FROM app.plants WHERE tenant_id = $1', [B.tenantId])).rows[0]).toEqual({ n: 0 });
    });
  });

  it("tenant A can't insert rows for B", async () => {
    const A = await seedTenant();
    const B = await seedTenant();
    await asTenant(A.tenantId, async (q) => {
      await expect(q(`INSERT INTO app.users (tenant_id, name, email) VALUES ($1, 'x', 'rls-x@test.local')`, [B.tenantId]))
        .rejects.toMatchObject({ code: '42501' });
    });
  });

  it('app_user has no access to platform tables and cannot change billing data', async () => {
    const A = await seedTenant();
    await asTenant(A.tenantId, async (q) => {
      await expect(q('SELECT * FROM app.plans')).rejects.toMatchObject({ code: '42501' });
    });
    await asTenant(A.tenantId, async (q) => {
      await expect(q("UPDATE app.plants SET om_tenure_months = 180 WHERE tenant_id = $1", [A.tenantId]))
        .rejects.toMatchObject({ code: '42501' });
    });
  });

  it('audit_log is append-only even for admin_user', async () => {
    const c = await adminPool.connect();
    try {
      await expect(c.query("UPDATE app.audit_log SET action = 'x' WHERE id = (SELECT min(id) FROM app.audit_log)"))
        .rejects.toBeTruthy();
    } finally {
      c.release();
    }
  });
});
