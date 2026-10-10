import type { RequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import { env } from '../config/env';
import { forbidden } from '../lib/errors';

export function securityMiddleware(): RequestHandler[] {
  return [
    helmet(),
    hpp(),
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // server-to-server, curl, health checks
        cb(null, env.CORS_ORIGINS.includes(origin));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  ];
}

/**
 * Extra CSRF guard for the cookie-authenticated endpoints (refresh, logout).
 * Browsers always send Origin on cross-site POSTs; reject origins that are not ours.
 */
export const requireAllowedOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.header('origin');
  if (origin && !env.CORS_ORIGINS.includes(origin)) return next(forbidden('ORIGIN_NOT_ALLOWED', 'Origin not allowed'));
  next();
};
