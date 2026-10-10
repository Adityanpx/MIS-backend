import type { Tx } from '../../db/tenant';
import type { RequestMeta } from '../../lib/request-meta';
import type { ClientCtx } from '../../types/express';

export type ActorType = 'super_admin' | 'user' | 'system';

export interface AuditActor {
  tenantId: string | null; // NULL = platform-level event
  actorType: ActorType;
  actorId: string | null;
  actingAsAdminId?: string | null;
}
export interface AuditInput {
  action: string; // dotted verb, e.g. 'user.invite', 'plant.create', 'auth.login_failed'
  entity: string; // 'user', 'plant', 'client', ...
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

const SECRET_KEY_RE = /(password|secret|token|totp|hash)/i;

/** Removes secret-looking keys at any depth (never store hashes, secrets or tokens in the audit log). */
export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEY_RE.test(k))
        .map(([k, v]) => [k, sanitize(v)]),
    );
  }
  return value;
}

/** Only the changed keys of two flat objects (keeps audit rows small). */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}

export async function writeAudit(tx: Tx, actor: AuditActor, input: AuditInput, meta?: RequestMeta): Promise<void> {
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(sanitize(v)));
  await tx.query(
    `INSERT INTO app.audit_log
       (tenant_id, actor_type, actor_id, acting_as_admin_id, action, entity, entity_id,
        before, after, reason, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)`,
    [
      actor.tenantId, actor.actorType, actor.actorId, actor.actingAsAdminId ?? null,
      input.action, input.entity, input.entityId ?? null,
      json(input.before), json(input.after), input.reason ?? null,
      meta?.ip ?? null, meta?.userAgent ?? null, meta?.requestId ?? null,
    ],
  );
}

export const clientActor = (ctx: ClientCtx): AuditActor => ({
  tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, actingAsAdminId: ctx.actingAsAdminId ?? null,
});
export const userActor = (tenantId: string, userId: string): AuditActor => ({
  tenantId, actorType: 'user', actorId: userId,
});
export const adminActor = (adminId: string, tenantId: string | null = null): AuditActor => ({
  tenantId, actorType: 'super_admin', actorId: adminId,
});
export const systemActor = (tenantId: string | null = null): AuditActor => ({
  tenantId, actorType: 'system', actorId: null,
});
