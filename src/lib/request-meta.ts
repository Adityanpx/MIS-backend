import type { Request } from 'express';
export const requestMeta = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: (req.headers['user-agent'] ?? '').slice(0, 300),
  requestId: req.requestId,
});
export type RequestMeta = ReturnType<typeof requestMeta>;
