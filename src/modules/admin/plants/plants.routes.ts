import { Router } from 'express';
import { asyncHandler } from '../../../lib/http';
import * as c from './plants.controller';

export const adminPlantsRouter = Router();
adminPlantsRouter.get('/', asyncHandler(c.list));
adminPlantsRouter.post('/preview', asyncHandler(c.preview));
adminPlantsRouter.post('/', asyncHandler(c.create));
adminPlantsRouter.get('/:id', asyncHandler(c.get));
adminPlantsRouter.patch('/:id', asyncHandler(c.update));
adminPlantsRouter.post('/:id/extend-tenure', asyncHandler(c.extendTenure));
// Phase 3: POST /:id/close, /:id/suspend, /:id/reactivate, /:id/hold
