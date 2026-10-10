import { Router } from 'express';
import { z } from 'zod';
import { exec, many, one } from '../../../db/sql';
import { withAdmin } from '../../../db/tenant';
import { adminTx } from '../../../lib/context';
import { notFound } from '../../../lib/errors';
import { asyncHandler, noContent, ok } from '../../../lib/http';
import { pageMeta, paginationQuery } from '../../../lib/pagination';
import { parseParams, parseQuery } from '../../../lib/validate';
import { idParam } from '../../../shared/schemas/common';

export const adminNotificationsRouter = Router();
adminNotificationsRouter.get('/', asyncHandler(async (req, res) => {
  const q = parseQuery(req, paginationQuery.extend({ unread: z.enum(['true', 'false']).optional() }));
  const unreadOnly = q.unread === 'true';
  const r = await withAdmin(adminTx(req), async (tx) => {
    const { total } = await one<{ total: number }>(tx,
      'SELECT count(*) AS total FROM app.admin_notifications WHERE ($1::boolean = false OR read_at IS NULL)', [unreadOnly]);
    const { unread } = await one<{ unread: number }>(tx, 'SELECT count(*) AS unread FROM app.admin_notifications WHERE read_at IS NULL');
    const items = await many(tx,
      `SELECT n.id, n.code, n.title, n.body, n.link, n.client_id AS "clientId", c.display_name AS "clientName", n.read_at AS "readAt", n.created_at AS "createdAt"
         FROM app.admin_notifications n LEFT JOIN app.clients c ON c.id = n.client_id
        WHERE ($1::boolean = false OR n.read_at IS NULL) ORDER BY n.created_at DESC LIMIT $2 OFFSET $3`,
      [unreadOnly, q.pageSize, (q.page - 1) * q.pageSize]);
    return { items, total, unread };
  });
  ok(res, r.items, { ...pageMeta(q, r.total), unread: r.unread });
}));
adminNotificationsRouter.post('/read-all', asyncHandler(async (req, res) => {
  await withAdmin(adminTx(req), (tx) => exec(tx, 'UPDATE app.admin_notifications SET read_at = now() WHERE read_at IS NULL'));
  noContent(res);
}));
adminNotificationsRouter.post('/:id/read', asyncHandler(async (req, res) => {
  const n = await withAdmin(adminTx(req), (tx) => exec(tx,
    'UPDATE app.admin_notifications SET read_at = coalesce(read_at, now()) WHERE id = $1', [parseParams(req, idParam).id]));
  if (n === 0) throw notFound('Notification');
  noContent(res);
}));
