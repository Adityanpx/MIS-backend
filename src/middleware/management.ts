import type { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../lib/errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * GR-17: a Management user may never write, anywhere in the client API — except their own
 * self-service auth actions (change password, 2FA, logout), which are mounted before this guard.
 */
export const refuseManagementWrites: RequestHandler = (req, _res, next) => {
  if (!req.ctx) return next(unauthorized());
  if (req.ctx.isManagement && !SAFE_METHODS.has(req.method)) {
    return next(forbidden('FORBIDDEN_ROLE', 'Management users are read-only.'));
  }
  next();
};
