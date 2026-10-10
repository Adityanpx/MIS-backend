import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { adminTx } from '../../../lib/context';
import { asyncHandler, ok } from '../../../lib/http';
import { pageMeta, paginationQuery } from '../../../lib/pagination';
import { parseParams, parseQuery } from '../../../lib/validate';
import { SUBSCRIPTION_STATUSES } from '../../../shared/enums';
import { idParam, uuid } from '../../../shared/schemas/common';
import * as svc from './subscriptions.service';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody } from '../../../lib/validate';
import { cancelSubscriptionBody, changePlanBody, extendSubscriptionBody, renewBody } from '../../../shared/schemas/billing';
import * as ops from './subscriptions.ops';

const listQuery = paginationQuery.extend({
  clientId: uuid.optional(),
  plantId: uuid.optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  endingWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
});

export const adminSubscriptionsRouter = Router();
adminSubscriptionsRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const q = parseQuery(req, listQuery);
  const r = await svc.listSubscriptions(adminTx(req), q);
  ok(res, r.items, pageMeta(q, r.total));
}));
adminSubscriptionsRouter.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  ok(res, await svc.getSubscription(adminTx(req), parseParams(req, idParam).id));
}));
adminSubscriptionsRouter.post('/', asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json({ data: await ops.renewSubscription(adminTx(req), parseBody(req, renewBody), requestMeta(req)) });
}));
adminSubscriptionsRouter.post('/:id/extend', asyncHandler(async (req: Request, res: Response) => {
  ok(res, await ops.extendSubscription(adminTx(req), parseParams(req, idParam).id, parseBody(req, extendSubscriptionBody), requestMeta(req)));
}));
adminSubscriptionsRouter.post('/:id/change-plan', asyncHandler(async (req: Request, res: Response) => {
  ok(res, await ops.changePlan(adminTx(req), parseParams(req, idParam).id, parseBody(req, changePlanBody), requestMeta(req)));
}));
adminSubscriptionsRouter.post('/:id/cancel', asyncHandler(async (req: Request, res: Response) => {
  ok(res, await ops.cancelSubscription(adminTx(req), parseParams(req, idParam).id, parseBody(req, cancelSubscriptionBody), requestMeta(req)));
}));
