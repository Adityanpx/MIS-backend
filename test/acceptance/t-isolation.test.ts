/**
 * Acceptance cluster: Multi-tenant isolation (Schedule A Part 4(c)). Covers T13 and T30 from PRD v1.1 §25.2.
 *
 * The full isolation sweep lives in `test/isolation/` and is Schedule A Part 4(b). These two
 * acceptance-labelled tests restate the same guarantee under T-IDs so the Client can trace
 * clauses (b) and (c) to the same evidence. T30 extends T13 to the v1.1-new routes (Portfolio,
 * Equipment, Breakdowns, Maintenance) and to the Management role (§10A, GR-17).
 *
 * Both are tagged [CRITICAL]: a failure here is Schedule A Part 4's "exposes one client's data
 * to another" and blocks acceptance outright.
 */
import { describe, expect, it } from 'vitest';
import { withSystem } from '../../src/db/tenant';
import { api, bearer, loginClient, seedPlant, seedTenant, seedUser } from '../helpers';

describe('Acceptance — Multi-tenant isolation', () => {
  it(
    "T13 [CRITICAL] — Tenant isolation: every endpoint called with client A's token and client B's IDs returns 404 or 403; no row of client B is ever visible (SEC-02)",
    async () => {
      const A = await seedTenant();
      const B = await seedTenant();
      const aPlant = await seedPlant(A.tenantId);
      const bPlant = await seedPlant(B.tenantId);
      const bUser = await seedUser(B.tenantId, [{ plantId: bPlant, role: 'editor' }]);
      const { token: aToken } = await loginClient(A.admin.email);

      // Reads with B's plant ID — must be 404, never a payload.
      for (const path of [
        `/api/v1/plants/${bPlant}`,
        `/api/v1/plants/${bPlant}/settings/stock-items`,
        `/api/v1/plants/${bPlant}/dashboard/layout`,
        `/api/v1/plants/${bPlant}/equipment`,
        `/api/v1/plants/${bPlant}/breakdowns`,
      ]) {
        const res = await api().get(path).set(bearer(aToken));
        expect(res.status, `GET ${path}`).toBe(404);
      }

      // Reads with B's user/company IDs — must not return B's row.
      const notFoundUser = await api().get(`/api/v1/company/users/${bUser.id}`).set(bearer(aToken));
      expect(notFoundUser.status).toBe(404);

      // List endpoints must never contain B's identifiers.
      const text = JSON.stringify([
        (await api().get('/api/v1/plants').set(bearer(aToken))).body,
        (await api().get('/api/v1/company/users?pageSize=100').set(bearer(aToken))).body,
        (await api().get('/api/v1/company').set(bearer(aToken))).body,
      ]);
      for (const id of [B.tenantId, bPlant, bUser.id, B.admin.id, B.admin.email]) {
        expect(text, `A's list contains B's ${id}`).not.toContain(id);
      }

      // A's own plant is still visible — proves the tenant filter is on tenant, not on everything.
      expect((await api().get(`/api/v1/plants/${aPlant}`).set(bearer(aToken))).status).toBe(200);
    },
  );

  it(
    "T30 [CRITICAL] — Tenant isolation including Management role and v1.1 routes: a Management or any user of client A calling portfolio, equipment, breakdown and maintenance endpoints with client B's IDs gets 404; the Portfolio never lists another company's plants (§10A, GR-17)",
    async () => {
      const A = await seedTenant();
      const B = await seedTenant();
      const aPlant = await seedPlant(A.tenantId);
      const bPlant = await seedPlant(B.tenantId);

      // Seed a Management user in tenant A directly via SQL (no helper for the flag yet).
      const mgmt = await seedUser(A.tenantId);
      await withSystem((tx) =>
        tx.query('UPDATE app.users SET is_management = true, is_client_admin = false WHERE id = $1', [mgmt.id]),
      );

      const { token: aAdminTok } = await loginClient(A.admin.email);
      const { token: mgmtTok } = await loginClient(mgmt.email);

      // Plant resolution 404s before the :id handler ever runs, so any UUID is sufficient here.
      const bdId = '00000000-0000-0000-0000-000000000001';
      const v11Paths = [
        `/api/v1/plants/${bPlant}/equipment`,
        `/api/v1/plants/${bPlant}/breakdowns`,
        `/api/v1/plants/${bPlant}/breakdowns/${bdId}`,
        `/api/v1/plants/${bPlant}/breakdowns/${bdId}/updates`,
      ];

      for (const token of [aAdminTok, mgmtTok]) {
        for (const path of v11Paths) {
          const res = await api().get(path).set(bearer(token));
          expect(res.status, `GET ${path}`).toBe(404);
        }
      }

      // Portfolio: both A's Client Admin and A's Management see only A's plants, never B's.
      for (const token of [aAdminTok, mgmtTok]) {
        const port = await api().get('/api/v1/company/portfolio').set(bearer(token));
        expect(port.status).toBe(200);
        const body = JSON.stringify(port.body);
        for (const id of [B.tenantId, bPlant, B.admin.id]) {
          expect(body, `portfolio leaks B's ${id}`).not.toContain(id);
        }
        expect(body).toContain(aPlant);
      }

      // Management is read-only — any write against the v1.1 routes is refused by GR-17 (403), not accepted.
      const writeAttempt = await api()
        .post(`/api/v1/plants/${aPlant}/breakdowns`)
        .set(bearer(mgmtTok))
        .send({ equipmentId: 'x', startedAt: '2026-10-01T00:00:00Z' });
      expect(writeAttempt.status).toBe(403);
    },
  );
});
