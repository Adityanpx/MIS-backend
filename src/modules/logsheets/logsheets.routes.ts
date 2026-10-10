import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { clientCtx } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { asyncHandler, noContent, ok } from '../../lib/http';
import { requestMeta } from '../../lib/request-meta';
import { parseBody, parseParams, parseQuery } from '../../lib/validate';
import { accountState } from '../../middleware/account-state';
import { plantAccess } from '../../middleware/plant-access';
import { requireClientAdmin } from '../../middleware/require-role';
import { uuid } from '../../shared/schemas/common';
import { correctBody, correctionRequestBody, dateParam, decideBody, monthQuery, saveDraftBody, submitBody } from '../../shared/schemas/logsheet';
import * as svc from './logsheets.service';

export const logsheetsRouter = Router({ mergeParams: true });
const P = (req: Request) => {
  if (!req.plant) throw notFound('Plant');
  return req.plant;
};
const h = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncHandler(fn);
const D = (req: Request) => parseParams(req, dateParam).date;
const idP = z.object({ plantId: uuid, id: uuid });
const statusQ = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() });

logsheetsRouter.get('/calendar', plantAccess('any'), accountState('read'), h(async (req, res) =>
  ok(res, await svc.calendar(clientCtx(req), P(req), parseQuery(req, monthQuery).month))));
logsheetsRouter.get('/correction-requests', plantAccess([]), requireClientAdmin, accountState('read'), h(async (req, res) =>
  ok(res, await svc.listCorrectionRequests(clientCtx(req), P(req), parseQuery(req, statusQ).status))));
logsheetsRouter.post('/correction-requests/:id/approve', plantAccess([]), requireClientAdmin, accountState('write'), h(async (req, res) => {
  await svc.decideCorrection(clientCtx(req), P(req), parseParams(req, idP).id, true, parseBody(req, decideBody).comment, requestMeta(req));
  noContent(res);
}));
logsheetsRouter.post('/correction-requests/:id/reject', plantAccess([]), requireClientAdmin, accountState('write'), h(async (req, res) => {
  await svc.decideCorrection(clientCtx(req), P(req), parseParams(req, idP).id, false, parseBody(req, decideBody).comment, requestMeta(req));
  noContent(res);
}));
logsheetsRouter.get('/:date/form', plantAccess('any'), accountState('read'), h(async (req, res) => ok(res, await svc.form(clientCtx(req), P(req), D(req)))));
logsheetsRouter.post('/:date/lock', plantAccess(['editor']), accountState('write'), h(async (req, res) => ok(res, await svc.lock(clientCtx(req), P(req), D(req)))));
logsheetsRouter.delete('/:date/lock', plantAccess(['editor']), h(async (req, res) => {
  await svc.unlock(clientCtx(req), P(req), D(req));
  noContent(res);
}));
logsheetsRouter.put('/:date', plantAccess(['editor']), accountState('write'), h(async (req, res) =>
  ok(res, await svc.saveDraft(clientCtx(req), P(req), D(req), parseBody(req, saveDraftBody), requestMeta(req)))));
logsheetsRouter.post('/:date/submit', plantAccess(['editor']), accountState('write'), h(async (req, res) =>
  ok(res, await svc.submit(clientCtx(req), P(req), D(req), parseBody(req, submitBody), requestMeta(req)))));
logsheetsRouter.post('/:date/correct', plantAccess([]), requireClientAdmin, accountState('write'), h(async (req, res) =>
  ok(res, await svc.correct(clientCtx(req), P(req), D(req), parseBody(req, correctBody), requestMeta(req)))));
logsheetsRouter.get('/:date/history', plantAccess(['editor', 'checker', 'verifier']), accountState('read'), h(async (req, res) =>
  ok(res, await svc.history(clientCtx(req), P(req), D(req)))));
logsheetsRouter.post('/:date/correction-requests', plantAccess(['editor']), accountState('write'), h(async (req, res) =>
  ok(res, await svc.requestCorrection(clientCtx(req), P(req), D(req), parseBody(req, correctionRequestBody), requestMeta(req)))));
