// announcements.routes.ts — GET /api/v1/announcements (all-client + this tenant's announcements)
import { Router } from 'express';
import { many } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { clientCtx, tenantTx } from '../../lib/context';
import { asyncHandler, ok } from '../../lib/http';

export const announcementsClientRouter = Router();
announcementsClientRouter.get('/', asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  ok(res, await withTenant(tenantTx(ctx), (tx) => many(tx,
    `SELECT id, message, level, starts_at AS "startsAt", ends_at AS "endsAt" FROM app.active_announcements()`)));
}));
