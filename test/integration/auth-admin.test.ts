import { authenticator } from 'otplib';
import { api, bearer, loginAdmin, loginClient, PASSWORD, seedSuperAdmin, seedTenant } from '../helpers';

describe('super admin auth', () => {
  it('password alone never gives a token (2FA compulsory); enrolment for a new admin', async () => {
    const sa = await seedSuperAdmin({ withTotp: false });
    const l = await api().post('/api/admin/v1/auth/login').send({ email: sa.email, password: PASSWORD });
    expect(l.body.data).toMatchObject({ mfaRequired: true, mfaPurpose: 'enrol' });
    expect(l.body.data.accessToken).toBeUndefined();
    const start = await api().post('/api/admin/v1/auth/2fa/enrol/start').send({ mfaToken: l.body.data.mfaToken });
    const done = await api().post('/api/admin/v1/auth/2fa/enrol/confirm')
      .send({ mfaToken: l.body.data.mfaToken, code: authenticator.generate(start.body.data.secret) });
    expect(done.status).toBe(200);
    expect((await api().get('/api/admin/v1/me').set(bearer(done.body.data.accessToken))).status).toBe(200);
  });

  it('client and admin tokens are not interchangeable', async () => {
    const sa = await seedSuperAdmin();
    const admin = await loginAdmin(sa);
    const t = await seedTenant();
    const client = await loginClient(t.admin.email);
    expect((await api().get('/api/v1/me').set(bearer(admin.token))).status).toBe(401);
    expect((await api().get('/api/admin/v1/me').set(bearer(client.token))).status).toBe(401);
    // a client MFA token can't complete an admin login
    const cl = await api().post('/api/admin/v1/auth/2fa/verify').send({ mfaToken: client.token, code: '123456' });
    expect(cl.status).toBe(401);
  });

  it('refresh rotation and logout-all for admins', async () => {
    const sa = await seedSuperAdmin();
    const s = await loginAdmin(sa);
    const r = await api().post('/api/admin/v1/auth/refresh').set('Cookie', s.cookie);
    expect(r.status).toBe(200);
    expect((await api().post('/api/admin/v1/auth/logout-all').set(bearer(r.body.data.accessToken))).status).toBe(204);
    expect((await api().get('/api/admin/v1/me').set(bearer(r.body.data.accessToken))).status).toBe(401);
  });

  it('cannot disable yourself', async () => {
    const sa = await seedSuperAdmin();
    const s = await loginAdmin(sa);
    const r = await api().post(`/api/admin/v1/super-admins/${sa.id}/disable`).set(bearer(s.token));
    expect(r.status).toBe(409);
  });
});
