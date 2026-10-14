import { Router, type Request, type Response } from 'express';
import { clientCtx } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { asyncHandler, ok } from '../../lib/http';
import { plantAccess } from '../../middleware/plant-access';
import { settingsRouter } from '../settings/settings.routes';
import { logsheetsRouter } from '../logsheets/logsheets.routes';
import { pdfRouter } from '../pdf/pdf.routes';
import { importsRouter } from '../imports/imports.routes';
import { plantExportsRouter } from '../exports/exports.routes';
import { viewsRouter } from '../reports/views.routes';
import { layoutRouter } from '../insights/insights.routes';
import { maintenanceRouter } from '../maintenance/maintenance.routes';
import * as svc from './plants.service';

export const plantsRouter = Router();
plantsRouter.get('/', asyncHandler(async (req: Request, res: Response) => ok(res, await svc.listPlants(clientCtx(req)))));
plantsRouter.get('/:plantId', plantAccess('any'), asyncHandler(async (req: Request, res: Response) => {
  if (!req.plant) throw notFound('Plant'); // always set by plantAccess
  ok(res, await svc.getPlant(clientCtx(req), req.plant));
}));
plantsRouter.use('/:plantId/settings', settingsRouter);
plantsRouter.use('/:plantId/logsheets', logsheetsRouter);
plantsRouter.use('/:plantId/pdfs', pdfRouter);
plantsRouter.use('/:plantId/imports', importsRouter);
plantsRouter.use('/:plantId/exports', plantExportsRouter);
plantsRouter.use('/:plantId/dashboard/layout', layoutRouter);
plantsRouter.use('/:plantId', maintenanceRouter); // /equipment, /breakdowns/* (v1.1)
plantsRouter.use('/:plantId', viewsRouter); // /mis, /dashboard, /reports/*
