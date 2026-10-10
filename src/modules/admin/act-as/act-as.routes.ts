import { Router } from 'express';
import { adminTx } from '../../../lib/context';
import { asyncHandler, created, noContent, ok } from '../../../lib/http';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams } from '../../../lib/validate';
import { actAsBody } from '../../../shared/schemas/billing';
import { idParam } from '../../../shared/schemas/common';
import * as svc from './act-as.service';

/** Mounted at /clients (start + list) */
export const adminClientActAsRouter = Router();
adminClientActAsRouter.post('/:id/act-as', asyncHandler(async (req, res) => {
  created(res, await svc.startActAs(adminTx(req), parseParams(req, idParam).id, parseBody(req, actAsBody), requestMeta(req)));
}));
adminClientActAsRouter.get('/:id/act-as', asyncHandler(async (req, res) => {
  ok(res, await svc.listActAs(adminTx(req), parseParams(req, idParam).id));
}));

/** Mounted at /act-as (end) */
export const adminActAsRouter = Router();
adminActAsRouter.post('/:id/end', asyncHandler(async (req, res) => {
  await svc.endActAs(adminTx(req), parseParams(req, idParam).id, requestMeta(req));
  noContent(res);
}));
