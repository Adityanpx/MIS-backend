import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { authenticator } from 'otplib';
import { createApp } from '../src/app';
import { withSystem } from '../src/db/tenant';
import { encrypt } from '../src/lib/crypto';
import { hashPassword } from '../src/lib/password';
import { omEndDate } from '../src/modules/domain/contract-years';
import { drainEmails } from '../src/modules/notifications/email.service';
import { testMailbox } from '../src/modules/notifications/email.adapter';
import { currentTermsVersion } from '../src/modules/platform/settings.service';

export const app = createApp();
export const api = () => request(app);
export const uniq = () => randomUUID().slice(0, 8);
export const PASSWORD = 'Passw0rd-123';
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let pwHash: string | undefined;
const passwordHash = async () => (pwHash ??= await hashPassword(PASSWORD));

/** "rt=abc" from a Set-Cookie response header. */
export function cookieFrom(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find((c) => c.startsWith(`${name}=`))?.split(';')[0];
}

/** Waits for background emails and returns the token from the last link sent to `email`. */
export async function lastEmailToken(email: string, kind: 'accept-invite' | 'reset-password'): Promise<string> {
  await drainEmails();
  const msg = [...testMailbox].reverse().find((m) => m.to.includes(email) && m.text.includes(`/${kind}/`));
  const token = msg?.text.match(new RegExp(`/${kind}/([A-Za-z0-9_-]+)`))?.[1];
  if (!token) throw new Error(`No ${kind} email for ${email}`);
  return token;
}

// ------------------------------------------------------------------ factories (direct SQL as admin_user)
export interface SeededTenant { tenantId: string; code: string; admin: { id: string; email: string } }

export async function seedTenant(opts: { acceptTerms?: boolean; force2fa?: boolean } = {}): Promise<SeededTenant> {
  const tag = uniq();
  const hash = await passwordHash();
  const terms = opts.acceptTerms === false ? null : await currentTermsVersion();
  return withSystem(async (tx) => {
    const c = await tx.query<{ id: string }>(
      `INSERT INTO app.clients (code, display_name, legal_name, state_code, billing_emails, force_2fa, terms_version)
       VALUES ($1, $2, $3, '27', $4, $5, $6) RETURNING id`,
      [`T-${tag}`, `Tenant ${tag}`, `Tenant ${tag} Pvt Ltd`, [`billing-${tag}@test.local`], opts.force2fa ?? false, terms],
    );
    const tenantId = c.rows[0]!.id;
    const email = `admin-${tag}@test.local`;
    const u = await tx.query<{ id: string }>(
      `INSERT INTO app.users (tenant_id, name, email, password_hash, is_client_admin, status)
       VALUES ($1, $2, $3, $4, true, 'active') RETURNING id`,
      [tenantId, `Admin ${tag}`, email, hash],
    );
    return { tenantId, code: `T-${tag}`, admin: { id: u.rows[0]!.id, email } };
  });
}

export async function seedPlant(tenantId: string, opts: { maxUsers?: number; tenureMonths?: number } = {}): Promise<string> {
  const tag = uniq();
  const omStart = '2024-09-01';
  const tenure = opts.tenureMonths ?? 60;
  return withSystem(async (tx) => {
    const plan = await tx.query<{ id: string }>(
      `INSERT INTO app.plans (name, code, term_years, price_per_year, max_users_per_plant)
       VALUES ($1, $2, 5, 54000, $3) RETURNING id`,
      [`Plan ${tag}`, `PL-${tag}`.toUpperCase(), opts.maxUsers ?? 10],
    );
    const p = await tx.query<{ id: string }>(
      `INSERT INTO app.plants (tenant_id, code, name, type, capacity_mld, state_code, om_start, om_tenure_months, om_end, mis_start)
       VALUES ($1, $2, $3, 'STP', 120, '27', $4, $5, $6, $4) RETURNING id`,
      [tenantId, `P-${tag}`, `Plant ${tag}`, omStart, tenure, omEndDate(omStart, tenure)],
    );
    const plantId = p.rows[0]!.id;
    const snapshot = {
      planId: plan.rows[0]!.id, name: `Plan ${tag}`, code: `PL-${tag}`, termYears: 5, pricePerYear: '54000.00',
      escalationPct: '0', upfrontDiscountPct: '0', maxUsersPerPlant: opts.maxUsers ?? 10, storageGb: 5, features: {},
    };
    await tx.query(
      `INSERT INTO app.subscriptions (tenant_id, plant_id, plan_id, plan_snapshot, start_date, end_date, billing_mode, status)
       VALUES ($1, $2, $3, $4::jsonb, '2024-09-01', '2029-08-31', 'yearly', 'active')`,
      [tenantId, plantId, plan.rows[0]!.id, JSON.stringify(snapshot)],
    );
    return plantId;
  });
}

export async function seedUser(
  tenantId: string,
  roles: Array<{ plantId: string; role: 'editor' | 'checker' | 'verifier' | 'viewer' }> = [],
  opts: { isClientAdmin?: boolean; totpSecret?: string } = {},
): Promise<{ id: string; email: string }> {
  const tag = uniq();
  const hash = await passwordHash();
  return withSystem(async (tx) => {
    const email = `user-${tag}@test.local`;
    const u = await tx.query<{ id: string }>(
      `INSERT INTO app.users (tenant_id, name, email, password_hash, is_client_admin, status, totp_enabled, totp_secret_enc)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7) RETURNING id`,
      [tenantId, `User ${tag}`, email, hash, opts.isClientAdmin ?? false, !!opts.totpSecret,
        opts.totpSecret ? encrypt(opts.totpSecret) : null],
    );
    for (const r of roles) {
      await tx.query('INSERT INTO app.user_plant_roles (tenant_id, user_id, plant_id, role) VALUES ($1, $2, $3, $4)',
        [tenantId, u.rows[0]!.id, r.plantId, r.role]);
    }
    return { id: u.rows[0]!.id, email };
  });
}

export async function seedSuperAdmin(opts: { withTotp?: boolean } = {}) {
  const tag = uniq();
  const secret = authenticator.generateSecret();
  const email = `sa-${tag}@test.local`;
  const withTotp = opts.withTotp ?? true;
  const id = await withSystem(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.super_admins (name, email, password_hash, status, totp_enabled, totp_secret_enc)
       VALUES ($1, $2, $3, 'active', $4, $5) RETURNING id`,
      [`SA ${tag}`, email, await passwordHash(), withTotp, withTotp ? encrypt(secret) : null],
    );
    return r.rows[0]!.id;
  });
  return { id, email, secret };
}

// ------------------------------------------------------------------ logins
export async function loginClient(email: string, password = PASSWORD): Promise<{ token: string; cookie: string }> {
  const res = await api().post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200 || res.body.data.mfaRequired) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.data.accessToken as string, cookie: cookieFrom(res, 'rt') ?? '' };
}

export async function loginAdmin(sa: { email: string; secret: string }): Promise<{ token: string; cookie: string }> {
  const r1 = await api().post('/api/admin/v1/auth/login').send({ email: sa.email, password: PASSWORD });
  if (r1.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(r1.body)}`);
  const r2 = await api().post('/api/admin/v1/auth/2fa/verify')
    .send({ mfaToken: r1.body.data.mfaToken, code: authenticator.generate(sa.secret) });
  if (r2.status !== 200) throw new Error(`admin 2fa failed: ${JSON.stringify(r2.body)}`);
  return { token: r2.body.data.accessToken as string, cookie: cookieFrom(r2, 'sa_rt') ?? '' };
}

export { drainJobs } from '../src/jobs/boss';
