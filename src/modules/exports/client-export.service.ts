import { many, one } from '../../db/sql';
import { withAdmin, withTenant, type AdminTxCtx } from '../../db/tenant';
import { enqueue } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { lockedState, notFound } from '../../lib/errors';
import type { RequestMeta } from '../../lib/request-meta';
import type { ClientCtx } from '../../types/express';
import { adminActor, clientActor, writeAudit } from '../audit/audit.service';
import { assertTenantKey, storage } from '../files/storage';

const LIST = `SELECT id, scope, status, expires_at AS "expiresAt", error, created_at AS "createdAt" FROM app.exports`;

/** EXP-01: Client Admin, any time while not suspended (terminated: during the export window). */
export async function requestByClient(ctx: ClientCtx, plantIds: string[] | undefined, meta: RequestMeta) {
  if (ctx.tenantAccountState === 'suspended') throw lockedState('ACCOUNT_SUSPENDED', 'Data export is not available while the account is suspended.');
  const r = await withTenant({ tenantId: ctx.tenantId, actorId: ctx.userId }, async (tx) => {
    if (plantIds?.length) {
      const found = await many(tx, 'SELECT id FROM app.plants WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [ctx.tenantId, plantIds]);
      if (found.length !== new Set(plantIds).size) throw notFound('Plant');
    }
    const row = await one<{ id: string }>(
      tx, `INSERT INTO app.exports (tenant_id, scope, status, created_by) VALUES ($1, $2::jsonb, 'queued', $3) RETURNING id`,
      [ctx.tenantId, JSON.stringify({ type: 'client_full', plantIds: plantIds ?? null }), ctx.userId]);
    await writeAudit(tx, clientActor(ctx), { action: 'export.client_request', entity: 'export', entityId: row.id, after: { plantIds } }, meta);
    return row;
  });
  await enqueue(QUEUES.exportClient, { tenantId: ctx.tenantId, exportId: r.id });
  return { exportId: r.id };
}
export async function listForClient(ctx: ClientCtx) {
  return withTenant({ tenantId: ctx.tenantId, actorId: ctx.userId }, (tx) => many(
    tx, `${LIST} WHERE tenant_id = $1 AND scope->>'type' = 'client_full' ORDER BY created_at DESC LIMIT 50`, [ctx.tenantId]));
}

/** EXP-01: Super Admin, any time. */
export async function requestByAdmin(ctx: AdminTxCtx, clientId: string, plantIds: string[] | undefined, meta: RequestMeta) {
  const r = await withAdmin(ctx, async (tx) => {
    const c = await many(tx, `SELECT 1 FROM app.clients WHERE id = $1 AND status <> 'deleted'`, [clientId]);
    if (c.length === 0) throw notFound('Client');
    if (plantIds?.length) {
      const found = await many(tx, 'SELECT id FROM app.plants WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [clientId, plantIds]);
      if (found.length !== new Set(plantIds).size) throw notFound('Plant');
    }
    const row = await one<{ id: string }>(
      tx, `INSERT INTO app.exports (tenant_id, scope, status, requested_by_admin) VALUES ($1, $2::jsonb, 'queued', $3) RETURNING id`,
      [clientId, JSON.stringify({ type: 'client_full', plantIds: plantIds ?? null }), ctx.adminId]);
    await writeAudit(tx, adminActor(ctx.adminId, clientId), { action: 'export.client_request', entity: 'export', entityId: row.id, after: { plantIds } }, meta);
    return row;
  });
  await enqueue(QUEUES.exportClient, { tenantId: clientId, exportId: r.id });
  return { exportId: r.id };
}
export async function listForAdmin(ctx: AdminTxCtx, clientId: string) {
  return withAdmin(ctx, (tx) => many(tx, `${LIST} WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`, [clientId]));
}
export async function adminDownload(ctx: AdminTxCtx, clientId: string, exportId: string) {
  const e = await withAdmin(ctx, (tx) => many<{ file_key: string | null; status: string; expires_at: string | null }>(
    tx, 'SELECT file_key, status, expires_at FROM app.exports WHERE tenant_id = $1 AND id = $2', [clientId, exportId]));
  const row = e[0];
  if (!row || row.status !== 'ready' || !row.file_key || (row.expires_at && Date.parse(row.expires_at) < Date.now())) throw notFound('Export file');
  assertTenantKey(row.file_key, clientId);
  return { url: await storage.signedUrl(row.file_key, { downloadName: row.file_key.split('/').pop() }) };
}
