import { env } from '../../../config/env';
import { ACT_AS_CODE_TTL_SEC, ACT_AS_SESSION_MINUTES } from '../../../config/constants';
import { exec, many, maybeOne, one } from '../../../db/sql';
import { withAdmin, withAuthLookup, withTenant, type AdminTxCtx } from '../../../db/tenant';
import { randomToken, sha256 } from '../../../lib/crypto';
import { conflict, notFound, unauthorized } from '../../../lib/errors';
import { signClientAccess } from '../../../lib/jwt';
import type { RequestMeta } from '../../../lib/request-meta';
import { invalidateClientAuthCache } from '../../../middleware/auth-client';
import { adminActor, writeAudit } from '../../audit/audit.service';
import { loadProfile } from '../../auth/session';
import { queueEmail, renderEmail, sendInBackground } from '../../notifications/email.service';

export async function startActAs(ctx: AdminTxCtx, clientId: string, input: { mode: 'view' | 'edit'; reason?: string }, meta: RequestMeta) {
  const code = randomToken(24);
  const r = await withAdmin(ctx, async (tx) => {
    const c = await maybeOne<{ display_name: string }>(tx, `SELECT display_name FROM app.clients WHERE id = $1 AND status = 'active'`, [clientId]);
    if (!c) throw notFound('Client');
    const admin = await maybeOne<{ id: string; name: string; email: string }>(
      tx, `SELECT id, name, email FROM app.users WHERE tenant_id = $1 AND is_client_admin AND status = 'active' ORDER BY created_at LIMIT 1`, [clientId]);
    if (!admin) throw conflict('NO_ACTIVE_CLIENT_ADMIN', 'This client has no active Client Admin to act as.');
    const reason = input.reason?.trim() || 'View as client (read-only)';
    const { id } = await one<{ id: string }>(
      tx,
      `INSERT INTO app.act_as_sessions (tenant_id, super_admin_id, mode, reason, code_hash, code_expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) RETURNING id`,
      [clientId, ctx.adminId, input.mode, reason, sha256(code), ACT_AS_CODE_TTL_SEC],
    );
    await writeAudit(tx, adminActor(ctx.adminId, clientId), {
      action: 'act_as.start', entity: 'act_as_session', entityId: id, after: { mode: input.mode, asUser: admin.id }, reason,
    }, meta);
    const outbox: Array<string | null> = [];
    const setting = await maybeOne<{ value: { emailClientOnEdit?: boolean } }>(tx, `SELECT value FROM app.platform_settings WHERE key = 'act_as'`);
    if (input.mode === 'edit' && (setting?.value.emailClientOnEdit ?? true)) {
      const sa = await one<{ name: string }>(tx, 'SELECT name FROM app.super_admins WHERE id = $1', [ctx.adminId]);
      const mail = await renderEmail('ACT_AS_STARTED', {
        name: admin.name, adminName: sa.name, startedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', reason,
      });
      outbox.push(await queueEmail(tx, clientId, [admin.email], mail));
    }
    return { id, outbox };
  });
  sendInBackground(r.outbox);
  return { sessionId: r.id, code, url: `${env.PUBLIC_WEB_URL}/act-as?code=${encodeURIComponent(code)}`, expiresInSec: ACT_AS_CODE_TTL_SEC };
}

export async function endActAs(ctx: AdminTxCtx, sessionId: string, meta: RequestMeta) {
  await withAdmin(ctx, async (tx) => {
    const s = await maybeOne<{ tenant_id: string }>(tx, 'SELECT tenant_id FROM app.act_as_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    if (!s) throw notFound('Session');
    await exec(tx, 'UPDATE app.act_as_sessions SET ended_at = coalesce(ended_at, now()) WHERE tenant_id = $1 AND id = $2', [s.tenant_id, sessionId]);
    await writeAudit(tx, adminActor(ctx.adminId, s.tenant_id), { action: 'act_as.end', entity: 'act_as_session', entityId: sessionId }, meta);
  });
  invalidateClientAuthCache();
}

export async function listActAs(ctx: AdminTxCtx, clientId: string) {
  return withAdmin(ctx, (tx) => many(
    tx,
    `SELECT s.id, s.mode, s.reason, s.super_admin_id AS "superAdminId", a.name AS "superAdminName", s.code_used_at AS "usedAt",
            s.started_at AS "startedAt", s.ended_at AS "endedAt"
       FROM app.act_as_sessions s JOIN app.super_admins a ON a.id = s.super_admin_id
      WHERE s.tenant_id = $1 ORDER BY s.started_at DESC LIMIT 200`,
    [clientId],
  ));
}

/** Client side (public route): one-time code → 60-minute access token. No refresh token. */
export async function exchangeActAs(code: string, meta: RequestMeta) {
  const row = await withAuthLookup((tx) => maybeOne<{
    session_id: string; tenant_id: string; super_admin_id: string; mode: 'view' | 'edit'; user_id: string | null;
  }>(tx, 'SELECT session_id, tenant_id, super_admin_id, mode, user_id FROM app.auth_use_act_as_code($1)', [sha256(code)]));
  if (!row || !row.user_id) throw unauthorized('TOKEN_INVALID', 'This support link is invalid or has expired.');
  const userId = row.user_id;
  return withTenant({ tenantId: row.tenant_id, actorId: userId }, async (tx) => {
    const u = await one<{ token_version: number }>(tx, 'SELECT token_version FROM app.users WHERE tenant_id = $1 AND id = $2', [row.tenant_id, userId]);
    await writeAudit(tx, { tenantId: row.tenant_id, actorType: 'super_admin', actorId: row.super_admin_id, actingAsAdminId: row.super_admin_id }, {
      action: 'act_as.exchange', entity: 'act_as_session', entityId: row.session_id, after: { mode: row.mode },
    }, meta);
    const accessToken = signClientAccess(
      { sub: userId, tid: row.tenant_id, ver: u.token_version, act: row.super_admin_id, mode: row.mode }, ACT_AS_SESSION_MINUTES * 60);
    const profile = await loadProfile(tx, row.tenant_id, userId, { adminId: row.super_admin_id, mode: row.mode });
    return { mfaRequired: false, accessToken, expiresIn: ACT_AS_SESSION_MINUTES * 60, ...profile };
  });
}
