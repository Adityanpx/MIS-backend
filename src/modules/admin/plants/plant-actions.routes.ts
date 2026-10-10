import { Router, type Request } from 'express';
import { adminTx } from '../../../lib/context';
import { asyncHandler, noContent } from '../../../lib/http';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams } from '../../../lib/validate';
import { reasonBody } from '../../../shared/schemas/admin';
import { holdBody } from '../../../shared/schemas/billing';
import { idParam } from '../../../shared/schemas/common';
import * as lc from '../../lifecycle/lifecycle.service';

const pid = (req: Request) => parseParams(req, idParam).id;

export const adminPlantActionsRouter = Router();
adminPlantActionsRouter.post('/:id/close', asyncHandler(async (req, res) => {
  await lc.closePlant(adminTx(req), pid(req), parseBody(req, reasonBody).reason, requestMeta(req));
  noContent(res);
}));
adminPlantActionsRouter.post('/:id/suspend', asyncHandler(async (req, res) => {
  await lc.suspend(adminTx(req), { kind: 'plant', id: pid(req) }, parseBody(req, reasonBody).reason, requestMeta(req));
  noContent(res);
}));
adminPlantActionsRouter.post('/:id/reactivate', asyncHandler(async (req, res) => {
  await lc.reactivate(adminTx(req), { kind: 'plant', id: pid(req) }, parseBody(req, reasonBody).reason, requestMeta(req));
  noContent(res);
}));
adminPlantActionsRouter.post('/:id/hold', asyncHandler(async (req, res) => {
  const b = parseBody(req, holdBody);
  await lc.hold(adminTx(req), { kind: 'plant', id: pid(req) }, b.until, b.reason, requestMeta(req));
  noContent(res);
}));
