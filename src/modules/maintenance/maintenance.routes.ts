import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { clientCtx } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { asyncHandler, created, ok } from '../../lib/http';
import { pageMeta } from '../../lib/pagination';
import { requestMeta } from '../../lib/request-meta';
import { parseBody, parseParams, parseQuery } from '../../lib/validate';
import { accountState } from '../../middleware/account-state';
import { plantAccess } from '../../middleware/plant-access';
import { requireClientAdmin } from '../../middleware/require-role';
import { uuid } from '../../shared/schemas/common';
import * as m from '../../shared/schemas/maintenance';
import * as svc from './maintenance.service';

export const maintenanceRouter = Router({ mergeParams: true });
const idP = z.object({ plantId: uuid, id: uuid });
const P = (req: Request) => {
  if (!req.plant) throw notFound('Plant');
  return req.plant;
};
const h = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncHandler(fn);
const read = [plantAccess('any'), accountState('read')];
const write = [plantAccess(['editor']), accountState('write')];
const admin = [plantAccess([]), requireClientAdmin, accountState('write')];

// Equipment (EQP-*)
maintenanceRouter.get('/equipment', ...read, h(async (req, res) => ok(res, await svc.listEquipment(clientCtx(req), P(req)))));
maintenanceRouter.post('/equipment', ...admin, h(async (req, res) =>
  created(res, await svc.createEquipment(clientCtx(req), P(req), parseBody(req, m.equipmentCreateBody), requestMeta(req)))));
maintenanceRouter.patch('/equipment/:id', ...admin, h(async (req, res) =>
  ok(res, await svc.patchEquipment(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, m.equipmentPatchBody), requestMeta(req)))));
maintenanceRouter.post('/equipment/:id/out-of-service', ...admin, h(async (req, res) =>
  ok(res, await svc.setOutOfService(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, m.equipmentOutOfServiceBody), requestMeta(req)))));

// Breakdowns (BRK-*)
maintenanceRouter.get('/breakdowns', ...read, h(async (req, res) => {
  const q = parseQuery(req, m.breakdownListQuery);
  const r = await svc.listBreakdowns(clientCtx(req), P(req), q);
  ok(res, r.items, pageMeta(q, r.total));
}));
maintenanceRouter.post('/breakdowns', ...write, h(async (req, res) =>
  created(res, await svc.logBreakdown(clientCtx(req), P(req), parseBody(req, m.breakdownCreateBody), requestMeta(req)))));
maintenanceRouter.get('/breakdowns/:id', ...read, h(async (req, res) =>
  ok(res, await svc.getBreakdown(clientCtx(req), P(req), parseParams(req, idP).id))));
maintenanceRouter.patch('/breakdowns/:id', ...write, h(async (req, res) =>
  ok(res, await svc.updateBreakdown(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, m.breakdownPatchBody), requestMeta(req)))));
maintenanceRouter.post('/breakdowns/:id/restore', ...write, h(async (req, res) =>
  ok(res, await svc.restoreBreakdown(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, m.breakdownRestoreBody), requestMeta(req)))));
maintenanceRouter.post('/breakdowns/:id/cancel', ...admin, h(async (req, res) =>
  ok(res, await svc.cancelBreakdown(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, m.breakdownCancelBody), requestMeta(req)))));
maintenanceRouter.post('/breakdowns/:id/reopen', ...admin, h(async (req, res) =>
  ok(res, await svc.reopenBreakdown(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, m.breakdownReopenBody), requestMeta(req)))));
maintenanceRouter.post('/breakdowns/:id/notes', ...write, h(async (req, res) =>
  created(res, await svc.addNote(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, m.breakdownNoteBody), requestMeta(req)))));
maintenanceRouter.get('/breakdowns/:id/updates', ...read, h(async (req, res) =>
  ok(res, await svc.listBreakdownUpdates(clientCtx(req), P(req), parseParams(req, idP).id))));
