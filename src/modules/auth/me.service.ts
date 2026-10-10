import { exec, one, setClause } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { decrypt, encrypt } from '../../lib/crypto';
import { badRequest, conflict, forbidden, unauthorized, unprocessable } from '../../lib/errors';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../../lib/password';
import type { RequestMeta } from '../../lib/request-meta';
import { generateTotpSecret, totpUri, verifyTotp } from '../../lib/totp';
import { invalidateClientAuthCache } from '../../middleware/auth-client';
import type { ClientCtx } from '../../types/express';
import { clientActor, diff, writeAudit } from '../audit/audit.service';
import { currentTermsVersion, platformName } from '../platform/settings.service';
import { bumpTokenVersion, revokeAllRefreshTokens } from './auth.repo';
import { issueSession, loadProfile, type IssuedSession, type SessionProfile } from './session';

const txCtx = (ctx: ClientCtx) => ({ tenantId: ctx.tenantId, actorId: ctx.userId });

/** Security settings of the real user must not be changed during a Super Admin support session. */
function denyWhileActingAs(ctx: ClientCtx): void {
  if (ctx.actingAsAdminId) throw forbidden('ACT_AS_NOT_ALLOWED', 'Not allowed during a support session.');
}

export async function getMe(ctx: ClientCtx): Promise<SessionProfile> {
  const actingAs = ctx.actingAsAdminId ? { adminId: ctx.actingAsAdminId, mode: ctx.actAsMode ?? 'view' } : null;
  return withTenant(txCtx(ctx), (tx) => loadProfile(tx, ctx.tenantId, ctx.userId, actingAs));
}

