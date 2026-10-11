import { LOCKOUT_ATTEMPTS, LOCKOUT_MINUTES, REFRESH_REUSE_GRACE_MS } from '../../config/constants';
import { isProd } from '../../config/env';
import { exec, maybeOne, one, setClause } from '../../db/sql';
import { withAdmin, withSystem } from '../../db/tenant';
import { decrypt, encrypt, sha256 } from '../../lib/crypto';
import { badRequest, conflict, lockedState, unauthorized, unprocessable } from '../../lib/errors';
import { signAdminMfa, verifyAdminMfa } from '../../lib/jwt';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../../lib/password';
import type { RequestMeta } from '../../lib/request-meta';
import { generateTotp, generateTotpSecret, totpUri, verifyTotp } from '../../lib/totp';
import { invalidateAdminAuthCache } from '../../middleware/auth-admin';
import { adminActor, diff, writeAudit } from '../audit/audit.service';
import { queueEmail, renderEmail, sendInBackground } from '../notifications/email.service';
import { platformName } from '../platform/settings.service';
import { createAdminToken, queueAdminResetEmail } from './admin-tokens';
import { issueAdminSession, loadAdminProfile, type AdminProfile, type AdminSession } from './admin-session';

export type AdminLoginResult = {
  kind: 'mfa';
  purpose: 'verify' | 'enrol';
  mfaToken: string;
  /** TEMP TESTING (remove before go-live): current TOTP code, non-production builds only. */
  devCode?: string;
};

