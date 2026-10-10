import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import pinoHttp from 'pino-http';
import { logger } from '../lib/logger';

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage) => (req as Request).requestId,
  customProps: (req: IncomingMessage) => {
    const r = req as Request;
    return { tenantId: r.ctx?.tenantId, userId: r.ctx?.userId, adminId: r.adminCtx?.adminId };
  },
  serializers: {
    req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
  },
  autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' },
});
