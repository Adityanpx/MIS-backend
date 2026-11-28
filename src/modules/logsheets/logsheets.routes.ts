import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { UPLOAD_LIMITS } from '../../config/constants';
import { clientCtx } from '../../lib/context';
import { badRequest, notFound } from '../../lib/errors';
import { asyncHandler, noContent, ok } from '../../lib/http';
import { requestMeta } from '../../lib/request-meta';
import { parseBody, parseParams, parseQuery } from '../../lib/validate';
import { accountState } from '../../middleware/account-state';
import { plantAccess } from '../../middleware/plant-access';
import { requireClientAdmin } from '../../middleware/require-role';
import { uuid } from '../../shared/schemas/common';
import {
  correctBody, correctionRequestBody, dateParam, decideBody, importBody, importRangeQuery,
  calendarQuery, saveDraftBody, submitBody,
} from '../../shared/schemas/logsheet';
import { uploadSingle } from '../files/upload';
import { assertRange, assertRangeOpen, fileRange, previewImport, runImport, templateWorkbook } from './import';
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

logsheetsRouter.get('/calendar', plantAccess('any'), accountState('read'), h(async (req, res) => {
  const q = parseQuery(req, calendarQuery);
  if ('month' in q) return ok(res, await svc.calendar(clientCtx(req), P(req), q.month));
  return ok(res, await svc.calendarRange(clientCtx(req), P(req), q.from, q.to));
}));

// ─── Excel import (LOG-IMPORT) ─────────────────────────────────────────────
// A blank template users download, then the upload preview + run — both editors and Client Admins.
const xlsxUpload = uploadSingle('file', UPLOAD_LIMITS.documentBytes);
const requireXlsx = (req: Request) => {
  const f = req.file;
  if (!f || !f.size) throw badRequest('FILE_REQUIRED', 'Please attach the filled template.');
  const name = (f.originalname ?? '').toLowerCase();
  if (!name.endsWith('.xlsx')) throw badRequest('IMPORT_NOT_XLSX', 'Only .xlsx files are accepted.');
  return f.buffer;
};

logsheetsRouter.get('/import/template', plantAccess(['editor']), accountState('read'), h(async (req, res) => {
  const { from, to } = parseQuery(req, importRangeQuery);
  assertRange(P(req), from, to);
  await assertRangeOpen(clientCtx(req), P(req), from, to);
  const buf = await templateWorkbook(clientCtx(req), P(req), from, to);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="logsheet-template_${P(req).id.slice(0, 8)}_${from}_${to}.xlsx"`);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}));
// Uploads: the date range comes from the file's hidden sheet, not from the request.
logsheetsRouter.post('/import/preview', plantAccess(['editor']), accountState('read'), xlsxUpload, h(async (req, res) => {
  parseBody(req, importBody);
  const buf = requireXlsx(req);
  const { from, to } = await fileRange(buf);
  assertRange(P(req), from, to);
  ok(res, await previewImport(clientCtx(req), P(req), from, to, buf));
}));
logsheetsRouter.post('/import', plantAccess(['editor']), accountState('write'), xlsxUpload, h(async (req, res) => {
  const body = parseBody(req, importBody);
  if (!body.conflict) throw badRequest('IMPORT_CONFLICT_MISSING', 'Pick how to handle days that already exist.');
  const buf = requireXlsx(req);
  const { from, to } = await fileRange(buf);
  assertRange(P(req), from, to);
  ok(res, await runImport(clientCtx(req), P(req), from, to, buf, body.conflict, requestMeta(req)));
}));
// ──────────────────────────────────────────────────────────────────────────
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
