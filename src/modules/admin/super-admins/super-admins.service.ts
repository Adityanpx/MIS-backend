import { exec, many, maybeOne, one, setClause } from '../../../db/sql';
import { isUniqueViolation } from '../../../db/errors';
import { withAdmin, type AdminTxCtx, type Tx } from '../../../db/tenant';
import { conflict, notFound } from '../../../lib/errors';
import type { RequestMeta } from '../../../lib/request-meta';
import { invalidateAdminAuthCache } from '../../../middleware/auth-admin';
import { invalidateClientAuthCache } from '../../../middleware/auth-client';
import { createAdminToken, queueAdminInviteEmail, queueAdminResetEmail } from '../../admin-auth/admin-tokens';
import { adminActor, diff, writeAudit } from '../../audit/audit.service';
import { sendInBackground } from '../../notifications/email.service';

export interface SuperAdminDto {
  id: string; name: string; email: string; mobile: string | null; status: string;
  totpEnabled: boolean; lastLoginAt: string | null; createdAt: string;
}
interface Row {
  id: string; name: string; email: string; mobile: string | null; status: string;
  totp_enabled: boolean; last_login_at: string | null; created_at: string; password_hash?: string | null;
}
const COLS = 'id, name, email, mobile, status, totp_enabled, last_login_at, created_at';
const toDto = (r: Row): SuperAdminDto => ({
  id: r.id, name: r.name, email: r.email, mobile: r.mobile, status: r.status,
  totpEnabled: r.totp_enabled, lastLoginAt: r.last_login_at, createdAt: r.created_at,
});

async function lock(tx: Tx, id: string): Promise<Row> {
  const r = await maybeOne<Row>(tx, `SELECT ${COLS}, password_hash FROM app.super_admins WHERE id = $1 FOR UPDATE`, [id]);
  if (!r) throw notFound('Super Admin');
  return r;
}
function notSelf(ctx: AdminTxCtx, id: string, what: string): void {
  if (ctx.adminId === id) throw conflict('CANNOT_CHANGE_SELF', `You cannot ${what} your own account.`);
}

export async function listSuperAdmins(ctx: AdminTxCtx): Promise<SuperAdminDto[]> {
  return withAdmin(ctx, async (tx) => (await many<Row>(tx, `SELECT ${COLS} FROM app.super_admins ORDER BY name`)).map(toDto));
}

export async function createSuperAdmin(
  ctx: AdminTxCtx, input: { name: string; email: string; mobile?: string }, meta: RequestMeta,
): Promise<SuperAdminDto> {
  try {
    const { dto, outboxId } = await withAdmin(ctx, async (tx) => {
      const row = await one<Row>(
        tx,
        `INSERT INTO app.super_admins (name, email, mobile, status, created_by) VALUES ($1, $2, $3, 'invited', $4)
         RETURNING ${COLS}`,
        [input.name, input.email, input.mobile ?? null, ctx.adminId],
      );
      const raw = await createAdminToken(tx, row.id, 'invite');
      await writeAudit(tx, adminActor(ctx.adminId), {
        action: 'super_admin.invite', entity: 'super_admin', entityId: row.id, after: toDto(row),
      }, meta);
      return { dto: toDto(row), outboxId: await queueAdminInviteEmail(tx, row, raw) };
    });
    sendInBackground([outboxId]);
    return dto;
  } catch (err) {
    if (isUniqueViolation(err, 'super_admins_email_uq')) throw conflict('EMAIL_IN_USE', 'This email address is already a Super Admin.');
    throw err;
  }
}

export async function updateSuperAdmin(
  ctx: AdminTxCtx, id: string, patch: { name?: string; mobile?: string | null }, meta: RequestMeta,
): Promise<SuperAdminDto> {
  return withAdmin(ctx, async (tx) => {
    const before = await lock(tx, id);
    const set = setClause({ name: patch.name, mobile: patch.mobile }, 2);
    if (set.values.length === 0) return toDto(before);
    const after = await one<Row>(tx, `UPDATE app.super_admins SET ${set.sql} WHERE id = $1 RETURNING ${COLS}`, [id, ...set.values]);
    await writeAudit(tx, adminActor(ctx.adminId), {
      action: 'super_admin.update', entity: 'super_admin', entityId: id,
      ...diff({ name: before.name, mobile: before.mobile }, { name: after.name, mobile: after.mobile }),
    }, meta);
    return toDto(after);
  });
}

