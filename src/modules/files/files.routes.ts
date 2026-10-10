import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { notFound } from '../../lib/errors';
import { asyncHandler } from '../../lib/http';
import { parseQuery } from '../../lib/validate';
import { contentTypeForKey, readLocalFile, verifyLocalSignature } from './storage';

export const filesLocalRouter = Router();

const query = z.object({
  key: z.string().min(3).max(500),
  exp: z.coerce.number().int(),
  sig: z.string().min(10).max(200),
  name: z.string().max(200).optional(),
});

filesLocalRouter.get(
  '/local',
  asyncHandler(async (req, res) => {
    if (env.STORAGE_DRIVER !== 'local') throw notFound('File');
    const q = parseQuery(req, query);
    if (!verifyLocalSignature(q.key, q.exp, q.name ?? '', q.sig)) throw notFound('File');
    let data: Buffer;
    try {
      data = await readLocalFile(q.key);
    } catch {
      throw notFound('File');
    }
    res.setHeader('Content-Type', contentTypeForKey(q.key));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // lets the frontends show logos
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (q.name) res.setHeader('Content-Disposition', `attachment; filename="${q.name.replace(/["\\\r\n]/g, '_')}"`);
    res.send(data);
  }),
);
