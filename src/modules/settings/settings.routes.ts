import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { UPLOAD_LIMITS } from '../../config/constants';
import { clientCtx } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { asyncHandler, created, noContent, ok } from '../../lib/http';
import { requestMeta } from '../../lib/request-meta';
import { parseBody, parseParams } from '../../lib/validate';
import { accountState } from '../../middleware/account-state';
import { plantAccess } from '../../middleware/plant-access';
import { requireClientAdmin } from '../../middleware/require-role';
import { isoDate, uuid } from '../../shared/schemas/common';
import * as s from '../../shared/schemas/settings';
import { detectFile, uploadSingle } from '../files/upload';
import * as svc from './settings.service';

export const settingsRouter = Router({ mergeParams: true });
const read = [plantAccess(['editor', 'checker', 'verifier']), accountState('read')];
const write = [plantAccess([]), requireClientAdmin, accountState('write')];
const P = (req: Request) => {
  if (!req.plant) throw notFound('Plant');
  return req.plant;
};
const idP = z.object({ plantId: uuid, id: uuid });
const yearP = z.object({ plantId: uuid, yearNo: z.coerce.number().int().min(1).max(15) });
const yearCompP = yearP.extend({ id: uuid });
const deactivateBody = z.object({ effectiveFrom: isoDate.optional(), reason: z.string().trim().max(1000).optional() }).strict();
const h = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncHandler(fn);

settingsRouter.get('/general', ...read, h(async (req, res) => ok(res, await svc.getGeneral(clientCtx(req), P(req)))));
settingsRouter.patch('/general', ...write, h(async (req, res) =>
  ok(res, await svc.patchGeneral(clientCtx(req), P(req), parseBody(req, s.generalPatchBody), requestMeta(req)))));

settingsRouter.get('/parameters', ...read, h(async (req, res) => ok(res, await svc.listParameters(clientCtx(req), P(req)))));
settingsRouter.post('/parameters', ...write, h(async (req, res) =>
  created(res, await svc.createParameter(clientCtx(req), P(req), parseBody(req, s.parameterCreateBody), requestMeta(req)))));
settingsRouter.get('/parameters/:id', ...read, h(async (req, res) =>
  ok(res, await svc.getParameter(clientCtx(req), P(req), parseParams(req, idP).id))));
settingsRouter.patch('/parameters/:id', ...write, h(async (req, res) =>
  ok(res, await svc.patchParameter(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, s.parameterPatchBody), requestMeta(req)))));
settingsRouter.post('/parameters/:id/deactivate', ...write, h(async (req, res) =>
  ok(res, await svc.deactivateParameter(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, deactivateBody), requestMeta(req)))));
settingsRouter.get('/parameters/:id/standards', ...read, h(async (req, res) =>
  ok(res, (await svc.getParameter(clientCtx(req), P(req), parseParams(req, idP).id)).standards)));
settingsRouter.post('/parameters/:id/standards', ...write, h(async (req, res) =>
  ok(res, await svc.addStandard(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, s.standardCreateBody), requestMeta(req)))));

settingsRouter.get('/constants', ...read, h(async (req, res) => ok(res, await svc.listConstants(clientCtx(req), P(req)))));
settingsRouter.post('/constants', ...write, h(async (req, res) =>
  ok(res, await svc.addConstant(clientCtx(req), P(req), parseBody(req, s.constantCreateBody), requestMeta(req)))));

settingsRouter.get('/stock-items', ...read, h(async (req, res) => ok(res, await svc.listStockItems(clientCtx(req), P(req)))));
settingsRouter.post('/stock-items', ...write, h(async (req, res) =>
  created(res, await svc.addStockItem(clientCtx(req), P(req), parseBody(req, s.stockItemCreateBody), requestMeta(req)))));
settingsRouter.patch('/stock-items/:id', ...write, h(async (req, res) =>
  ok(res, await svc.patchStockItem(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, s.stockItemPatchBody), requestMeta(req)))));
settingsRouter.post('/stock-items/:id/adjustments', ...write, h(async (req, res) => {
  await svc.addStockAdjustment(clientCtx(req), P(req), parseParams(req, idP).id, parseBody(req, s.stockAdjustmentBody), requestMeta(req));
  noContent(res);
}));

settingsRouter.get('/staff', ...read, h(async (req, res) => ok(res, await svc.listStaff(clientCtx(req), P(req)))));
settingsRouter.post('/staff', ...write, h(async (req, res) =>
  created(res, await svc.addStaffCategory(clientCtx(req), P(req), parseBody(req, s.staffCreateBody), requestMeta(req)))));
settingsRouter.patch('/staff/:id', ...write, h(async (req, res) =>
  ok(res, await svc.patchItem(clientCtx(req), P(req), 'staff', parseParams(req, idP).id, parseBody(req, s.itemPatchBody), requestMeta(req)))));
settingsRouter.post('/staff/:id/strengths', ...write, h(async (req, res) =>
  ok(res, await svc.addStrength(clientCtx(req), P(req), 'staff', parseParams(req, idP).id, parseBody(req, s.strengthBody), requestMeta(req)))));
