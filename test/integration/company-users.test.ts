import { api, bearer, lastEmailToken, loginClient, PASSWORD, seedPlant, seedTenant, seedUser, uniq } from '../helpers';

describe('company users (CA-05…08)', () => {
  it('invites a user with a plant role; the user accepts and sees only that plant', async () => {
    const t = await seedTenant();
    const p1 = await seedPlant(t.tenantId);
    await seedPlant(t.tenantId);
    const a = await loginClient(t.admin.email);
    const email = `ed-${uniq()}@test.local`;
    const inv = await api().post('/api/v1/company/users').set(bearer(a.token))
      .send({ name: 'Site Editor', email, plantRoles: [{ plantId: p1, role: 'editor' }] });
    expect(inv.status).toBe(201);
    const token = await lastEmailToken(email, 'accept-invite');
    const acc = await api().post('/api/v1/auth/invite/accept').send({ token, password: PASSWORD });
    expect(acc.body.data.plants.map((x: { plantId: string }) => x.plantId)).toEqual([p1]);
    const list = await api().get('/api/v1/plants').set(bearer(acc.body.data.accessToken));
    expect(list.body.data).toHaveLength(1);
    expect((await api().get('/api/v1/company').set(bearer(acc.body.data.accessToken))).status).toBe(403);
  });

  it('enforces the plan user limit per plant (CA-06)', async () => {
    const t = await seedTenant();
    const p = await seedPlant(t.tenantId, { maxUsers: 2 });
    const a = await loginClient(t.admin.email);
    for (let i = 0; i < 2; i++) {
      const r = await api().post('/api/v1/company/users').set(bearer(a.token))
        .send({ name: `User ${i}`, email: `u-${uniq()}@test.local`, plantRoles: [{ plantId: p, role: 'viewer' }] });
      expect(r.status).toBe(201);
    }
    const third = await api().post('/api/v1/company/users').set(bearer(a.token))
      .send({ name: 'User 3', email: `u-${uniq()}@test.local`, plantRoles: [{ plantId: p, role: 'viewer' }] });
    expect(third.status).toBe(422);
    expect(third.body.error.code).toBe('USER_LIMIT_REACHED');
    // Client Admins don't count
    const ca = await api().post('/api/v1/company/users').set(bearer(a.token))
      .send({ name: 'Second Admin', email: `ca-${uniq()}@test.local`, isClientAdmin: true });
    expect(ca.status).toBe(201);
  });

  it('keeps at least one active Client Admin and blocks self-disable (CA-08, E20)', async () => {
    const t = await seedTenant();
    const a = await loginClient(t.admin.email);
    const demote = await api().patch(`/api/v1/company/users/${t.admin.id}`).set(bearer(a.token)).send({ isClientAdmin: false });
    expect(demote.body.error.code).toBe('LAST_CLIENT_ADMIN');
    const self = await api().post(`/api/v1/company/users/${t.admin.id}/disable`).set(bearer(a.token));
    expect(self.body.error.code).toBe('CANNOT_DISABLE_SELF');
  });

  it('plant roles: replace the set; a plant without a role is 404 for that user', async () => {
    const t = await seedTenant();
    const p1 = await seedPlant(t.tenantId);
    const p2 = await seedPlant(t.tenantId);
    const u = await seedUser(t.tenantId, [{ plantId: p1, role: 'viewer' }]);
    const a = await loginClient(t.admin.email);
    const put = await api().put(`/api/v1/company/users/${u.id}/plant-roles`).set(bearer(a.token))
      .send({ roles: [{ plantId: p2, role: 'editor' }] });
    expect(put.body.data.plantRoles).toMatchObject([{ plantId: p2, role: 'editor' }]);
    const s = await loginClient(u.email);
    expect((await api().get(`/api/v1/plants/${p1}`).set(bearer(s.token))).status).toBe(404);
    expect((await api().get(`/api/v1/plants/${p2}`).set(bearer(s.token))).body.data.myRole).toBe('editor');
  });

  it('company audit shows the tenant\'s own actions', async () => {
    const t = await seedTenant();
    const a = await loginClient(t.admin.email);
    await api().patch('/api/v1/company').set(bearer(a.token)).send({ displayName: 'Renamed Co' });
    const audit = await api().get('/api/v1/company/audit').set(bearer(a.token));
    expect(audit.body.data.some((e: { action: string }) => e.action === 'company.update')).toBe(true);
  });
});
