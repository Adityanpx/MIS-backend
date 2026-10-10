import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { requestId } from './middleware/request-id';
import { httpLogger } from './middleware/http-logger';
import { securityMiddleware } from './middleware/security';
import { generalLimiter } from './middleware/rate-limit';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { healthRouter } from './modules/health/health.routes';
import { clientApiRouter } from './routes/client.routes';
import { adminApiRouter } from './routes/admin.routes';
import { webhooksRouter } from './modules/billing/razorpay/webhook.routes';
import './jobs/register';
import { cronRouter } from './jobs/cron.routes';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render/Vercel proxies: req.ip = real client IP
  app.use(requestId);
  app.use(httpLogger);
  app.use(...securityMiddleware());
  app.use('/webhooks', webhooksRouter); // raw body for the HMAC check — MUST stay before express.json()
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(generalLimiter);
  app.use(healthRouter);
  app.use('/internal', cronRouter);
  app.use('/api/v1', clientApiRouter);
  app.use('/api/admin/v1', adminApiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
