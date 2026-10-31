/**
 * Acceptance cluster: Authentication & sessions (Schedule A Part 4(c)).
 *
 * Covers T23 from PRD v1.1 §25.2. The Management role is a company-wide, read-only
 * master login added in v1.1 (§2.2, §10A, AUTH-09); this cluster verifies the login
 * redirect, the "sees every plant" guarantee and the server-side write refusal.
 */
import { describe, expect, it } from 'vitest';
import { withSystem } from '../../src/db/tenant';
import { api, bearer, loginClient, seedPlant, seedTenant, seedUser } from '../helpers';

describe('Acceptance — Authentication & sessions', () => {
  it(
    'T23 — Management user logs in: lands on Portfolio home; sees every plant of the company (including one created afterwards); any write API call returns 403',
    async () => {
      const t = await seedTenant();
      const p1 = await seedPlant(t.tenantId);
      const p2 = await seedPlant(t.tenantId);

      // Promote a seeded user to Management (there is no helper flag for this yet).
      const mgmt = await seedUser(t.tenantId);
      await withSystem((tx) =>
        tx.query('UPDATE app.users SET is_management = true, is_client_admin = false WHERE id = $1', [mgmt.id]),
      );

      const { token } = await loginClient(mgmt.email);

      // "Lands on Portfolio home" — the client advertises the Management role; the UI's post-login route
      // uses isManagement to pick the Portfolio home.
      const me = await api().get('/api/v1/me').set(bearer(token));
      expect(me.status).toBe(200);
      expect(me.body.data.user.isManagement).toBe(true);
      expect(me.body.data.plants.map((p: { plantId: string }) => p.plantId).sort()).toEqual([p1, p2].sort());
      for (const p of me.body.data.plants) expect(p.role).toBe('management');

      // "Sees every plant of the company (including one created afterwards)" — plant p3 added after login
      // appears in the session's plant list on the next request.
      const p3 = await seedPlant(t.tenantId);
      const me2 = await api().get('/api/v1/me').set(bearer(token));
      expect(me2.body.data.plants.map((p: { plantId: string }) => p.plantId)).toContain(p3);

      // Portfolio home endpoint responds for Management.
      const port = await api().get('/api/v1/company/portfolio').set(bearer(token));
      expect(port.status).toBe(200);

      // Any write API call returns 403 (GR-17).
      const write1 = await api().patch('/api/v1/company').set(bearer(token)).send({ displayName: 'Attempt' });
      expect(write1.status).toBe(403);
      const write2 = await api().post(`/api/v1/plants/${p1}/breakdowns`).set(bearer(token))
        .send({ equipmentId: '00000000-0000-0000-0000-000000000001', startedAt: '2026-10-01T00:00:00Z' });
      expect(write2.status).toBe(403);
    },
  );
});
