import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 does not catch rejected promises: wrap every async handler. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const ok = (res: Response, data: unknown, meta?: Record<string, unknown>) =>
  res.status(200).json(meta ? { data, meta } : { data });
export const created = (res: Response, data: unknown) => res.status(201).json({ data });
export const noContent = (res: Response) => res.status(204).end();
