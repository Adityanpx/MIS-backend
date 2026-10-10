import { Router } from 'express';
import { z } from 'zod';
import { adminTx } from '../../../lib/context';
import { asyncHandler, ok } from '../../../lib/http';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams } from '../../../lib/validate';
import { deleteClientBody, exportRequestBody } from '../../../shared/schemas/billing';
import { idParam, uuid } from '../../../shared/schemas/common';
import * as exp from '../../exports/client-export.service';
import { confirmDeletion, deletionQueue } from './deletion.service';

export const adminClientDataRouter = Router();
adminClientDataRouter.get('/deletion-queue', asyncHandler(async (req, res) => ok(res, await deletionQueue(adminTx(req)))));
adminClientDataRouter.post('/:id/export', asyncHandler(async (req, res) => {
  res.status(202).json({ data: await exp.requestByAdmin(adminTx(req), parseParams(req, idParam).id, parseBody(req, exportRequestBody).plantIds, requestMeta(req)) });
}));
adminClientDataRouter.get('/:id/exports', asyncHandler(async (req, res) => ok(res, await exp.listForAdmin(adminTx(req), parseParams(req, idParam).id))));
adminClientDataRouter.get('/:id/exports/:exportId/download', asyncHandler(async (req, res) => {
  const p = parseParams(req, z.object({ id: uuid, exportId: uuid }));
  ok(res, await exp.adminDownload(adminTx(req), p.id, p.exportId));
}));
adminClientDataRouter.post('/:id/delete', asyncHandler(async (req, res) => {
  await confirmDeletion(adminTx(req), parseParams(req, idParam).id, parseBody(req, deleteClientBody), requestMeta(req));
  res.status(202).json({ data: { queued: true } });
}));
