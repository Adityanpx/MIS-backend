import { Router } from 'express';
import { asyncHandler } from '../../lib/http';
import { requireClientAdmin } from '../../middleware/require-role';
import * as c from './me.controller';

export const meRouter = Router();
meRouter.get('/', asyncHandler(c.getMe));
meRouter.patch('/', asyncHandler(c.patchMe));
meRouter.post('/password', asyncHandler(c.changePassword));
meRouter.post('/2fa/setup', asyncHandler(c.setup2fa));
meRouter.post('/2fa/enable', asyncHandler(c.enable2fa));
meRouter.post('/2fa/disable', asyncHandler(c.disable2fa));
meRouter.post('/accept-terms', requireClientAdmin, asyncHandler(c.acceptTerms));
