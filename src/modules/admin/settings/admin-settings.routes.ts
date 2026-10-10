import { Router } from 'express';
import { z } from 'zod';
import { UPLOAD_LIMITS } from '../../../config/constants';
import { maybeOne } from '../../../db/sql';
import { withAdmin } from '../../../db/tenant';
import { adminTx } from '../../../lib/context';
import { asyncHandler, ok } from '../../../lib/http';
import { requestMeta } from '../../../lib/request-meta';
import { parseBody, parseParams } from '../../../lib/validate';
import { SETTINGS_GROUPS } from '../../../shared/enums';
import { adminActor, writeAudit } from '../../audit/audit.service';
import { detectFile, uploadSingle } from '../../files/upload';
import { queueEmail, renderEmail, sendInBackground } from '../../notifications/email.service';
import { STP_TEMPLATE } from '../../settings/stp-template';
import * as svc from './admin-settings.service';

const groupParam = z.object({ group: z.enum(SETTINGS_GROUPS) });
const codeParam = z.object({ code: z.string().regex(/^[A-Z0-9_-]{2,40}$/) });
const SAMPLE = {
  name: 'Sample User', clientName: 'Sample Client Pvt Ltd', invoiceNo: 'INV/2026-27/0001', invoiceDate: '01-Oct-2026', dueDate: '31-Oct-2026',
  amount: '₹70,800.00', description: 'O&M MIS Platform subscription – Plant: Sample STP – Billing Year 1', payLink: 'https://rzp.io/sample',
  billingLink: 'https://app.example.com/billing', plantName: 'Sample STP', receiptNo: 'RCPT/2026-27/0001', days: 7, nextDate: '15-Nov-2026',
  title: 'Sample', body: 'Sample body', link: 'https://example.com', code: 'N-S01', message: 'Sample announcement', sellerName: 'Seller Pvt Ltd',
};

export const adminSettingsRouter = Router();
adminSettingsRouter.get('/', asyncHandler(async (req, res) => ok(res, await svc.getAll(adminTx(req)))));
adminSettingsRouter.get('/email-templates', asyncHandler(async (req, res) => ok(res, await svc.listTemplates(adminTx(req)))));
adminSettingsRouter.get('/email-templates/:code', asyncHandler(async (req, res) => {
  ok(res, await svc.getTemplate(adminTx(req), parseParams(req, codeParam).code));
}));
adminSettingsRouter.put('/email-templates/:code', asyncHandler(async (req, res) => {
  const body = parseBody(req, z.object({
    subject: z.string().trim().min(3).max(300), bodyHtml: z.string().min(3).max(50_000), bodyText: z.string().min(3).max(20_000), isActive: z.boolean(),
  }).strict());
  ok(res, await svc.putTemplate(adminTx(req), parseParams(req, codeParam).code, body, requestMeta(req)));
}));
/** Sends the rendered template (sample values) to the signed-in Super Admin. */
adminSettingsRouter.post('/email-templates/:code/test', asyncHandler(async (req, res) => {
  const ctx = adminTx(req);
  const { code } = parseParams(req, codeParam);
  const outbox = await withAdmin(ctx, async (tx) => {
    const me = await maybeOne<{ email: string }>(tx, 'SELECT email FROM app.super_admins WHERE id = $1', [ctx.adminId]);
    const mail = await renderEmail(code, SAMPLE);
    await writeAudit(tx, adminActor(ctx.adminId), { action: 'email_template.test', entity: 'notification_template', entityId: code }, requestMeta(req));
    return me ? queueEmail(tx, null, [me.email], mail) : null;
  });
  sendInBackground([outbox]);
  ok(res, { sent: !!outbox });
}));
adminSettingsRouter.get('/templates/stp', asyncHandler(async (_req, res) => ok(res, STP_TEMPLATE))); // editing is P2 (SST-12)
adminSettingsRouter.post('/payment-gateway/test', asyncHandler(async (_req, res) => ok(res, await svc.testGateway())));
adminSettingsRouter.post('/:group/logo', uploadSingle('file', UPLOAD_LIMITS.logoBytes), asyncHandler(async (req, res) => {
  const { group } = parseParams(req, z.object({ group: z.enum(['company', 'branding']) }));
  const file = await detectFile(req.file, ['png', 'jpg', 'svg']);
  ok(res, await svc.setLogo(adminTx(req), group, file, requestMeta(req)));
}));
adminSettingsRouter.get('/:group', asyncHandler(async (req, res) => ok(res, await svc.getGroup(adminTx(req), parseParams(req, groupParam).group))));
adminSettingsRouter.put('/:group', asyncHandler(async (req, res) => {
  ok(res, await svc.putGroup(adminTx(req), parseParams(req, groupParam).group, req.body, requestMeta(req)));
}));
