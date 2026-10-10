import { Router } from 'express';
import { UPLOAD_LIMITS } from '../../config/constants';
import { asyncHandler, ok } from '../../lib/http';
import { accountState } from '../../middleware/account-state';
import { requireClientAdmin } from '../../middleware/require-role';
import { uploadSingle } from '../files/upload';
import * as c from './company.controller';
import { clientCtx } from '../../lib/context';
import { requestMeta } from '../../lib/request-meta';
import { parseBody } from '../../lib/validate';
import { exportRequestBody } from '../../shared/schemas/billing';
import * as clientExport from '../exports/client-export.service';

export const companyRouter = Router();
companyRouter.use(requireClientAdmin); // the whole /company area is Client Admin only (TRD §6.2)

companyRouter.get('/', accountState('read'), asyncHandler(c.getCompany));
companyRouter.patch('/', accountState('write'), asyncHandler(c.patchCompany));
companyRouter.post('/logo', accountState('write'), uploadSingle('file', UPLOAD_LIMITS.logoBytes), asyncHandler(c.uploadLogo));

companyRouter.get('/users', accountState('read'), asyncHandler(c.listUsers));
companyRouter.post('/users', accountState('write'), asyncHandler(c.inviteUser));
companyRouter.get('/users/:id', accountState('read'), asyncHandler(c.getUser));
companyRouter.patch('/users/:id', accountState('write'), asyncHandler(c.patchUser));
companyRouter.post('/users/:id/disable', accountState('write'), asyncHandler(c.disableUser));
companyRouter.post('/users/:id/enable', accountState('write'), asyncHandler(c.enableUser));
companyRouter.post('/users/:id/resend-invite', accountState('write'), asyncHandler(c.resendInvite));
companyRouter.post('/users/:id/reset-password', accountState('write'), asyncHandler(c.resetPassword));
companyRouter.put('/users/:id/plant-roles', accountState('write'), asyncHandler(c.putPlantRoles));

companyRouter.get('/audit', accountState('read'), asyncHandler(c.listAudit));
companyRouter.post('/exports', accountState('billing'), asyncHandler(async (req, res) => {
  res.status(202).json({ data: await clientExport.requestByClient(clientCtx(req), parseBody(req, exportRequestBody).plantIds, requestMeta(req)) });
}));
companyRouter.get('/exports', accountState('billing'), asyncHandler(async (req, res) => ok(res, await clientExport.listForClient(clientCtx(req)))));
