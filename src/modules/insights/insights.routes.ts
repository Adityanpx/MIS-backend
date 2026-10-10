import { Router, type Request } from 'express';
import { maybeOne, one } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { clientCtx, tenantTx } from '../../lib/context';
import { forbidden, notFound } from '../../lib/errors';
import { asyncHandler, noContent, ok } from '../../lib/http';
import { parseBody } from '../../lib/validate';
import { accountState } from '../../middleware/account-state';
import { plantAccess } from '../../middleware/plant-access';
import { DEFAULT_DASHBOARD_WIDGETS, dashboardLayoutBody, type DashboardLayout } from '../../shared/schemas/dashboard';
import { overview } from './overview.service';

/** Mounted at /api/v1/overview (after authClient + requireTermsAccepted). */
export const overviewRouter = Router();
overviewRouter.get('/', asyncHandler(async (req, res) => ok(res, await overview(clientCtx(req)))));

/**
 * Mounted at /api/v1/plants/:plantId/dashboard/layout — the signed-in user's own widget layout for this plant.
 * A personal UI preference: no audit entry, readable in every account state, never writable during act-as.
 */
export const layoutRouter = Router({ mergeParams: true });
const gate = [plantAccess('any'), accountState('read')];
const plantOf = (req: Request) => {
  if (!req.plant) throw notFound('Plant');
  return req.plant;
};

layoutRouter.get('/', ...gate, asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  const plant = plantOf(req);
  const row = await withTenant(tenantTx(ctx), (tx) => maybeOne<{ layout: DashboardLayout; updated_at: string }>(
    tx,
    'SELECT layout, updated_at FROM app.dashboard_layouts WHERE tenant_id = $1 AND user_id = $2 AND plant_id = $3',
    [ctx.tenantId, ctx.userId, plant.id],
  ));
  ok(res, { layout: row?.layout ?? null, updatedAt: row?.updated_at ?? null, defaults: DEFAULT_DASHBOARD_WIDGETS });
}));

layoutRouter.put('/', ...gate, asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  if (ctx.actingAsAdminId) throw forbidden('ACT_AS_NOT_ALLOWED', 'Not allowed during a support session.');
  const plant = plantOf(req);
  const { layout } = parseBody(req, dashboardLayoutBody);
  const row = await withTenant(tenantTx(ctx), (tx) => one<{ layout: DashboardLayout; updated_at: string }>(
    tx,
    `INSERT INTO app.dashboard_layouts (tenant_id, user_id, plant_id, layout) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (tenant_id, user_id, plant_id) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()
     RETURNING layout, updated_at`,
    [ctx.tenantId, ctx.userId, plant.id, JSON.stringify(layout)],
  ));
  ok(res, { layout: row.layout, updatedAt: row.updated_at, defaults: DEFAULT_DASHBOARD_WIDGETS });
}));

layoutRouter.delete('/', ...gate, asyncHandler(async (req, res) => {
  const ctx = clientCtx(req);
  if (ctx.actingAsAdminId) throw forbidden('ACT_AS_NOT_ALLOWED', 'Not allowed during a support session.');
  const plant = plantOf(req);
  await withTenant(tenantTx(ctx), (tx) => maybeOne(
    tx, 'DELETE FROM app.dashboard_layouts WHERE tenant_id = $1 AND user_id = $2 AND plant_id = $3 RETURNING plant_id',
    [ctx.tenantId, ctx.userId, plant.id],
  ));
  noContent(res);
}));
