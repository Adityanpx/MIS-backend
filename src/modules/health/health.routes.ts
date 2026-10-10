import { Router } from 'express';
import { pingDb } from '../../db/tenant';
import { jobsHealthy } from '../../jobs/boss';
import { asyncHandler } from '../../lib/http';

export const healthRouter = Router();
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});
healthRouter.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    let db = 'ok';
    try {
      await pingDb();
    } catch {
      db = 'error';
    }
    const jobs = (await jobsHealthy()) ? 'ok' : 'error';
    res.status(db === 'ok' && jobs === 'ok' ? 200 : 503).json({ status: db === 'ok' && jobs === 'ok' ? 'ready' : 'not_ready', db, jobs });
  }),
);
