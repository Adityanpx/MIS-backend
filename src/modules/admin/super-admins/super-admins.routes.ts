import { Router } from 'express';
import { asyncHandler } from '../../../lib/http';
import * as c from './super-admins.controller';

export const superAdminsRouter = Router();
superAdminsRouter.get('/', asyncHandler(c.list));
superAdminsRouter.post('/', asyncHandler(c.create));
superAdminsRouter.patch('/:id', asyncHandler(c.update));
superAdminsRouter.post('/:id/disable', asyncHandler(c.disable));
superAdminsRouter.post('/:id/enable', asyncHandler(c.enable));
superAdminsRouter.post('/:id/resend-invite', asyncHandler(c.resendInvite));
superAdminsRouter.post('/:id/reset-password', asyncHandler(c.resetPassword));
superAdminsRouter.post('/:id/reset-2fa', asyncHandler(c.reset2fa));
