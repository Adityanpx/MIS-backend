import { authenticator } from 'otplib';
import { withSystem } from '../../src/db/tenant';
import { testMailbox } from '../../src/modules/notifications/email.adapter';
import { drainEmails } from '../../src/modules/notifications/email.service';
import { api, bearer, cookieFrom, lastEmailToken, loginClient, PASSWORD, seedTenant, seedUser } from '../helpers';

describe('client auth', () => {
  it('logs in, returns the profile and a refresh cookie; /me works', async () => {
    const t = await seedTenant();
    const res = await api().post('/api/v1/auth/login').send({ email: t.admin.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mfaRequired: false, user: { email: t.admin.email, isClientAdmin: true } });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/api/v1/auth');
    const me = await api().get('/api/v1/me').set(bearer(res.body.data.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.tenant.id).toBe(t.tenantId);
  });

  it('same error for unknown email and wrong password', async () => {
    const t = await seedTenant();
    const a = await api().post('/api/v1/auth/login').send({ email: 'nobody@test.local', password: 'whatever123' });
    const b = await api().post('/api/v1/auth/login').send({ email: t.admin.email, password: 'wrong-pass-123' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(b.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after 5 failures and emails the user (AUTH-04)', async () => {
    const t = await seedTenant();
    for (let i = 0; i < 5; i++) {
      await api().post('/api/v1/auth/login').send({ email: t.admin.email, password: 'wrong-pass-123' });
    }
    const res = await api().post('/api/v1/auth/login').send({ email: t.admin.email, password: PASSWORD });
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    await drainEmails();
    expect(testMailbox.some((m) => m.to.includes(t.admin.email) && m.subject.includes('locked'))).toBe(true);
  });

  it('rotates refresh tokens and revokes the whole family when an old token is reused', async () => {
    const t = await seedTenant();
    const s = await loginClient(t.admin.email);
    const r1 = await api().post('/api/v1/auth/refresh').set('Cookie', s.cookie);
    expect(r1.status).toBe(200);
    const newCookie = cookieFrom(r1, 'rt')!;
    expect(newCookie).not.toBe(s.cookie);
    // Pretend the first rotation happened a minute ago (outside the 10 s multi-tab grace period).
    await withSystem((tx) => tx.query(
      `UPDATE app.refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE user_id = $1 AND replaced_by IS NOT NULL`,
      [t.admin.id]));
    const reuse = await api().post('/api/v1/auth/refresh').set('Cookie', s.cookie);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('TOKEN_REVOKED');
    const after = await api().post('/api/v1/auth/refresh').set('Cookie', newCookie);
    expect(after.status).toBe(401); // the thief's and the victim's tokens are both dead
  });

  it('rejects refresh from a foreign Origin', async () => {
    const t = await seedTenant();
    const s = await loginClient(t.admin.email);
    const res = await api().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('logout-all invalidates existing access tokens immediately', async () => {
    const t = await seedTenant();
    const s = await loginClient(t.admin.email);
    expect((await api().get('/api/v1/me').set(bearer(s.token))).status).toBe(200);
    expect((await api().post('/api/v1/auth/logout-all').set(bearer(s.token))).status).toBe(204);
    const me = await api().get('/api/v1/me').set(bearer(s.token));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('TOKEN_REVOKED');
  });

  it('forgot + reset password; the link works once', async () => {
    const t = await seedTenant();
    expect((await api().post('/api/v1/auth/forgot').send({ email: t.admin.email })).status).toBe(200);
    expect((await api().post('/api/v1/auth/forgot').send({ email: 'nobody@test.local' })).status).toBe(200);
    const token = await lastEmailToken(t.admin.email, 'reset-password');
    const r = await api().post('/api/v1/auth/reset').send({ token, password: 'NewPassw0rd-9' });
    expect(r.status).toBe(200);
    expect((await api().post('/api/v1/auth/reset').send({ token, password: 'NewPassw0rd-9' })).body.error.code).toBe('TOKEN_INVALID');
    await loginClient(t.admin.email, 'NewPassw0rd-9');
  });

  it('optional 2FA: setup → enable → login needs the code', async () => {
    const t = await seedTenant();
    const s = await loginClient(t.admin.email);
    const setup = await api().post('/api/v1/me/2fa/setup').set(bearer(s.token));
    expect(setup.status).toBe(200);
    const secret = setup.body.data.secret as string;
    expect((await api().post('/api/v1/me/2fa/enable').set(bearer(s.token)).send({ code: authenticator.generate(secret) })).status).toBe(204);
    const l = await api().post('/api/v1/auth/login').send({ email: t.admin.email, password: PASSWORD });
    expect(l.body.data).toMatchObject({ mfaRequired: true, mfaPurpose: 'verify' });
    const bad = await api().post('/api/v1/auth/2fa/verify').send({ mfaToken: l.body.data.mfaToken, code: '000000' });
    expect(bad.status).toBe(401);
    const ok = await api().post('/api/v1/auth/2fa/verify').send({ mfaToken: l.body.data.mfaToken, code: authenticator.generate(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toBeTruthy();
  });

  it('forced 2FA: enrolment during login; cannot disable afterwards', async () => {
    const t = await seedTenant({ force2fa: true });
    const l = await api().post('/api/v1/auth/login').send({ email: t.admin.email, password: PASSWORD });
    expect(l.body.data).toMatchObject({ mfaRequired: true, mfaPurpose: 'enrol' });
    const start = await api().post('/api/v1/auth/2fa/enrol/start').send({ mfaToken: l.body.data.mfaToken });
    const secret = start.body.data.secret as string;
    const done = await api().post('/api/v1/auth/2fa/enrol/confirm')
      .send({ mfaToken: l.body.data.mfaToken, code: authenticator.generate(secret) });
    expect(done.status).toBe(200);
    const dis = await api().post('/api/v1/me/2fa/disable').set(bearer(done.body.data.accessToken))
      .send({ code: authenticator.generate(secret) });
    expect(dis.body.error.code).toBe('TWO_FACTOR_REQUIRED');
  });

  it('Client Admin must accept the Terms before using the app (AUTH-12)', async () => {
    const t = await seedTenant({ acceptTerms: false });
    const s = await loginClient(t.admin.email);
    expect((await api().get('/api/v1/me').set(bearer(s.token))).body.data.mustAcceptTerms).toBe(true);
    expect((await api().get('/api/v1/company').set(bearer(s.token))).body.error.code).toBe('TERMS_NOT_ACCEPTED');
    expect((await api().post('/api/v1/me/accept-terms').set(bearer(s.token))).status).toBe(200);
    expect((await api().get('/api/v1/company').set(bearer(s.token))).status).toBe(200);
  });

  it('a disabled user is signed out', async () => {
    const t = await seedTenant();
    const u = await seedUser(t.tenantId);
    const a = await loginClient(t.admin.email);
    const s = await loginClient(u.email);
    expect((await api().post(`/api/v1/company/users/${u.id}/disable`).set(bearer(a.token))).status).toBe(200);
    expect((await api().get('/api/v1/me').set(bearer(s.token))).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD })).status).toBe(401);
  });
});
