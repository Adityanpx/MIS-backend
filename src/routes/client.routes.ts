import { Router } from 'express';
import { auditActAs } from '../middleware/act-as-audit';
import { authClient } from '../middleware/auth-client';
import { userLimiter } from '../middleware/rate-limit';
import { requireTermsAccepted } from '../middleware/require-role';
import { authProtectedRouter, authRouter } from '../modules/auth/auth.routes';
import { meRouter } from '../modules/auth/me.routes';
import { clientBillingRouter } from '../modules/client-billing/client-billing.routes';
import { companyRouter } from '../modules/company/company.routes';
import { exportsRouter } from '../modules/exports/exports.routes';
import { filesLocalRouter } from '../modules/files/files.routes';
import { bannersRouter } from '../modules/lifecycle/banners.routes';
import { notificationsRouter } from '../modules/notifications/notifications.routes';
import { announcementsClientRouter } from '../modules/platform/announcements.routes';
import { publicRouter } from '../modules/platform/public.routes';
import { plantsRouter } from '../modules/plants/plants.routes';
import { overviewRouter } from '../modules/insights/insights.routes';

export const clientApiRouter = Router();
clientApiRouter.use('/auth', authRouter);          // public auth endpoints (login, refresh, act-as exchange …)
clientApiRouter.use('/public', publicRouter);
clientApiRouter.use('/files', filesLocalRouter);
clientApiRouter.use(authClient);                   // ── access token required below ──
clientApiRouter.use(userLimiter);                  // SEC-06: 300 requests/min per user
clientApiRouter.use(auditActAs);                   // ACT-04
clientApiRouter.use('/auth', authProtectedRouter);
clientApiRouter.use('/me', meRouter);
clientApiRouter.use(requireTermsAccepted);         // ── accepted Terms required below ──
clientApiRouter.use('/company', companyRouter);
clientApiRouter.use('/plants', plantsRouter);
clientApiRouter.use('/overview', overviewRouter);
clientApiRouter.use('/notifications', notificationsRouter);
clientApiRouter.use('/exports', exportsRouter);
clientApiRouter.use('/billing', clientBillingRouter);
clientApiRouter.use('/banners', bannersRouter);
clientApiRouter.use('/announcements', announcementsClientRouter);