export async function updateMe(
  ctx: ClientCtx,
  patch: { name?: string; mobile?: string; designation?: string },
  meta: RequestMeta,
): Promise<SessionProfile> {
  return withTenant(txCtx(ctx), async (tx) => {
    const before = await one<Record<string, unknown>>(
      tx, 'SELECT name, mobile, designation FROM app.users WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId]);
    const set = setClause({ name: patch.name, mobile: patch.mobile, designation: patch.designation }, 3);
    if (set.values.length > 0) {
      const after = await one<Record<string, unknown>>(
        tx,
        `UPDATE app.users SET ${set.sql} WHERE tenant_id = $1 AND id = $2 RETURNING name, mobile, designation`,
        [ctx.tenantId, ctx.userId, ...set.values],
      );
      await writeAudit(tx, clientActor(ctx), { action: 'user.profile_update', entity: 'user', entityId: ctx.userId, ...diff(before, after) }, meta);
    }
    return loadProfile(tx, ctx.tenantId, ctx.userId);
  });
}

/** PRD AUTH-06: change password; all other sessions end; this device gets a fresh session. */
export async function changePassword(
  ctx: ClientCtx,
  currentPassword: string,
  newPassword: string,
  meta: RequestMeta,
): Promise<IssuedSession> {
  denyWhileActingAs(ctx);
  assertPasswordPolicy(newPassword);
  const { password_hash } = await withTenant(txCtx(ctx), (tx) =>
    one<{ password_hash: string | null }>(
      tx, 'SELECT password_hash FROM app.users WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId]),
  );
  if (!(await verifyPassword(password_hash, currentPassword))) {
    throw badRequest('INVALID_CURRENT_PASSWORD', 'The current password is incorrect.');
  }
  if (await verifyPassword(password_hash, newPassword)) {
    throw unprocessable('PASSWORD_REUSE', 'The new password must be different from the current one.');
  }
  const newHash = await hashPassword(newPassword);
  const session = await withTenant(txCtx(ctx), async (tx) => {
    await exec(tx, 'UPDATE app.users SET password_hash = $3 WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId, newHash]);
    await bumpTokenVersion(tx, ctx.tenantId, ctx.userId);
    await revokeAllRefreshTokens(tx, ctx.tenantId, ctx.userId);
    await writeAudit(tx, clientActor(ctx), { action: 'auth.password_change', entity: 'user', entityId: ctx.userId }, meta);
    return issueSession(tx, ctx.tenantId, ctx.userId, meta);
  });
  invalidateClientAuthCache(ctx.userId);
  return session;
}

export async function setupTotp(ctx: ClientCtx): Promise<{ secret: string; otpauthUrl: string }> {
  denyWhileActingAs(ctx);
  return withTenant(txCtx(ctx), async (tx) => {
    const u = await one<{ email: string; totp_enabled: boolean }>(
      tx, 'SELECT email, totp_enabled FROM app.users WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId]);
    if (u.totp_enabled) throw conflict('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
    const secret = generateTotpSecret();
    await exec(tx, 'UPDATE app.users SET totp_secret_enc = $3 WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId, encrypt(secret)]);
    return { secret, otpauthUrl: totpUri(u.email, secret, await platformName()) };
  });
}

export async function enableTotp(ctx: ClientCtx, code: string, meta: RequestMeta): Promise<void> {
  denyWhileActingAs(ctx);
  await withTenant(txCtx(ctx), async (tx) => {
    const u = await one<{ totp_enabled: boolean; totp_secret_enc: string | null }>(
      tx, 'SELECT totp_enabled, totp_secret_enc FROM app.users WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId]);
    if (u.totp_enabled) throw conflict('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
    if (!u.totp_secret_enc) throw badRequest('TWO_FACTOR_NOT_STARTED', 'Start the two-factor setup first.');
    if (!verifyTotp(code, decrypt(u.totp_secret_enc))) throw unauthorized('INVALID_CODE', 'The verification code is incorrect.');
    await exec(tx, 'UPDATE app.users SET totp_enabled = true WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId]);
    await writeAudit(tx, clientActor(ctx), { action: 'auth.2fa_enabled', entity: 'user', entityId: ctx.userId }, meta);
  });
}

export async function disableTotp(ctx: ClientCtx, code: string, meta: RequestMeta): Promise<void> {
  denyWhileActingAs(ctx);
  await withTenant(txCtx(ctx), async (tx) => {
    const u = await one<{ totp_enabled: boolean; totp_secret_enc: string | null; force_2fa: boolean }>(
      tx,
      `SELECT u.totp_enabled, u.totp_secret_enc, c.force_2fa FROM app.users u JOIN app.clients c ON c.id = u.tenant_id
        WHERE u.tenant_id = $1 AND u.id = $2`,
      [ctx.tenantId, ctx.userId],
    );
    if (!u.totp_enabled || !u.totp_secret_enc) throw conflict('TWO_FACTOR_NOT_ENABLED', 'Two-factor authentication is not enabled.');
    if (u.force_2fa) throw unprocessable('TWO_FACTOR_REQUIRED', 'Your company requires two-factor authentication.');
    if (!verifyTotp(code, decrypt(u.totp_secret_enc))) throw unauthorized('INVALID_CODE', 'The verification code is incorrect.');
    await exec(tx, 'UPDATE app.users SET totp_enabled = false, totp_secret_enc = NULL WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId]);
    await writeAudit(tx, clientActor(ctx), { action: 'auth.2fa_disabled', entity: 'user', entityId: ctx.userId }, meta);
  });
}

/** PRD AUTH-12: a Client Admin accepts the current Terms for the whole company. */
export async function acceptTerms(ctx: ClientCtx, meta: RequestMeta): Promise<{ termsVersion: string }> {
  denyWhileActingAs(ctx);
  const version = await currentTermsVersion();
  await withTenant(txCtx(ctx), async (tx) => {
    await exec(
      tx,
      `UPDATE app.clients SET terms_version = $2, terms_accepted_at = now(), terms_accepted_by = $3 WHERE id = $1`,
      [ctx.tenantId, version, ctx.userId],
    );
    await writeAudit(tx, clientActor(ctx), {
      action: 'client.terms_accepted', entity: 'client', entityId: ctx.tenantId, after: { version },
    }, meta);
  });
  invalidateClientAuthCache(); // every cached ctx of this tenant carries tenantTermsVersion
  return { termsVersion: version };
}
