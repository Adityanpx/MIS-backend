import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env';
import { tooMany } from '../lib/errors';

const base = {
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  handler: (_req: unknown, _res: unknown, next: (err: unknown) => void) => next(tooMany()),
  skip: () => isTest,
};
export const generalLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 600 });
export const loginLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 10 });
export const refreshLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 30 });
export const passwordFlowLimiter = rateLimit({ ...base, windowMs: 15 * 60_000, limit: 10 });

/** 300 requests/min per signed-in user or Super Admin (after auth); falls back to the IP. */
export const userLimiter = rateLimit({
  ...base, windowMs: 60_000, limit: 300,
  keyGenerator: (req) => {
    const r = req as Request;
    return r.ctx?.userId ? `u:${r.ctx.userId}` : r.adminCtx?.adminId ? `a:${r.adminCtx.adminId}` : `ip:${r.ip ?? 'unknown'}`;
  },
});
