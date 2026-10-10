import { Router } from 'express';
import { z } from 'zod';
import { many } from '../../../db/sql';
import { withAdmin, type AdminTxCtx } from '../../../db/tenant';
import { adminTx } from '../../../lib/context';
import { addDays, todayIST } from '../../../lib/dates';
import { notFound } from '../../../lib/errors';
import { asyncHandler, ok } from '../../../lib/http';
import { parseParams, parseQuery } from '../../../lib/validate';
import { idParam, uuid } from '../../../shared/schemas/common';

export interface UsageRow {
  clientId: string; clientName: string; plantId: string; plantName: string; snapDate: string; activeUsers: number; maxUsers: number;
  storageBytes: number; storageGb: number; logsheets7d: number; logsheets30d: number; lastLogsheetDate: string | null;
  lastLoginAt: string | null; setupStatus: string; accountState: string;
  flags: { noLogsheet3d: boolean; nearUserLimit: boolean; nearStorageLimit: boolean; inactiveClient: boolean };
}

/** USE-01/02: the latest snapshot per plant with flags. */
export async function usageRows(ctx: AdminTxCtx, clientId?: string): Promise<UsageRow[]> {
  const today = todayIST();
  const rows = await withAdmin(ctx, (tx) => many<Omit<UsageRow, 'flags'>>(
    tx,
    `SELECT DISTINCT ON (u.tenant_id, u.plant_id)
            u.tenant_id AS "clientId", c.display_name AS "clientName", u.plant_id AS "plantId", p.name AS "plantName",
            u.snap_date AS "snapDate", u.active_users AS "activeUsers", u.max_users AS "maxUsers", u.storage_bytes AS "storageBytes",
            u.storage_gb AS "storageGb", u.logsheets_7d AS "logsheets7d", u.logsheets_30d AS "logsheets30d",
            u.last_logsheet_date AS "lastLogsheetDate", u.last_login_at AS "lastLoginAt", u.setup_status AS "setupStatus",
            u.account_state AS "accountState"
       FROM app.usage_snapshots u JOIN app.clients c ON c.id = u.tenant_id JOIN app.plants p ON p.tenant_id = u.tenant_id AND p.id = u.plant_id
      WHERE c.status = 'active' AND ($1::uuid IS NULL OR u.tenant_id = $1)
      ORDER BY u.tenant_id, u.plant_id, u.snap_date DESC`,
    [clientId ?? null],
  ));
  const cutoff = addDays(today, -3);
  const loginCutoff = Date.now() - 14 * 86_400_000;
  return rows.map((r) => ({
    ...r,
    flags: {
      noLogsheet3d: r.setupStatus === 'live' && (!r.lastLogsheetDate || r.lastLogsheetDate < cutoff),
      nearUserLimit: r.activeUsers >= 0.8 * r.maxUsers,
      nearStorageLimit: r.storageBytes >= 0.8 * r.storageGb * 1073741824,
      inactiveClient: !r.lastLoginAt || Date.parse(r.lastLoginAt) < loginCutoff,
    },
  }));
}

export const adminUsageRouter = Router();
adminUsageRouter.get('/', asyncHandler(async (req, res) => {
  const q = parseQuery(req, z.object({
    clientId: uuid.optional(), flag: z.enum(['noLogsheet3d', 'nearUserLimit', 'nearStorageLimit', 'inactiveClient']).optional(),
  }));
  const rows = await usageRows(adminTx(req), q.clientId);
  ok(res, q.flag ? rows.filter((r) => r.flags[q.flag!]) : rows);
}));
/** Mounted at /clients: GET /clients/:id/usage (Usage tab, CL-05). */
export const adminClientUsageRouter = Router();
adminClientUsageRouter.get('/:id/usage', asyncHandler(async (req, res) => {
  const { id } = parseParams(req, idParam);
  const exists = await withAdmin(adminTx(req), (tx) => many(tx, `SELECT 1 FROM app.clients WHERE id = $1 AND status <> 'deleted'`, [id]));
  if (exists.length === 0) throw notFound('Client');
  ok(res, await usageRows(adminTx(req), id));
}));
