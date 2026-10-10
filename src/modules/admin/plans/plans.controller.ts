import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminTx } from '../../../lib/context';
import { created, ok } from '../../../lib/http';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams, parseQuery } from '../../../lib/validate';
import { planCreateBody, planPatchBody, planPreviewBody } from '../../../shared/schemas/admin';
import { idParam } from '../../../shared/schemas/common';
import { PLAN_STATUSES } from '../../../shared/enums';
import * as svc from './plans.service';

const listQuery = z.object({ status: z.enum(PLAN_STATUSES).optional() });

export const list = async (req: Request, res: Response) =>
  ok(res, await svc.listPlans(adminTx(req), parseQuery(req, listQuery).status));
export const get = async (req: Request, res: Response) =>
  ok(res, await svc.getPlan(adminTx(req), parseParams(req, idParam).id));
export const create = async (req: Request, res: Response) =>
  created(res, await svc.createPlan(adminTx(req), parseBody(req, planCreateBody), requestMeta(req)));
export const update = async (req: Request, res: Response) =>
  ok(res, await svc.updatePlan(adminTx(req), parseParams(req, idParam).id, parseBody(req, planPatchBody), requestMeta(req)));
export const archive = async (req: Request, res: Response) =>
  ok(res, await svc.setPlanStatus(adminTx(req), parseParams(req, idParam).id, 'archived', requestMeta(req)));
export const restore = async (req: Request, res: Response) =>
  ok(res, await svc.setPlanStatus(adminTx(req), parseParams(req, idParam).id, 'active', requestMeta(req)));
export const preview = async (req: Request, res: Response) => ok(res, await svc.previewPlan(parseBody(req, planPreviewBody)));
