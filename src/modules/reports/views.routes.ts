import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { clientCtx } from '../../lib/context';
import { addDays, todayIST } from '../../lib/dates';
import { notFound } from '../../lib/errors';
import { asyncHandler, ok } from '../../lib/http';
import { parseQuery } from '../../lib/validate';
import { accountState } from '../../middleware/account-state';
import { plantAccess } from '../../middleware/plant-access';
import { isoDate } from '../../shared/schemas/common';
import { buildAlerts, buildSummary } from '../insights/insights';
import { buildDashboard } from '../engine/core/dashboard';
import { buildMis } from '../engine/core/mis';
import { getBundle, latestDate } from '../engine/engine.service';
import { tablePdf } from '../pdf/pdf.service';
import * as rpt from './reports.service';
import { tableToXlsx, type ReportTable } from './table';

export const viewsRouter = Router({ mergeParams: true });
const gate = [plantAccess('any'), accountState('read')];
const P = (req: Request) => {
  if (!req.plant) throw notFound('Plant');
  return req.plant;
};
const fmt = z.object({ format: z.enum(['json', 'xlsx', 'pdf']).default('json') });

async function send(res: Response, req: Request, t: ReportTable) {
  const { format } = parseQuery(req, fmt.passthrough());
  const name = t.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim();
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

const dateQ = z.object({ date: isoDate.optional() }).passthrough();
viewsRouter.get('/mis', ...gate, asyncHandler(async (req, res) => {
  const b = await getBundle(clientCtx(req).tenantId, P(req).id);
  const d = parseQuery(req, dateQ).date ?? latestDate(b) ?? addDays(todayIST(), -1);
  ok(res, { ...buildMis(b, d), versions: { data: b.dataVersion, settings: b.settingsVersion } });
}));
viewsRouter.get('/dashboard', ...gate, asyncHandler(async (req, res) => {
  const b = await getBundle(clientCtx(req).tenantId, P(req).id);
  const d = parseQuery(req, dateQ).date ?? latestDate(b) ?? addDays(todayIST(), -1);
  const mis = buildMis(b, d); // built once, shared by the dashboard, the alerts and the summary
  ok(res, {
    ...buildDashboard(b, d, mis),
    alerts: buildAlerts(mis),
    summary: buildSummary(mis),
    versions: { data: b.dataVersion, settings: b.settingsVersion },
  });
}));

const rangeQ = z.object({ from: isoDate.optional(), to: isoDate.optional() }).passthrough();
const codes = z.string().regex(/^[A-Z0-9_,]+$/).transform((s) => s.split(',').filter(Boolean));
viewsRouter.get('/reports/monthly', ...gate, asyncHandler(async (req, res) => {
  const q = parseQuery(req, z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), params: codes }).passthrough());
  await send(res, req, rpt.monthly(await getBundle(clientCtx(req).tenantId, P(req).id), q.month, q.params));
}));
viewsRouter.get('/reports/custom', ...gate, asyncHandler(async (req, res) => {
  const q = parseQuery(req, rangeQ.extend({ params: codes.optional() }));
  await send(res, req, rpt.custom(await getBundle(clientCtx(req).tenantId, P(req).id), q.from, q.to, q.params));
}));
viewsRouter.get('/reports/trend', ...gate, asyncHandler(async (req, res) => {
  const q = parseQuery(req, rangeQ.extend({ param: z.string().regex(/^[A-Z0-9_]+$/) }));
  await send(res, req, rpt.trend(await getBundle(clientCtx(req).tenantId, P(req).id), q.param, q.from, q.to));
}));
viewsRouter.get('/reports/stock-ledger', ...gate, asyncHandler(async (req, res) => {
  const q = parseQuery(req, rangeQ.extend({ item: z.string().regex(/^[A-Z0-9_]+$/) }));
  await send(res, req, rpt.stockLedger(await getBundle(clientCtx(req).tenantId, P(req).id), q.item, q.from, q.to));
}));
viewsRouter.get('/reports/cash-book', ...gate, asyncHandler(async (req, res) => {
  const q = parseQuery(req, rangeQ);
  await send(res, req, rpt.cashBook(await getBundle(clientCtx(req).tenantId, P(req).id), q.from, q.to));
}));
viewsRouter.get('/reports/lab-compliance', ...gate, asyncHandler(async (req, res) => {
  const q = parseQuery(req, rangeQ.extend({ side: z.enum(['outlet', 'inlet', 'both']).default('outlet') }));
  await send(res, req, rpt.labCompliance(await getBundle(clientCtx(req).tenantId, P(req).id), q.from, q.to, q.side));
}));
viewsRouter.get('/reports/submissions', ...gate, asyncHandler(async (req, res) => {
  const plant = P(req);
  const q = parseQuery(req, rangeQ);
  await send(res, req, await rpt.submissions(clientCtx(req), plant, q.from ?? plant.misStart, q.to ?? todayIST()));
}));
// v1.1 (RPT-13..15)
viewsRouter.get('/reports/breakdowns', ...gate, asyncHandler(async (req, res) => {
  const q = parseQuery(req, rangeQ);
  await send(res, req, rpt.breakdownRegister(await getBundle(clientCtx(req).tenantId, P(req).id), q.from, q.to));
}));
viewsRouter.get('/reports/equipment-history', ...gate, asyncHandler(async (req, res) => {
  const q = parseQuery(req, rangeQ.extend({ equipment: z.string().trim().min(1).max(40) }));
  await send(res, req, rpt.equipmentHistory(await getBundle(clientCtx(req).tenantId, P(req).id), q.equipment, q.from, q.to));
}));
viewsRouter.get('/reports/downtime-summary', ...gate, asyncHandler(async (req, res) => {
  const q = parseQuery(req, rangeQ);
  await send(res, req, rpt.downtimeSummary(await getBundle(clientCtx(req).tenantId, P(req).id), q.from, q.to));
}));
