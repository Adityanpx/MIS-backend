import { Router } from 'express';
import { UPLOAD_LIMITS } from '../../../config/constants';
import { asyncHandler } from '../../../lib/http';
import { uploadSingle } from '../../files/upload';
import * as c from './clients.controller';

export const adminClientsRouter = Router();
adminClientsRouter.get('/', asyncHandler(c.list));
adminClientsRouter.post('/', asyncHandler(c.create));
adminClientsRouter.get('/:id', asyncHandler(c.get));
adminClientsRouter.patch('/:id', asyncHandler(c.update));
adminClientsRouter.post('/:id/logo', uploadSingle('file', UPLOAD_LIMITS.logoBytes), asyncHandler(c.uploadLogo));
adminClientsRouter.get('/:id/users', asyncHandler(c.listUsers));
adminClientsRouter.post('/:id/users', asyncHandler(c.inviteUser));
adminClientsRouter.patch('/:id/users/:userId', asyncHandler(c.updateUser));
adminClientsRouter.post('/:id/users/:userId/disable', asyncHandler(c.disableUser));
adminClientsRouter.post('/:id/users/:userId/enable', asyncHandler(c.enableUser));
adminClientsRouter.post('/:id/users/:userId/resend-invite', asyncHandler(c.resendInvite));
adminClientsRouter.post('/:id/users/:userId/reset-password', asyncHandler(c.resetPassword));
// Phase 3: documents, usage, lifecycle, suspend/reactivate/hold/terminate/delete, export, act-as, credit
