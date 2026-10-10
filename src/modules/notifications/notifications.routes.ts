import { Router } from 'express';
import { z } from 'zod';
import { exec, many, one } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { clientCtx, tenantTx } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { asyncHandler, noContent, ok } from '../../lib/http';
import { pageMeta, paginationQuery } from '../../lib/pagination';
import { parseBody, parseParams, parseQuery } from '../../lib/validate';
import { idParam } from '../../shared/schemas/common';

/** Codes a user may switch off (§18.2). Billing and lifecycle codes (Phase 3) are never listed here. */
export const OPTIONAL_CODES = ['N-O01', 'N-O02', 'N-O03', 'N-O04', 'N-O05', 'N-O06', 'N-O08', 'N-O09'] as const;

export const notificationsRouter = Router();
notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const q = parseQuery(req, paginationQuery.extend({ unread: z.enum(['true', 'false']).optional() }));
  const r = await withTenant(tenantTx(ctx), async (tx) => {
    const where = `tenant_id = $1 AND user_id = $2 AND ($3::boolean IS NULL OR (read_at IS NULL) = $3)`;
    const params = [ctx.tenantId, ctx.userId, q.unread === undefined ? null : q.unread === 'true'];
    const { total } = await one<{ total: number }>(tx, `SELECT count(*) AS total FROM app.notifications WHERE ${where}`, params);
    const { unread } = await one<{ unread: number }>(tx,
      'SELECT count(*) AS unread FROM app.notifications WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL', [ctx.tenantId, ctx.userId]);
    const items = await many(tx, `SELECT id, template_code AS code, title, body, link, read_at, created_at FROM app.notifications
      WHERE ${where} ORDER BY created_at DESC LIMIT $4 OFFSET $5`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    return { items, total, unread };
  });
  ok(res, r.items, { ...pageMeta(q, r.total), unread: r.unread });
}));
notificationsRouter.post('/read-all', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  await withTenant(tenantTx(ctx), (tx) => exec(tx,
    'UPDATE app.notifications SET read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL', [ctx.tenantId, ctx.userId]));
  noContent(res);
}));
notificationsRouter.get('/preferences', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const r = await withTenant(tenantTx(ctx), (tx) => one<{ notification_prefs: Record<string, boolean> }>(tx,
    'SELECT notification_prefs FROM app.users WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId]));
  ok(res, { codes: OPTIONAL_CODES, prefs: r.notification_prefs ?? {} });
}));
notificationsRouter.put('/preferences', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const keys = OPTIONAL_CODES.flatMap((c) => [c, `${c}:email`]);
  const body = parseBody(req, z.object({ prefs: z.record(z.boolean()) }).strict());
  const prefs = Object.fromEntries(Object.entries(body.prefs).filter(([k]) => keys.includes(k)));
  await withTenant(tenantTx(ctx), (tx) => exec(tx,
    'UPDATE app.users SET notification_prefs = $3::jsonb WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, ctx.userId, JSON.stringify(prefs)]));
  ok(res, { prefs });
}));
notificationsRouter.post('/:id/read', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const { id } = parseParams(req, idParam);
  const n = await withTenant(tenantTx(ctx), (tx) => exec(tx,
    'UPDATE app.notifications SET read_at = coalesce(read_at, now()) WHERE tenant_id = $1 AND user_id = $2 AND id = $3',
    [ctx.tenantId, ctx.userId, id]));
  if (n === 0) throw notFound('Notification'); // someone else's notification behaves like a missing one
  noContent(res);
}));