settingsRouter.get('/safety', ...read, h(async (req, res) => ok(res, await svc.listSafety(clientCtx(req), P(req)))));
settingsRouter.post('/safety', ...write, h(async (req, res) =>
  created(res, await svc.addSafetyItem(clientCtx(req), P(req), parseBody(req, s.safetyCreateBody), requestMeta(req)))));
settingsRouter.patch('/safety/:id', ...write, h(async (req, res) =>
  ok(res, await svc.patchItem(clientCtx(req), P(req), 'safety', parseParams(req, idP).id, parseBody(req, s.itemPatchBody), requestMeta(req)))));
settingsRouter.post('/safety/:id/requirements', ...write, h(async (req, res) =>
  ok(res, await svc.addStrength(clientCtx(req), P(req), 'safety', parseParams(req, idP).id, parseBody(req, s.requirementBody), requestMeta(req)))));

settingsRouter.get('/contract-years', ...read, h(async (req, res) => ok(res, await svc.listContractYears(clientCtx(req), P(req)))));
settingsRouter.post('/contract-years/apply-escalation', ...write, h(async (req, res) =>
  ok(res, await svc.applyEscalation(clientCtx(req), P(req), parseBody(req, s.applyEscalationBody), requestMeta(req)))));
settingsRouter.patch('/contract-years/:yearNo', ...write, h(async (req, res) =>
  ok(res, await svc.setYearFee(clientCtx(req), P(req), parseParams(req, yearP).yearNo, parseBody(req, s.contractYearPatchBody).fixedFee, requestMeta(req)))));
settingsRouter.post('/contract-years/:yearNo/copy-previous', ...write, h(async (req, res) =>
  ok(res, await svc.copyPreviousYear(clientCtx(req), P(req), parseParams(req, yearP).yearNo, requestMeta(req)))));
settingsRouter.post('/contract-years/:yearNo/components', ...write, h(async (req, res) =>
  created(res, await svc.addComponent(clientCtx(req), P(req), parseParams(req, yearP).yearNo, parseBody(req, s.componentCreateBody), requestMeta(req)))));
settingsRouter.patch('/contract-years/:yearNo/components/:id', ...write, h(async (req, res) => {
  const p = parseParams(req, yearCompP);
  ok(res, await svc.patchComponent(clientCtx(req), P(req), p.yearNo, p.id, parseBody(req, s.componentPatchBody), requestMeta(req)));
}));
settingsRouter.delete('/contract-years/:yearNo/components/:id', ...write, h(async (req, res) => {
  const p = parseParams(req, yearCompP);
  ok(res, await svc.patchComponent(clientCtx(req), P(req), p.yearNo, p.id, null, requestMeta(req)));
}));

settingsRouter.get('/cash', ...read, h(async (req, res) => ok(res, await svc.getCash(clientCtx(req), P(req)))));
settingsRouter.patch('/cash', ...write, h(async (req, res) =>
  ok(res, await svc.patchCash(clientCtx(req), P(req), parseBody(req, s.cashPatchBody), requestMeta(req)))));

for (const [path, kind, createBody, patchBody] of [
  ['bank-guarantees', 'bank_guarantees', s.bgCreateBody, s.bgPatchBody],
  ['insurance', 'insurance_policies', s.insuranceCreateBody, s.insurancePatchBody],
] as const) {
  settingsRouter.get(`/${path}`, ...read, h(async (req, res) => ok(res, await svc.listRegister(clientCtx(req), P(req), kind))));
  settingsRouter.post(`/${path}`, ...write, h(async (req, res) =>
    created(res, await svc.createRegister(clientCtx(req), P(req), kind, parseBody(req, createBody), requestMeta(req)))));
  settingsRouter.patch(`/${path}/:id`, ...write, h(async (req, res) =>
    ok(res, await svc.patchRegister(clientCtx(req), P(req), kind, parseParams(req, idP).id, parseBody(req, patchBody), requestMeta(req)))));
  settingsRouter.post(`/${path}/:id/document`, ...write, uploadSingle('file', UPLOAD_LIMITS.documentBytes), h(async (req, res) => {
    const file = await detectFile(req.file, ['pdf', 'png', 'jpg']);
    ok(res, await svc.setRegisterDocument(clientCtx(req), P(req), kind, parseParams(req, idP).id, file, requestMeta(req)));
  }));
}

settingsRouter.get('/go-live-check', ...read, h(async (req, res) => ok(res, await svc.goLiveCheck(clientCtx(req), P(req)))));
settingsRouter.post('/go-live', ...write, h(async (req, res) => ok(res, await svc.goLive(clientCtx(req), P(req), requestMeta(req)))));
settingsRouter.post('/apply-template', ...write, h(async (req, res) => ok(res, await svc.applyTemplateToPlant(clientCtx(req), P(req), requestMeta(req)))));
settingsRouter.post('/copy-from', ...write, h(async (req, res) =>
  ok(res, await svc.copyFrom(clientCtx(req), P(req), parseBody(req, s.copyFromBody).sourcePlantId, requestMeta(req)))));