export async function setSuperAdminStatus(
  ctx: AdminTxCtx, id: string, action: 'disable' | 'enable', meta: RequestMeta,
): Promise<SuperAdminDto> {
  const dto = await withAdmin(ctx, async (tx) => {
    const a = await lock(tx, id);
    if (action === 'disable') {
      notSelf(ctx, id, 'disable');
      if (a.status === 'disabled') return toDto(a);
      const { n } = await one<{ n: number }>(
        tx, `SELECT count(*) AS n FROM app.super_admins WHERE status = 'active' AND id <> $1`, [id]);
      if (n === 0) throw conflict('LAST_SUPER_ADMIN', 'At least one active Super Admin must remain.');
      await exec(tx, `UPDATE app.super_admins SET status = 'disabled', token_version = token_version + 1 WHERE id = $1`, [id]);
      await exec(tx, 'UPDATE app.super_admin_refresh_tokens SET revoked_at = now() WHERE super_admin_id = $1 AND revoked_at IS NULL', [id]);
      await exec(tx, 'UPDATE app.act_as_sessions SET ended_at = now() WHERE super_admin_id = $1 AND ended_at IS NULL', [id]);
    } else {
      if (a.status !== 'disabled') return toDto(a);
      await exec(tx, 'UPDATE app.super_admins SET status = $2 WHERE id = $1', [id, a.password_hash ? 'active' : 'invited']);
    }
    await writeAudit(tx, adminActor(ctx.adminId), { action: `super_admin.${action}`, entity: 'super_admin', entityId: id }, meta);
    return toDto(await lock(tx, id));
  });
  invalidateAdminAuthCache(id);
  invalidateClientAuthCache();
  return dto;
}

export async function resendSuperAdminInvite(ctx: AdminTxCtx, id: string, meta: RequestMeta): Promise<void> {
  const outboxId = await withAdmin(ctx, async (tx) => {
    const a = await lock(tx, id);
    if (a.status !== 'invited') throw conflict('USER_NOT_INVITED', 'This Super Admin has already accepted the invitation.');
    const raw = await createAdminToken(tx, id, 'invite');
    await writeAudit(tx, adminActor(ctx.adminId), { action: 'super_admin.invite_resent', entity: 'super_admin', entityId: id }, meta);
    return queueAdminInviteEmail(tx, a, raw);
  });
  sendInBackground([outboxId]);
}

export async function sendSuperAdminReset(ctx: AdminTxCtx, id: string, meta: RequestMeta): Promise<void> {
  const outboxId = await withAdmin(ctx, async (tx) => {
    const a = await lock(tx, id);
    if (a.status !== 'active') throw conflict('USER_NOT_ACTIVE', 'Only active Super Admins can reset their password.');
    const raw = await createAdminToken(tx, id, 'reset');
    await writeAudit(tx, adminActor(ctx.adminId), { action: 'super_admin.password_reset_sent', entity: 'super_admin', entityId: id }, meta);
    return queueAdminResetEmail(tx, a, raw);
  });
  sendInBackground([outboxId]);
}

/** Lost phone: removes the admin's TOTP so the next login forces a new enrolment. */
export async function resetSuperAdmin2fa(ctx: AdminTxCtx, id: string, meta: RequestMeta): Promise<SuperAdminDto> {
  const dto = await withAdmin(ctx, async (tx) => {
    notSelf(ctx, id, 'reset two-factor authentication for');
    await lock(tx, id);
    await exec(
      tx,
      `UPDATE app.super_admins SET totp_enabled = false, totp_secret_enc = NULL, token_version = token_version + 1 WHERE id = $1`,
      [id],
    );
    await exec(tx, 'UPDATE app.super_admin_refresh_tokens SET revoked_at = now() WHERE super_admin_id = $1 AND revoked_at IS NULL', [id]);
    await writeAudit(tx, adminActor(ctx.adminId), { action: 'super_admin.2fa_reset', entity: 'super_admin', entityId: id }, meta);
    return toDto(await lock(tx, id));
  });
  invalidateAdminAuthCache(id);
  return dto;
}
