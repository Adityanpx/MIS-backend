import { Router } from 'express';
import { asyncHandler } from '../../lib/http';
import { authAdmin } from '../../middleware/auth-admin';
import { loginLimiter, passwordFlowLimiter, refreshLimiter } from '../../middleware/rate-limit';
import { requireAllowedOrigin } from '../../middleware/security';
import * as c from './admin-auth.controller';

/** Mounted at /api/admin/v1/auth BEFORE authAdmin (public), except logout-all which carries authAdmin itself. */
export const adminAuthRouter = Router();
adminAuthRouter.post('/login', loginLimiter, asyncHandler(c.login));
adminAuthRouter.post('/2fa/verify', loginLimiter, asyncHandler(c.verify2fa));
adminAuthRouter.post('/2fa/enrol/start', loginLimiter, asyncHandler(c.enrolStart));
adminAuthRouter.post('/2fa/enrol/confirm', loginLimiter, asyncHandler(c.enrolConfirm));
adminAuthRouter.post('/refresh', refreshLimiter, requireAllowedOrigin, asyncHandler(c.refresh));
adminAuthRouter.post('/logout', requireAllowedOrigin, asyncHandler(c.logout));
adminAuthRouter.post('/logout-all', authAdmin, asyncHandler(c.logoutAll));
adminAuthRouter.post('/forgot', passwordFlowLimiter, asyncHandler(c.forgot));
adminAuthRouter.post('/reset', passwordFlowLimiter, asyncHandler(c.reset));
adminAuthRouter.post('/invite/accept', passwordFlowLimiter, asyncHandler(c.acceptInvite));

/** Mounted at /api/admin/v1/me AFTER authAdmin. */
export const adminMeRouter = Router();
adminMeRouter.get('/', asyncHandler(c.getMe));
adminMeRouter.patch('/', asyncHandler(c.patchMe));
adminMeRouter.post('/password', asyncHandler(c.changePassword));
