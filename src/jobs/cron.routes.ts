import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { parseParams } from '../lib/validate';
import { internalAuth } from '../middleware/internal-auth';
import { enqueue } from './boss';
import { CRON_JOBS, type QueueName } from './queues';

export const cronRouter = Router();
cronRouter.post(
  '/cron/:job',
  internalAuth,
  asyncHandler(async (req, res) => {
    const { job } = parseParams(req, z.object({ job: z.enum(CRON_JOBS as [QueueName, ...QueueName[]]) }));
    // singletonKey per job per hour: a retried cron call never doubles the work
    await enqueue(job, { triggeredAt: new Date().toISOString() }, { singletonKey: `${job}:${new Date().toISOString().slice(0, 13)}` });
    res.status(202).json({ data: { queued: job } });
  }),
);
