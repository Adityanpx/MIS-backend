import { REFRESH_REUSE_GRACE_MS, LOCKOUT_ATTEMPTS, LOCKOUT_MINUTES } from '../../config/constants';
import { maybeOne, one, exec } from '../../db/sql';
import { withAuthLookup, withTenant } from '../../db/tenant';
import { decrypt, encrypt, sha256 } from '../../lib/crypto';
import { badRequest, conflict, lockedState, unauthorized } from '../../lib/errors';
import { signClientMfa, verifyClientMfa } from '../../lib/jwt';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../../lib/password';
import type { RequestMeta } from '../../lib/request-meta';
import { generateTotpSecret, totpUri, verifyTotp } from '../../lib/totp';
import { invalidateClientAuthCache } from '../../middleware/auth-client';
import { userActor, writeAudit } from '../audit/audit.service';
import { queueEmail, renderEmail, sendInBackground } from '../notifications/email.service';
import { platformName } from '../platform/settings.service';
import {
  bumpTokenVersion, findLoginUser, findRefreshByHash, findUserTokenByHash, isLocked, markLoginSuccess,
  registerLoginFailure, revokeAllRefreshTokens, revokeRefreshFamily, revokeRefreshToken,
} from './auth.repo';
import { issueSession, type IssuedSession } from './session';
import { createUserToken, queueClientResetEmail } from './user-tokens';

export type LoginResult =
  | { kind: 'mfa'; purpose: 'verify' | 'enrol'; mfaToken: string }
  | { kind: 'session'; session: IssuedSession };

const invalidCredentials = () => unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect.');
const invalidCode = () => unauthorized('INVALID_CODE', 'The verification code is incorrect.');
const invalidLink = () => badRequest('TOKEN_INVALID', 'This link is invalid or has expired.');
const accountLocked = () =>
  lockedState('ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);

// ---------------------------------------------------------------- helpers
async function registerFailure(tenantId: string, userId: string, meta: RequestMeta): Promise<void> {
  const outbox: Array<string | null> = [];
  await withTenant({ tenantId, actorId: userId }, async (tx) => {
    const r = await registerLoginFailure(tx, tenantId, userId);
    const actor = userActor(tenantId, userId);
    await writeAudit(tx, actor, {
      action: 'auth.login_failed', entity: 'user', entityId: userId, after: { failedLogins: r.failed_logins },
    }, meta);
    if (r.failed_logins === LOCKOUT_ATTEMPTS) {
      await writeAudit(tx, actor, {
        action: 'auth.account_locked', entity: 'user', entityId: userId, after: { lockedUntil: r.locked_until },
      }, meta);
      const u = await one<{ name: string; email: string }>(
        tx, 'SELECT name, email FROM app.users WHERE tenant_id = $1 AND id = $2', [tenantId, userId]);
      const email = await renderEmail('AUTH_ACCOUNT_LOCKED', { name: u.name, minutes: LOCKOUT_MINUTES });
      outbox.push(await queueEmail(tx, tenantId, [u.email], email));
    }
  });
  sendInBackground(outbox);
}

async function startSession(tenantId: string, userId: string, meta: RequestMeta, how: string): Promise<IssuedSession> {
  return withTenant({ tenantId, actorId: userId }, async (tx) => {
    await markLoginSuccess(tx, tenantId, userId);
    await writeAudit(tx, userActor(tenantId, userId), {
      action: 'auth.login', entity: 'user', entityId: userId, after: { method: how },
    }, meta);
    return issueSession(tx, tenantId, userId, meta);
  });
}

/** After a correct password (or an accepted invite): ask for 2FA, ask for 2FA enrolment, or open a session. */
async function afterFirstFactor(
  u: { id: string; tenant_id: string; totp_enabled: boolean; client_force_2fa: boolean },
  meta: RequestMeta,
): Promise<LoginResult> {
  if (u.totp_enabled) {
    return { kind: 'mfa', purpose: 'verify', mfaToken: signClientMfa({ sub: u.id, tid: u.tenant_id, purpose: 'verify' }) };
  }
  if (u.client_force_2fa) {
    return { kind: 'mfa', purpose: 'enrol', mfaToken: signClientMfa({ sub: u.id, tid: u.tenant_id, purpose: 'enrol' }) };
  }
  return { kind: 'session', session: await startSession(u.tenant_id, u.id, meta, 'password') };
}

interface MfaUser {
  email: string; status: string; totp_enabled: boolean; totp_secret_enc: string | null;
  locked_until: string | null; client_status: string;
}
async function loadMfaUser(token: string, purpose: 'verify' | 'enrol') {
  const c = verifyClientMfa(token);
  if (c.typ !== 'mfa' || c.purpose !== purpose || !c.tid) throw unauthorized('TOKEN_INVALID', 'Invalid token');
  const tenantId = c.tid;
  const userId = c.sub;
  const u = await withTenant({ tenantId, actorId: userId }, (tx) =>
    maybeOne<MfaUser>(
      tx,
      `SELECT u.email, u.status, u.totp_enabled, u.totp_secret_enc, u.locked_until, c.status AS client_status
         FROM app.users u JOIN app.clients c ON c.id = u.tenant_id
        WHERE u.tenant_id = $1 AND u.id = $2`,
      [tenantId, userId],
    ),
  );
  if (!u || u.status !== 'active' || u.client_status === 'deleted') throw unauthorized('TOKEN_INVALID', 'Invalid token');
  if (isLocked(u.locked_until)) throw accountLocked();
  return { tenantId, userId, user: u };
}

// ---------------------------------------------------------------- public API
export async function login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
  const row = await withAuthLookup((tx) => findLoginUser(tx, email));
  if (!row) {
    await verifyPassword(null, password); // same timing as a real check
    throw invalidCredentials();
  }
  if (isLocked(row.locked_until)) {
    await verifyPassword(null, password);
    throw accountLocked();
  }
  const good = await verifyPassword(row.password_hash, password);
  if (!good) {
    if (row.password_hash) await registerFailure(row.tenant_id, row.id, meta); // invited users have no password yet
    throw invalidCredentials();
  }
  if (row.status !== 'active' || row.client_status === 'deleted') throw invalidCredentials();
  return afterFirstFactor(row, meta);
}

