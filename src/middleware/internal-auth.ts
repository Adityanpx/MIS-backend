import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { safeEqual } from '../lib/crypto';
import { unauthorized } from '../lib/errors';

export const internalAuth: RequestHandler = (req, _res, next) => {
  const given = req.header('x-cron-secret') ?? '';
  if (!safeEqual(given, env.CRON_SECRET)) return next(unauthorized('CRON_UNAUTHORIZED', 'Invalid cron secret'));
  next();
};