interface AdminRow {
  id: string; name: string; email: string; password_hash: string | null; status: string;
  totp_enabled: boolean; totp_secret_enc: string | null; locked_until: string | null;
}
const isLocked = (v: string | null) => !!v && Date.parse(v) > Date.now();
const invalidCredentials = () => unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect.');
const invalidCode = () => unauthorized('INVALID_CODE', 'The verification code is incorrect.');
const invalidLink = () => badRequest('TOKEN_INVALID', 'This link is invalid or has expired.');
const accountLocked = () =>
  lockedState('ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);

const ADMIN_COLS = 'id, name, email, password_hash, status, totp_enabled, totp_secret_enc, locked_until';

async function registerFailure(adminId: string, meta: RequestMeta): Promise<void> {
  const outbox: Array<string | null> = [];
  await withAdmin({ adminId }, async (tx) => {
    const r = await one<{ failed_logins: number; locked_until: string | null; name: string; email: string }>(
      tx,
      `UPDATE app.super_admins SET
          failed_logins = CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_logins + 1 END,
          locked_until  = CASE
            WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_logins + 1 END) >= $2
            THEN now() + make_interval(mins => $3) ELSE NULL END
        WHERE id = $1 RETURNING failed_logins, locked_until, name, email`,
      [adminId, LOCKOUT_ATTEMPTS, LOCKOUT_MINUTES],
    );
    await writeAudit(tx, adminActor(adminId), {
      action: 'admin_auth.login_failed', entity: 'super_admin', entityId: adminId, after: { failedLogins: r.failed_logins },
    }, meta);
    if (r.failed_logins === LOCKOUT_ATTEMPTS) {
      await writeAudit(tx, adminActor(adminId), {
        action: 'admin_auth.account_locked', entity: 'super_admin', entityId: adminId, after: { lockedUntil: r.locked_until },
      }, meta);
      const email = await renderEmail('AUTH_ACCOUNT_LOCKED', { name: r.name, minutes: LOCKOUT_MINUTES });
      outbox.push(await queueEmail(tx, null, [r.email], email));
    }
  });
  sendInBackground(outbox);
}

async function loadMfaAdmin(token: string, purpose: 'verify' | 'enrol'): Promise<AdminRow> {
  const c = verifyAdminMfa(token);
  if (c.typ !== 'mfa' || c.purpose !== purpose) throw unauthorized('TOKEN_INVALID', 'Invalid token');
  const a = await withSystem((tx) => maybeOne<AdminRow>(tx, `SELECT ${ADMIN_COLS} FROM app.super_admins WHERE id = $1`, [c.sub]));
  if (!a || a.status !== 'active') throw unauthorized('TOKEN_INVALID', 'Invalid token');
  if (isLocked(a.locked_until)) throw accountLocked();
  return a;
}

const mfaFor = (a: { id: string; totp_enabled: boolean; totp_secret_enc: string | null }): AdminLoginResult => {
  if (!a.totp_enabled) return { kind: 'mfa', purpose: 'enrol', mfaToken: signAdminMfa({ sub: a.id, purpose: 'enrol' }) };
  const r: AdminLoginResult = { kind: 'mfa', purpose: 'verify', mfaToken: signAdminMfa({ sub: a.id, purpose: 'verify' }) };
  // TEMP TESTING (remove before go-live): show the current code so QA can sign in without a real authenticator app.
  if (!isProd && a.totp_secret_enc) r.devCode = generateTotp(decrypt(a.totp_secret_enc));
  return r;
};

async function startSession(adminId: string, meta: RequestMeta, method: string): Promise<AdminSession> {
  return withAdmin({ adminId }, async (tx) => {
    await exec(tx, 'UPDATE app.super_admins SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [adminId]);
    await writeAudit(tx, adminActor(adminId), {
      action: 'admin_auth.login', entity: 'super_admin', entityId: adminId, after: { method },
    }, meta);
    return issueAdminSession(tx, adminId, meta);
  });
}

// ------------------------------------------------------------------ login & 2FA
/** Password step. ALWAYS ends in a 2FA step (verify or compulsory enrolment). */
export async function adminLogin(email: string, password: string, meta: RequestMeta): Promise<AdminLoginResult> {
  const a = await withSystem((tx) =>
    maybeOne<AdminRow>(tx, `SELECT ${ADMIN_COLS} FROM app.super_admins WHERE lower(email) = lower($1)`, [email]),
  );
  if (!a) {
    await verifyPassword(null, password);
    throw invalidCredentials();
  }
  if (isLocked(a.locked_until)) {
    await verifyPassword(null, password);
    throw accountLocked();
  }
  if (!(await verifyPassword(a.password_hash, password))) {
    if (a.password_hash) await registerFailure(a.id, meta);
    throw invalidCredentials();
  }
  if (a.status !== 'active') throw invalidCredentials();
  return mfaFor(a);
}

export async function adminVerifyMfa(mfaToken: string, code: string, meta: RequestMeta): Promise<AdminSession> {
  const a = await loadMfaAdmin(mfaToken, 'verify');
  if (!a.totp_enabled || !a.totp_secret_enc) throw unauthorized('TOKEN_INVALID', 'Invalid token');
  if (!verifyTotp(code, decrypt(a.totp_secret_enc))) {
    await registerFailure(a.id, meta);
    throw invalidCode();
  }
  return startSession(a.id, meta, 'password+totp');
}

export async function adminEnrolStart(mfaToken: string): Promise<{ secret: string; otpauthUrl: string }> {
  const a = await loadMfaAdmin(mfaToken, 'enrol');
  if (a.totp_enabled) throw conflict('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
  const secret = generateTotpSecret();
  await withAdmin({ adminId: a.id }, (tx) =>
    exec(tx, 'UPDATE app.super_admins SET totp_secret_enc = $2 WHERE id = $1', [a.id, encrypt(secret)]),
  );
  return { secret, otpauthUrl: totpUri(a.email, secret, `${await platformName()} Admin`) };
}

export async function adminEnrolConfirm(mfaToken: string, code: string, meta: RequestMeta): Promise<AdminSession> {
  const a = await loadMfaAdmin(mfaToken, 'enrol');
  if (!a.totp_secret_enc) throw badRequest('TWO_FACTOR_NOT_STARTED', 'Start the two-factor setup first.');
  if (!verifyTotp(code, decrypt(a.totp_secret_enc))) {
    await registerFailure(a.id, meta);
    throw invalidCode();
  }
  return withAdmin({ adminId: a.id }, async (tx) => {
    await exec(
      tx,
      'UPDATE app.super_admins SET totp_enabled = true, failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
      [a.id],
    );
    await writeAudit(tx, adminActor(a.id), { action: 'admin_auth.2fa_enabled', entity: 'super_admin', entityId: a.id }, meta);
    await writeAudit(tx, adminActor(a.id), {
      action: 'admin_auth.login', entity: 'super_admin', entityId: a.id, after: { method: 'password+totp-enrol' },
    }, meta);
    return issueAdminSession(tx, a.id, meta);
  });
}

// ------------------------------------------------------------------ refresh & logout
type Outcome = { ok: true; session: AdminSession } | { ok: false; code: 'TOKEN_REVOKED' | 'TOKEN_EXPIRED' };

export async function adminRefresh(rawToken: string, meta: RequestMeta): Promise<AdminSession> {
  const outcome = await withSystem(async (tx): Promise<Outcome | null> => {
    const rt = await maybeOne<{
      id: string; super_admin_id: string; family_id: string; revoked_at: string | null; replaced_by: string | null; expires_at: string;
    }>(
      tx,
      `SELECT id, super_admin_id, family_id, revoked_at, replaced_by, expires_at
         FROM app.super_admin_refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [sha256(rawToken)],
    );
    if (!rt) return null;
    if (rt.revoked_at) {
      const recentlyRotated = !!rt.replaced_by && Date.now() - Date.parse(rt.revoked_at) <= REFRESH_REUSE_GRACE_MS;
      if (!recentlyRotated) {
        await exec(
          tx,
          'UPDATE app.super_admin_refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
          [rt.family_id],
        );
        await writeAudit(tx, adminActor(rt.super_admin_id), {
          action: 'admin_auth.refresh_reuse_detected', entity: 'super_admin', entityId: rt.super_admin_id,
          after: { familyId: rt.family_id },
        }, meta);
        return { ok: false, code: 'TOKEN_REVOKED' };
      }
    }
    if (Date.parse(rt.expires_at) <= Date.now()) return { ok: false, code: 'TOKEN_EXPIRED' };
    const a = await one<{ status: string }>(tx, 'SELECT status FROM app.super_admins WHERE id = $1', [rt.super_admin_id]);
    if (a.status !== 'active') return { ok: false, code: 'TOKEN_REVOKED' };
    const session = await issueAdminSession(tx, rt.super_admin_id, meta, rt.family_id);
    await exec(
      tx,
      `UPDATE app.super_admin_refresh_tokens
          SET revoked_at = coalesce(revoked_at, now()), replaced_by = coalesce(replaced_by, $2) WHERE id = $1`,
      [rt.id, session.refreshId],
    );
    return { ok: true, session };
  });
  if (!outcome) throw unauthorized('TOKEN_INVALID', 'Please sign in again.');
  if (!outcome.ok) throw unauthorized(outcome.code, 'Your session is no longer valid. Please sign in again.');
  return outcome.session;
}

export async function adminLogout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
  if (!rawToken) return;
  await withSystem(async (tx) => {
    const r = await maybeOne<{ super_admin_id: string }>(
      tx,
      `UPDATE app.super_admin_refresh_tokens SET revoked_at = coalesce(revoked_at, now())
        WHERE token_hash = $1 RETURNING super_admin_id`,
      [sha256(rawToken)],
    );
    if (r) {
      await writeAudit(tx, adminActor(r.super_admin_id), {
        action: 'admin_auth.logout', entity: 'super_admin', entityId: r.super_admin_id,
      }, meta);
    }
  });
}

export async function adminLogoutAll(adminId: string, meta: RequestMeta): Promise<void> {
  await withAdmin({ adminId }, async (tx) => {
    await exec(tx, 'UPDATE app.super_admins SET token_version = token_version + 1 WHERE id = $1', [adminId]);
    await exec(tx, 'UPDATE app.super_admin_refresh_tokens SET revoked_at = now() WHERE super_admin_id = $1 AND revoked_at IS NULL', [adminId]);
    await writeAudit(tx, adminActor(adminId), { action: 'admin_auth.logout_all', entity: 'super_admin', entityId: adminId }, meta);
  });
  invalidateAdminAuthCache(adminId);
}

// ------------------------------------------------------------------ password flows
export async function adminForgot(email: string, meta: RequestMeta): Promise<void> {
  const a = await withSystem((tx) =>
    maybeOne<AdminRow>(tx, `SELECT ${ADMIN_COLS} FROM app.super_admins WHERE lower(email) = lower($1)`, [email]),
  );
  if (!a || a.status !== 'active') return;
  const id = await withAdmin({ adminId: a.id }, async (tx) => {
    const raw = await createAdminToken(tx, a.id, 'reset');
    await writeAudit(tx, adminActor(a.id), {
      action: 'admin_auth.password_reset_requested', entity: 'super_admin', entityId: a.id,
    }, meta);
    return queueAdminResetEmail(tx, a, raw);
  });
  sendInBackground([id]);
}

async function consumeAdminToken(rawToken: string, purpose: 'invite' | 'reset') {
  return withSystem(async (tx) => {
    const t = await maybeOne<{ id: string; super_admin_id: string; expires_at: string; used_at: string | null }>(
      tx,
      `SELECT id, super_admin_id, expires_at, used_at FROM app.super_admin_auth_tokens
        WHERE token_hash = $1 AND purpose = $2 FOR UPDATE`,
      [sha256(rawToken), purpose],
    );
    if (!t || t.used_at || Date.parse(t.expires_at) <= Date.now()) return null;
    await exec(tx, 'UPDATE app.super_admin_auth_tokens SET used_at = now() WHERE id = $1', [t.id]);
    return t.super_admin_id;
  });
}

export async function adminReset(rawToken: string, password: string, meta: RequestMeta): Promise<void> {
  assertPasswordPolicy(password);
  const hash = await hashPassword(password);
  const adminId = await consumeAdminToken(rawToken, 'reset');
  if (!adminId) throw invalidLink();
  await withAdmin({ adminId }, async (tx) => {
    await exec(
      tx,
      `UPDATE app.super_admins SET password_hash = $2, token_version = token_version + 1, failed_logins = 0, locked_until = NULL
        WHERE id = $1`,
      [adminId, hash],
    );
    await exec(tx, 'UPDATE app.super_admin_refresh_tokens SET revoked_at = now() WHERE super_admin_id = $1 AND revoked_at IS NULL', [adminId]);
    await writeAudit(tx, adminActor(adminId), { action: 'admin_auth.password_reset', entity: 'super_admin', entityId: adminId }, meta);
  });
  invalidateAdminAuthCache(adminId);
}

export async function adminAcceptInvite(rawToken: string, password: string, meta: RequestMeta): Promise<AdminLoginResult> {
  assertPasswordPolicy(password);
  const hash = await hashPassword(password);
  const adminId = await consumeAdminToken(rawToken, 'invite');
  if (!adminId) throw invalidLink();
  const a = await withAdmin({ adminId }, async (tx) => {
    const row = await maybeOne<{ id: string; totp_enabled: boolean; totp_secret_enc: string | null }>(
      tx,
      `UPDATE app.super_admins SET password_hash = $2, status = 'active' WHERE id = $1 AND status = 'invited'
        RETURNING id, totp_enabled, totp_secret_enc`,
      [adminId, hash],
    );
    if (row) {
      await writeAudit(tx, adminActor(adminId), { action: 'super_admin.invite_accepted', entity: 'super_admin', entityId: adminId }, meta);
    }
    return row;
  });
  if (!a) throw invalidLink();
  return mfaFor(a); // compulsory 2FA enrolment comes next
}

// ------------------------------------------------------------------ me
export async function getAdminMe(adminId: string): Promise<AdminProfile> {
  return withAdmin({ adminId }, (tx) => loadAdminProfile(tx, adminId));
}

export async function updateAdminMe(
  adminId: string,
  patch: { name?: string; mobile?: string | null },
  meta: RequestMeta,
): Promise<AdminProfile> {
  return withAdmin({ adminId }, async (tx) => {
    const set = setClause({ name: patch.name, mobile: patch.mobile }, 2);
    if (set.values.length > 0) {
      const before = await one<Record<string, unknown>>(tx, 'SELECT name, mobile FROM app.super_admins WHERE id = $1', [adminId]);
      const after = await one<Record<string, unknown>>(
        tx, `UPDATE app.super_admins SET ${set.sql} WHERE id = $1 RETURNING name, mobile`, [adminId, ...set.values]);
      await writeAudit(tx, adminActor(adminId), {
        action: 'super_admin.profile_update', entity: 'super_admin', entityId: adminId, ...diff(before, after),
      }, meta);
    }
    return loadAdminProfile(tx, adminId);
  });
}

export async function changeAdminPassword(
  adminId: string,
  currentPassword: string,
  newPassword: string,
  meta: RequestMeta,
): Promise<AdminSession> {
  assertPasswordPolicy(newPassword);
  const { password_hash } = await withAdmin({ adminId }, (tx) =>
    one<{ password_hash: string | null }>(tx, 'SELECT password_hash FROM app.super_admins WHERE id = $1', [adminId]),
  );
  if (!(await verifyPassword(password_hash, currentPassword))) {
    throw badRequest('INVALID_CURRENT_PASSWORD', 'The current password is incorrect.');
  }
  if (await verifyPassword(password_hash, newPassword)) {
    throw unprocessable('PASSWORD_REUSE', 'The new password must be different from the current one.');
  }
  const hash = await hashPassword(newPassword);
  const session = await withAdmin({ adminId }, async (tx) => {
    await exec(tx, 'UPDATE app.super_admins SET password_hash = $2, token_version = token_version + 1 WHERE id = $1', [adminId, hash]);
    await exec(tx, 'UPDATE app.super_admin_refresh_tokens SET revoked_at = now() WHERE super_admin_id = $1 AND revoked_at IS NULL', [adminId]);
    await writeAudit(tx, adminActor(adminId), { action: 'admin_auth.password_change', entity: 'super_admin', entityId: adminId }, meta);
    return issueAdminSession(tx, adminId, meta);
  });
  invalidateAdminAuthCache(adminId);
  return session;
}
