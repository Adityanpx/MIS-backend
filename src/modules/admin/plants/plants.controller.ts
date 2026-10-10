import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminTx } from '../../../lib/context';
import { created, ok } from '../../../lib/http';
import { pageMeta, paginationQuery } from '../../../lib/pagination';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams, parseQuery } from '../../../lib/validate';
import { PLANT_ACCOUNT_STATES, SETUP_STATUSES } from '../../../shared/enums';
import { extendTenureBody, plantCreateBody, plantPatchBody } from '../../../shared/schemas/admin';
import { idParam, uuid } from '../../../shared/schemas/common';
import * as svc from './plants.service';
import { enqueue } from '../../../jobs/boss';
import { QUEUES } from '../../../jobs/queues';

const listQuery = paginationQuery.extend({
  clientId: uuid.optional(),
  accountState: z.enum(PLANT_ACCOUNT_STATES).optional(),
  setupStatus: z.enum(SETUP_STATUSES).optional(),
});

export async function list(req: Request, res: Response) {
  const q = parseQuery(req, listQuery);
  const r = await svc.listPlants(adminTx(req), q);
  ok(res, r.items, pageMeta(q, r.total));
}
export const preview = async (req: Request, res: Response) =>
  ok(res, await svc.previewPlant(adminTx(req), parseBody(req, plantCreateBody)));
export async function create(req: Request, res: Response) {
  const dto = await svc.createPlant(adminTx(req), parseBody(req, plantCreateBody), requestMeta(req));
  if (dto.subscription) await enqueue(QUEUES.invoicesGenerate, { subscriptionId: dto.subscription.id });
  created(res, dto);
}
export const get = async (req: Request, res: Response) =>
  ok(res, await svc.getPlant(adminTx(req), parseParams(req, idParam).id));
export const update = async (req: Request, res: Response) =>
  ok(res, await svc.updatePlant(adminTx(req), parseParams(req, idParam).id, parseBody(req, plantPatchBody), requestMeta(req)));
export const extendTenure = async (req: Request, res: Response) =>
  ok(res, await svc.extendTenure(adminTx(req), parseParams(req, idParam).id, parseBody(req, extendTenureBody), requestMeta(req)));
