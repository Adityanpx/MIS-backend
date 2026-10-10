import { Router } from 'express';
import { asyncHandler } from '../../../lib/http';
import * as c from './plans.controller';

export const adminPlansRouter = Router();
adminPlansRouter.get('/', asyncHandler(c.list));
adminPlansRouter.post('/', asyncHandler(c.create));
adminPlansRouter.post('/preview', asyncHandler(c.preview));
adminPlansRouter.get('/:id', asyncHandler(c.get));
adminPlansRouter.patch('/:id', asyncHandler(c.update));
adminPlansRouter.post('/:id/archive', asyncHandler(c.archive));
adminPlansRouter.post('/:id/restore', asyncHandler(c.restore));
