import { Router } from 'express';
import { many, maybeOne, one } from '../../../db/sql';
import { withAdmin } from '../../../db/tenant';
import { adminTx } from '../../../lib/context';
import { notFound } from '../../../lib/errors';
import { asyncHandler, created, noContent, ok } from '../../../lib/http';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams } from '../../../lib/validate';
import { announcementBody, announcementPatchBody } from '../../../shared/schemas/billing';
import { idParam } from '../../../shared/schemas/common';
import { adminActor, writeAudit } from '../../audit/audit.service';
import { queueEmail, renderEmail, sendInBackground } from '../../notifications/email.service';

const COLS = `id, message, level, audience, starts_at AS "startsAt", ends_at AS "endsAt", created_at AS "createdAt"`;

export const adminAnnouncementsRouter = Router();
adminAnnouncementsRouter.get('/', asyncHandler(async (req, res) => {
  ok(res, await withAdmin(adminTx(req), (tx) => many(tx, `SELECT ${COLS} FROM app.announcements ORDER BY starts_at DESC LIMIT 200`)));
}));
adminAnnouncementsRouter.post('/', asyncHandler(async (req, res) => {
  const ctx = adminTx(req);
  const b = parseBody(req, announcementBody);
  const r = await withAdmin(ctx, async (tx) => {
    const audience = b.clientIds?.length ? { all: false, clientIds: b.clientIds } : { all: true };
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO app.announcements (message, level, audience, starts_at, ends_at, created_by) VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING ${COLS}`,
      [b.message, b.level, JSON.stringify(audience), b.startsAt, b.endsAt, ctx.adminId],
    );
    await writeAudit(tx, adminActor(ctx.adminId), { action: 'announcement.create', entity: 'announcement', entityId: row.id, after: b }, requestMeta(req));
    const outbox: Array<string | null> = [];
    if (b.sendEmail) {
      const admins = await many<{ tenant_id: string; name: string; email: string }>(
        tx,
        `SELECT u.tenant_id, u.name, u.email FROM app.users u JOIN app.clients c ON c.id = u.tenant_id
          WHERE u.is_client_admin AND u.status = 'active' AND c.status = 'active' AND ($1::uuid[] IS NULL OR u.tenant_id = ANY($1::uuid[]))`,
        [b.clientIds?.length ? b.clientIds : null],
      );
      for (const a of admins) outbox.push(await queueEmail(tx, a.tenant_id, [a.email], await renderEmail('ANNOUNCEMENT', { name: a.name, message: b.message })));
    }
    return { row, outbox };
  });
  sendInBackground(r.outbox);
  created(res, r.row);
}));
adminAnnouncementsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const ctx = adminTx(req);
  const { id } = parseParams(req, idParam);
  const b = parseBody(req, announcementPatchBody);
  ok(res, await withAdmin(ctx, async (tx) => {
    const row = await maybeOne(
      tx,
      `UPDATE app.announcements SET message = coalesce($2, message), level = coalesce($3, level),
              starts_at = coalesce($4::timestamptz, starts_at), ends_at = coalesce($5::timestamptz, ends_at)
        WHERE id = $1 RETURNING ${COLS}`,
      [id, b.message ?? null, b.level ?? null, b.startsAt ?? null, b.endsAt ?? null],
    );
    if (!row) throw notFound('Announcement');
    await writeAudit(tx, adminActor(ctx.adminId), { action: 'announcement.update', entity: 'announcement', entityId: id, after: b }, requestMeta(req));
    return row;
  }));
}));
adminAnnouncementsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const ctx = adminTx(req);
  const { id } = parseParams(req, idParam);
  await withAdmin(ctx, async (tx) => {
    const r = await tx.query('DELETE FROM app.announcements WHERE id = $1', [id]);
    if ((r.rowCount ?? 0) === 0) throw notFound('Announcement');
    await writeAudit(tx, adminActor(ctx.adminId), { action: 'announcement.delete', entity: 'announcement', entityId: id }, requestMeta(req));
  });
  noContent(res);
}));
