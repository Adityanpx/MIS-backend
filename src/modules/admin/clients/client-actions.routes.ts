import { Router, type Request } from 'express';
import { z } from 'zod';
import { UPLOAD_LIMITS } from '../../../config/constants';
import { adminTx } from '../../../lib/context';
import { asyncHandler, created, noContent, ok } from '../../../lib/http';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams } from '../../../lib/validate';
import { applyCreditBody, documentFields, holdBody, refundBody } from '../../../shared/schemas/billing';
import { reasonBody } from '../../../shared/schemas/admin';
import { idParam, uuid } from '../../../shared/schemas/common';
import * as credit from '../../billing/tds-credit.service';
import { detectFile, uploadSingle } from '../../files/upload';
import * as lc from '../../lifecycle/lifecycle.service';
import * as docs from './documents.service';

const cid = (req: Request) => parseParams(req, idParam).id;
const docParams = z.object({ id: uuid, docId: uuid });

export const adminClientActionsRouter = Router();
adminClientActionsRouter.get('/:id/lifecycle', asyncHandler(async (req, res) => ok(res, await lc.lifecycleHistory(adminTx(req), cid(req)))));
adminClientActionsRouter.post('/:id/suspend', asyncHandler(async (req, res) => {
  await lc.suspend(adminTx(req), { kind: 'client', id: cid(req) }, parseBody(req, reasonBody).reason, requestMeta(req));
  noContent(res);
}));
adminClientActionsRouter.post('/:id/reactivate', asyncHandler(async (req, res) => {
  await lc.reactivate(adminTx(req), { kind: 'client', id: cid(req) }, parseBody(req, reasonBody).reason, requestMeta(req));
  noContent(res);
}));
adminClientActionsRouter.post('/:id/hold', asyncHandler(async (req, res) => {
  const b = parseBody(req, holdBody);
  await lc.hold(adminTx(req), { kind: 'client', id: cid(req) }, b.until, b.reason, requestMeta(req));
  noContent(res);
}));
adminClientActionsRouter.post('/:id/terminate', asyncHandler(async (req, res) => {
  await lc.terminateClient(adminTx(req), cid(req), parseBody(req, reasonBody).reason, requestMeta(req));
  noContent(res);
}));

adminClientActionsRouter.get('/:id/credit', asyncHandler(async (req, res) => ok(res, await credit.getCredit(adminTx(req), cid(req)))));
adminClientActionsRouter.post('/:id/credit/refund', asyncHandler(async (req, res) => {
  ok(res, await credit.refundCredit(adminTx(req), cid(req), parseBody(req, refundBody), requestMeta(req)));
}));
adminClientActionsRouter.post('/:id/credit/apply', asyncHandler(async (req, res) => {
  ok(res, await credit.applyCredit(adminTx(req), cid(req), parseBody(req, applyCreditBody), requestMeta(req)));
}));

adminClientActionsRouter.get('/:id/documents', asyncHandler(async (req, res) => ok(res, await docs.listDocuments(adminTx(req), cid(req)))));
adminClientActionsRouter.post('/:id/documents', uploadSingle('file', UPLOAD_LIMITS.documentBytes), asyncHandler(async (req, res) => {
  const fields = documentFields.parse(req.body ?? {});
  const file = await detectFile(req.file, ['pdf', 'png', 'jpg']);
  created(res, await docs.addDocument(adminTx(req), cid(req), fields, file, requestMeta(req)));
}));
adminClientActionsRouter.get('/:id/documents/:docId/download', asyncHandler(async (req, res) => {
  const p = parseParams(req, docParams);
  ok(res, await docs.documentUrl(adminTx(req), p.id, p.docId));
}));
adminClientActionsRouter.delete('/:id/documents/:docId', asyncHandler(async (req, res) => {
  const p = parseParams(req, docParams);
  await docs.deleteDocument(adminTx(req), p.id, p.docId, requestMeta(req));
  noContent(res);
}));
