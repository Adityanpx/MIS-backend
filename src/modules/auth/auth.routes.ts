import { Router } from 'express';
import { asyncHandler, ok } from '../../lib/http';
import { loginLimiter, passwordFlowLimiter, refreshLimiter } from '../../middleware/rate-limit';
import { requireAllowedOrigin } from '../../middleware/security';
import * as c from './auth.controller';
import { z } from 'zod';
import { requestMeta } from '../../lib/request-meta';
import { parseBody } from '../../lib/validate';
import { exchangeActAs } from '../admin/act-as/act-as.service';

/** Public endpoints (mounted BEFORE authClient). */
export const authRouter = Router();
authRouter.post('/login', loginLimiter, asyncHandler(c.login));
authRouter.post('/2fa/verify', loginLimiter, asyncHandler(c.verify2fa));
authRouter.post('/2fa/enrol/start', loginLimiter, asyncHandler(c.enrolStart));
authRouter.post('/2fa/enrol/confirm', loginLimiter, asyncHandler(c.enrolConfirm));
authRouter.post('/refresh', refreshLimiter, requireAllowedOrigin, asyncHandler(c.refresh));
authRouter.post('/logout', requireAllowedOrigin, asyncHandler(c.logout));
authRouter.post('/forgot', passwordFlowLimiter, asyncHandler(c.forgot));
authRouter.post('/reset', passwordFlowLimiter, asyncHandler(c.reset));
authRouter.post('/invite/accept', passwordFlowLimiter, asyncHandler(c.acceptInvite));
authRouter.post('/act-as/exchange', loginLimiter, asyncHandler(async (req, res) => {
  const { code } = parseBody(req, z.object({ code: z.string().min(20).max(200) }).strict());
  ok(res, await exchangeActAs(code, requestMeta(req)));
}));

/** Protected endpoints (mounted AFTER authClient). */
export const authProtectedRouter = Router();
authProtectedRouter.post('/logout-all', asyncHandler(c.logoutAll));
