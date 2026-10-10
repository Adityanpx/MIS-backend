import { Router, type Request } from 'express';
import { z } from 'zod';
import { ADMIN_EXPORT_MAX_ROWS } from '../../../config/constants';
import { many, one } from '../../../db/sql';
import { withAdmin } from '../../../db/tenant';
import { adminTx } from '../../../lib/context';
import { asyncHandler, ok } from '../../../lib/http';
import { pageMeta, paginationQuery } from '../../../lib/pagination';
import { requestMeta } from '../../../lib/request-meta';
import { parseQuery } from '../../../lib/validate';
import { isoDate, uuid } from '../../../shared/schemas/common';
import { adminActor, writeAudit } from '../../audit/audit.service';
import { sendTable } from '../reports/admin-reports.routes';

const filters = z.object({
  clientId: uuid.optional(), actorType: z.enum(['super_admin', 'user', 'system']).optional(), actorId: uuid.optional(),
  entity: z.string().trim().max(50).optional(), entityId: z.string().trim().max(100).optional(),
  action: z.string().trim().max(80).optional(), from: isoDate.optional(), to: isoDate.optional(),
});
type Filters = z.infer<typeof filters>;
function where(f: Filters) {
  return {
    sql: `($1::uuid IS NULL OR a.tenant_id = $1) AND ($2::text IS NULL OR a.actor_type = $2) AND ($3::uuid IS NULL OR a.actor_id = $3)
      AND ($4::text IS NULL OR a.entity = $4) AND ($5::text IS NULL OR a.entity_id = $5) AND ($6::text IS NULL OR a.action LIKE $6 || '%')
      AND ($7::date IS NULL OR a.at >= ($7::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
      AND ($8::date IS NULL OR a.at < ($8::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`,
    params: [f.clientId ?? null, f.actorType ?? null, f.actorId ?? null, f.entity ?? null, f.entityId ?? null, f.action ?? null, f.from ?? null, f.to ?? null],
  };
}
const COLS = `a.id, a.at, a.tenant_id AS "clientId", c.display_name AS "clientName", a.actor_type AS "actorType", a.actor_id AS "actorId",
  coalesce(sa.name, u.name) AS "actorName", a.acting_as_admin_id AS "actingAsAdminId", aa.name AS "actingAsAdminName",
  a.action, a.entity, a.entity_id AS "entityId", a.before, a.after, a.reason, a.ip, a.request_id AS "requestId"`;
const FROM = `FROM app.audit_log a LEFT JOIN app.clients c ON c.id = a.tenant_id
  LEFT JOIN app.super_admins sa ON a.actor_type = 'super_admin' AND sa.id = a.actor_id
  LEFT JOIN app.users u ON a.actor_type = 'user' AND u.tenant_id = a.tenant_id AND u.id = a.actor_id
  LEFT JOIN app.super_admins aa ON aa.id = a.acting_as_admin_id`;

export const adminAuditRouter = Router();
adminAuditRouter.get('/', asyncHandler(async (req: Request, res) => {
  const q = parseQuery(req, paginationQuery.merge(filters));
  const w = where(q);
  const r = await withAdmin(adminTx(req), async (tx) => {
    const { total } = await one<{ total: number }>(tx, `SELECT count(*) AS total FROM app.audit_log a WHERE ${w.sql}`, w.params);
    const items = await many(tx, `SELECT ${COLS} ${FROM} WHERE ${w.sql} ORDER BY a.at DESC, a.id DESC LIMIT $9 OFFSET $10`,
      [...w.params, q.pageSize, (q.page - 1) * q.pageSize]);
    return { items, total };
  });
  ok(res, r.items, pageMeta(q, r.total));
}));
adminAuditRouter.get('/export', asyncHandler(async (req: Request, res) => {
  const ctx = adminTx(req);
  const q = parseQuery(req, filters);
  const w = where(q);
  const rows = await withAdmin(ctx, async (tx) => {
    await writeAudit(tx, adminActor(ctx.adminId, q.clientId ?? null), { action: 'audit.export', entity: 'audit_log', after: q }, requestMeta(req));
    return many<Record<string, unknown>>(tx, `SELECT ${COLS} ${FROM} WHERE ${w.sql} ORDER BY a.at DESC LIMIT $9`, [...w.params, ADMIN_EXPORT_MAX_ROWS]);
  });
  await sendTable(req, res, {
    title: 'Audit log',
    columns: [{ key: 'at', header: 'When', width: 22 }, { key: 'clientName', header: 'Client', width: 24 }, { key: 'actorType', header: 'Actor type' },
      { key: 'actorName', header: 'Who', width: 20 }, { key: 'actingAsAdminName', header: 'Acting as (admin)', width: 20 },
      { key: 'action', header: 'Action', width: 26 }, { key: 'entity', header: 'Entity' }, { key: 'entityId', header: 'Entity id', width: 38 },
      { key: 'before', header: 'Before', width: 40 }, { key: 'after', header: 'After', width: 40 }, { key: 'reason', header: 'Reason', width: 30 },
      { key: 'ip', header: 'IP' }],
    rows: rows.map((r) => ({
      ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : (v as string | number)])),
    })) as Array<Record<string, string | number | null>>,
  }, 'xlsx');
}));