export async function verifyMfa(mfaToken: string, code: string, meta: RequestMeta): Promise<IssuedSession> {
  const { tenantId, userId, user } = await loadMfaUser(mfaToken, 'verify');
  if (!user.totp_enabled || !user.totp_secret_enc) throw unauthorized('TOKEN_INVALID', 'Invalid token');
  if (!verifyTotp(code, decrypt(user.totp_secret_enc))) {
    await registerFailure(tenantId, userId, meta);
    throw invalidCode();
  }
  return startSession(tenantId, userId, meta, 'password+totp');
}

/** Forced enrolment (client has force_2fa): step 1, create a secret for the authenticator app. */
export async function startEnrolment(mfaToken: string): Promise<{ secret: string; otpauthUrl: string }> {
  const { tenantId, userId, user } = await loadMfaUser(mfaToken, 'enrol');
  if (user.totp_enabled) throw conflict('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
  const secret = generateTotpSecret();
  await withTenant({ tenantId, actorId: userId }, (tx) =>
    exec(tx, 'UPDATE app.users SET totp_secret_enc = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, userId, encrypt(secret)]),
  );
  return { secret, otpauthUrl: totpUri(user.email, secret, await platformName()) };
}

/** Forced enrolment step 2: confirm the first code, enable 2FA and sign in. */
export async function confirmEnrolment(mfaToken: string, code: string, meta: RequestMeta): Promise<IssuedSession> {
  const { tenantId, userId, user } = await loadMfaUser(mfaToken, 'enrol');
  if (!user.totp_secret_enc) throw badRequest('TWO_FACTOR_NOT_STARTED', 'Start the two-factor setup first.');
  if (!verifyTotp(code, decrypt(user.totp_secret_enc))) {
    await registerFailure(tenantId, userId, meta);
    throw invalidCode();
  }
  return withTenant({ tenantId, actorId: userId }, async (tx) => {
    await exec(tx, 'UPDATE app.users SET totp_enabled = true WHERE tenant_id = $1 AND id = $2', [tenantId, userId]);
    await markLoginSuccess(tx, tenantId, userId);
    const actor = userActor(tenantId, userId);
    await writeAudit(tx, actor, { action: 'auth.2fa_enabled', entity: 'user', entityId: userId }, meta);
    await writeAudit(tx, actor, {
      action: 'auth.login', entity: 'user', entityId: userId, after: { method: 'password+totp-enrol' },
    }, meta);
    return issueSession(tx, tenantId, userId, meta);
  });
}

type RefreshOutcome = { ok: true; session: IssuedSession } | { ok: false; code: 'TOKEN_REVOKED' | 'TOKEN_EXPIRED' };

export async function refreshSession(rawToken: string, meta: RequestMeta): Promise<IssuedSession> {
  const found = await withAuthLookup((tx) => findRefreshByHash(tx, sha256(rawToken)));
  if (!found) throw unauthorized('TOKEN_INVALID', 'Please sign in again.');
  const { tenant_id: tenantId, user_id: userId, family_id: familyId, id } = found;

  // Decide inside the transaction, throw AFTER commit (a throw inside would roll back the family revocation).
  const outcome = await withTenant({ tenantId, actorId: userId }, async (tx): Promise<RefreshOutcome> => {
    const rt = await one<{ revoked_at: string | null; expires_at: string; replaced_by: string | null }>(
      tx,
      'SELECT revoked_at, expires_at, replaced_by FROM app.refresh_tokens WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [tenantId, id],
    );
    if (rt.revoked_at) {
      const recentlyRotated = !!rt.replaced_by && Date.now() - Date.parse(rt.revoked_at) <= REFRESH_REUSE_GRACE_MS;
      if (!recentlyRotated) {
        await revokeRefreshFamily(tx, tenantId, familyId);
        await writeAudit(tx, userActor(tenantId, userId), {
          action: 'auth.refresh_reuse_detected', entity: 'user', entityId: userId, after: { familyId },
        }, meta);
        return { ok: false, code: 'TOKEN_REVOKED' };
      }
    }
    if (Date.parse(rt.expires_at) <= Date.now()) {
      await revokeRefreshToken(tx, tenantId, id);
      return { ok: false, code: 'TOKEN_EXPIRED' };
    }
    const u = await maybeOne<{ status: string; client_status: string }>(
      tx,
      `SELECT u.status, c.status AS client_status FROM app.users u JOIN app.clients c ON c.id = u.tenant_id
        WHERE u.tenant_id = $1 AND u.id = $2`,
      [tenantId, userId],
    );
    if (!u || u.status !== 'active' || u.client_status === 'deleted') {
      await revokeAllRefreshTokens(tx, tenantId, userId);
      return { ok: false, code: 'TOKEN_REVOKED' };
    }
    const session = await issueSession(tx, tenantId, userId, meta, familyId);
    await revokeRefreshToken(tx, tenantId, id, session.refreshId);
    return { ok: true, session };
  });
  if (!outcome.ok) {
    throw unauthorized(outcome.code, outcome.code === 'TOKEN_EXPIRED' ? 'Session expired. Please sign in again.'
      : 'Your session is no longer valid. Please sign in again.');
  }
  return outcome.session;
}

export async function logout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
  if (!rawToken) return;
  const found = await withAuthLookup((tx) => findRefreshByHash(tx, sha256(rawToken)));
  if (!found) return;
  await withTenant({ tenantId: found.tenant_id, actorId: found.user_id }, async (tx) => {
    await revokeRefreshToken(tx, found.tenant_id, found.id);
    await writeAudit(tx, userActor(found.tenant_id, found.user_id), {
      action: 'auth.logout', entity: 'user', entityId: found.user_id,
    }, meta);
  });
}

/** PRD AUTH-07: sign out of all devices (access tokens stop working within the 30 s auth cache). */
export async function logoutAll(tenantId: string, userId: string, meta: RequestMeta): Promise<void> {
  await withTenant({ tenantId, actorId: userId }, async (tx) => {
    await bumpTokenVersion(tx, tenantId, userId);
    await revokeAllRefreshTokens(tx, tenantId, userId);
    await writeAudit(tx, userActor(tenantId, userId), { action: 'auth.logout_all', entity: 'user', entityId: userId }, meta);
  });
  invalidateClientAuthCache(userId);
}

/** Always succeeds (never reveals whether the email exists). */
export async function forgotPassword(email: string, meta: RequestMeta): Promise<void> {
  const row = await withAuthLookup((tx) => findLoginUser(tx, email));
  if (!row || row.status !== 'active' || row.client_status === 'deleted') return;
  const outbox = await withTenant({ tenantId: row.tenant_id, actorId: row.id }, async (tx) => {
    const raw = await createUserToken(tx, row.tenant_id, row.id, 'reset');
    await writeAudit(tx, userActor(row.tenant_id, row.id), {
      action: 'auth.password_reset_requested', entity: 'user', entityId: row.id,
    }, meta);
    return queueClientResetEmail(tx, row.tenant_id, row, raw);
  });
  sendInBackground([outbox]);
}

export async function resetPassword(rawToken: string, password: string, meta: RequestMeta): Promise<void> {
  assertPasswordPolicy(password);
  const t = await withAuthLookup((tx) => findUserTokenByHash(tx, sha256(rawToken), 'reset'));
  if (!t || t.used_at || Date.parse(t.expires_at) <= Date.now()) throw invalidLink();
  const passwordHash = await hashPassword(password);
  const done = await withTenant({ tenantId: t.tenant_id, actorId: t.user_id }, async (tx) => {
    const locked = await one<{ used_at: string | null }>(
      tx, 'SELECT used_at FROM app.auth_tokens WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [t.tenant_id, t.id]);
    if (locked.used_at) return false;
    await exec(tx, 'UPDATE app.auth_tokens SET used_at = now() WHERE tenant_id = $1 AND id = $2', [t.tenant_id, t.id]);
    const n = await exec(
      tx,
      `UPDATE app.users SET password_hash = $3, token_version = token_version + 1, failed_logins = 0, locked_until = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
      [t.tenant_id, t.user_id, passwordHash],
    );
    if (n === 0) return false;
    await revokeAllRefreshTokens(tx, t.tenant_id, t.user_id);
    await writeAudit(tx, userActor(t.tenant_id, t.user_id), {
      action: 'auth.password_reset', entity: 'user', entityId: t.user_id,
    }, meta);
    return true;
  });
  if (!done) throw invalidLink();
  invalidateClientAuthCache(t.user_id);
}

/** PRD AUTH-08: invited user sets a password, becomes active and is signed in (or sent to 2FA enrolment). */
export async function acceptInvite(rawToken: string, password: string, meta: RequestMeta): Promise<LoginResult> {
  assertPasswordPolicy(password);
  const t = await withAuthLookup((tx) => findUserTokenByHash(tx, sha256(rawToken), 'invite'));
  if (!t || t.used_at || Date.parse(t.expires_at) <= Date.now()) throw invalidLink();
  const passwordHash = await hashPassword(password);
  const user = await withTenant({ tenantId: t.tenant_id, actorId: t.user_id }, async (tx) => {
    const locked = await one<{ used_at: string | null }>(
      tx, 'SELECT used_at FROM app.auth_tokens WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [t.tenant_id, t.id]);
    if (locked.used_at) return null;
    const u = await maybeOne<{ id: string; tenant_id: string; totp_enabled: boolean }>(
      tx,
      `UPDATE app.users SET password_hash = $3, status = 'active', failed_logins = 0, locked_until = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = 'invited'
        RETURNING id, tenant_id, totp_enabled`,
      [t.tenant_id, t.user_id, passwordHash],
    );
    if (!u) return null;
    await exec(tx, 'UPDATE app.auth_tokens SET used_at = now() WHERE tenant_id = $1 AND id = $2', [t.tenant_id, t.id]);
    await writeAudit(tx, userActor(t.tenant_id, t.user_id), {
      action: 'user.invite_accepted', entity: 'user', entityId: t.user_id,
    }, meta);
    const c = await one<{ force_2fa: boolean }>(tx, 'SELECT force_2fa FROM app.clients WHERE id = $1', [t.tenant_id]);
    return { ...u, client_force_2fa: c.force_2fa };
  });
  if (!user) throw invalidLink();
  invalidateClientAuthCache(t.user_id);
  return afterFirstFactor(user, meta);
}
