import { Router } from 'express';
import { z } from 'zod';
import { adminTx } from '../../../lib/context';
import { asyncHandler, ok } from '../../../lib/http';
import { parseQuery } from '../../../lib/validate';
import { actionList, dashboard } from './dashboard.service';

export const adminDashboardRouter = Router();
adminDashboardRouter.get('/', asyncHandler(async (req, res) => {
  const q = parseQuery(req, z.object({ fy: z.string().regex(/^\d{4}-\d{2}$/).optional() }));
  ok(res, await dashboard(adminTx(req), q.fy));
}));
adminDashboardRouter.get('/action-list', asyncHandler(async (req, res) => ok(res, await actionList(adminTx(req)))));
