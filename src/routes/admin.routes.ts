import { Router } from 'express';
import { adminIpGuard, authAdmin } from '../middleware/auth-admin';
import { userLimiter } from '../middleware/rate-limit';
import { adminActAsRouter, adminClientActAsRouter } from '../modules/admin/act-as/act-as.routes';
import { adminAnnouncementsRouter } from '../modules/admin/announcements/announcements.routes';
import { adminAuditRouter } from '../modules/admin/audit/admin-audit.routes';
import { adminInvoicesRouter } from '../modules/admin/billing/invoices.routes';
import {
  adminBillingDocsRouter, adminPaymentNotificationsRouter, adminPaymentsRouter, adminTdsRouter,
} from '../modules/admin/billing/payments.routes';
import { adminClientActionsRouter } from '../modules/admin/clients/client-actions.routes';
import { adminClientsRouter } from '../modules/admin/clients/clients.routes';
import { adminDashboardRouter } from '../modules/admin/dashboard/dashboard.routes';
import { adminClientDataRouter } from '../modules/admin/deletion/client-data.routes';
import { adminNotificationsRouter } from '../modules/admin/notifications/admin-notifications.routes';
import { adminPlansRouter } from '../modules/admin/plans/plans.routes';
import { adminPlantActionsRouter } from '../modules/admin/plants/plant-actions.routes';
import { adminPlantsRouter } from '../modules/admin/plants/plants.routes';
import { adminReportsRouter } from '../modules/admin/reports/admin-reports.routes';
import { adminSettingsRouter } from '../modules/admin/settings/admin-settings.routes';
import { adminSubscriptionsRouter } from '../modules/admin/subscriptions/subscriptions.routes';
import { superAdminsRouter } from '../modules/admin/super-admins/super-admins.routes';
import { adminClientUsageRouter, adminUsageRouter } from '../modules/admin/usage/usage.routes';
import { adminAuthRouter, adminMeRouter } from '../modules/admin-auth/admin-auth.routes';

export const adminApiRouter = Router();
adminApiRouter.use(adminIpGuard);
adminApiRouter.use('/auth', adminAuthRouter);
adminApiRouter.use(authAdmin);                     // ── Super Admin token required below ──
adminApiRouter.use(userLimiter);
adminApiRouter.use('/me', adminMeRouter);
adminApiRouter.use('/super-admins', superAdminsRouter);
adminApiRouter.use('/dashboard', adminDashboardRouter);
adminApiRouter.use('/clients', adminClientDataRouter); // FIRST: /clients/deletion-queue
adminApiRouter.use('/clients', adminClientsRouter);
adminApiRouter.use('/clients', adminClientActionsRouter);
adminApiRouter.use('/clients', adminClientActAsRouter);
adminApiRouter.use('/clients', adminClientUsageRouter);
adminApiRouter.use('/plans', adminPlansRouter);
adminApiRouter.use('/plants', adminPlantsRouter);
adminApiRouter.use('/plants', adminPlantActionsRouter);
adminApiRouter.use('/subscriptions', adminSubscriptionsRouter);
adminApiRouter.use('/invoices', adminInvoicesRouter);
adminApiRouter.use('/payments', adminPaymentsRouter);
adminApiRouter.use('/payment-notifications', adminPaymentNotificationsRouter);
adminApiRouter.use('/tds', adminTdsRouter);
adminApiRouter.use(adminBillingDocsRouter);       // /credit-notes, /credit-notes/:id/pdf, /receipts/:id/pdf
adminApiRouter.use('/usage', adminUsageRouter);
adminApiRouter.use('/reports', adminReportsRouter);
adminApiRouter.use('/audit', adminAuditRouter);
adminApiRouter.use('/settings', adminSettingsRouter);
adminApiRouter.use('/announcements', adminAnnouncementsRouter);
adminApiRouter.use('/act-as', adminActAsRouter);
adminApiRouter.use('/notifications', adminNotificationsRouter);
