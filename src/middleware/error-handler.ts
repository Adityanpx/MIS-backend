import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { captureError } from '../lib/sentry';
import { logger } from '../lib/logger';

type PgLike = { code?: string; constraint?: string; type?: string; name?: string; message?: string };

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.path} not found`, requestId: req.requestId } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const send = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
    res.status(status).json({ error: { code, message, details, requestId: req.requestId } });

  if (err instanceof ZodError) {
    return send(400, 'VALIDATION_FAILED', 'Some fields are invalid.', {
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof AppError) return send(err.status, err.code, err.message, err.details);

  const e = (err ?? {}) as PgLike & { code?: string };
  if (e.name === 'MulterError') {
    return e.code === 'LIMIT_FILE_SIZE'
      ? send(413, 'FILE_TOO_LARGE', 'The file is too large.')
      : send(400, 'FILE_UPLOAD_ERROR', 'The file upload is invalid.');
  }
  if (e.type === 'entity.parse.failed') return send(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  if (e.type === 'entity.too.large') return send(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  if (e.code === '23505') return send(409, 'DUPLICATE', 'This record already exists.', { constraint: e.constraint });
  if (e.code === '23503') return send(422, 'INVALID_REFERENCE', 'A referenced record does not exist.', { constraint: e.constraint });
  if (e.code === '23514') return send(422, 'CONSTRAINT_VIOLATION', 'A value breaks a business rule.', { constraint: e.constraint });
  if (e.code === '42501') {
    // Row-level security or privilege violation = an attempt to touch data outside the tenant. Never reveal details.
    logger.warn({ requestId: req.requestId, msg: e.message }, 'RLS/privilege violation blocked');
    return send(404, 'NOT_FOUND', 'Resource not found');
  }
  logger.error({ err, requestId: req.requestId }, 'Unhandled error');
  captureError(err, { requestId: req.requestId });
  return send(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
};
