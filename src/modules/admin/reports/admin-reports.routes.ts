import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { adminTx } from '../../../lib/context';
import { asyncHandler, ok } from '../../../lib/http';
import { requestMeta } from '../../../lib/request-meta';
import { parseParams, parseQuery } from '../../../lib/validate';
import { withAdmin } from '../../../db/tenant';
import { ADMIN_REPORT_KEYS } from '../../../shared/enums';
import { isoDate, uuid } from '../../../shared/schemas/common';
import { adminActor, writeAudit } from '../../audit/audit.service';
import { tablePdf } from '../../pdf/pdf.service';
import { tableToXlsx, type ReportTable } from '../../reports/table';
import { adminReport } from './admin-reports.service';

export async function sendTable(req: Request, res: Response, t: ReportTable, format: 'json' | 'xlsx' | 'pdf') {
  const name = t.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'report';
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return res.send(await tableToXlsx(t));
  }
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
    return res.send(await tablePdf(t));
  }
  return ok(res, t);
}

export const adminReportsRouter = Router();
adminReportsRouter.get('/:key', asyncHandler(async (req, res) => {
  const { key } = parseParams(req, z.object({ key: z.enum(ADMIN_REPORT_KEYS) }));
  const q = parseQuery(req, z.object({
    format: z.enum(['json', 'xlsx', 'pdf']).default('json'), from: isoDate.optional(), to: isoDate.optional(),
    clientId: uuid.optional(), windowDays: z.coerce.number().int().min(1).max(3650).optional(),
  }));
  const ctx = adminTx(req);
  const t = await adminReport(ctx, key, q);
  if (q.format !== 'json') {
    await withAdmin(ctx, (tx) => writeAudit(tx, adminActor(ctx.adminId, q.clientId ?? null), {
      action: 'report.export', entity: 'report', entityId: key, after: q,
    }, requestMeta(req)));
  }
  await sendTable(req, res, t, q.format);
}));
