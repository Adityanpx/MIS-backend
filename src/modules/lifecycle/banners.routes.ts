// banners.routes.ts — GET /api/v1/banners (any signed-in user; only plants the user can access)
import { Router } from 'express';
import { clientCtx } from '../../lib/context';
import { asyncHandler, ok } from '../../lib/http';
import { bannersFor } from './lifecycle.service';

export const bannersRouter = Router();
bannersRouter.get('/', asyncHandler(async (req, res) => ok(res, await bannersFor(clientCtx(req)))));
