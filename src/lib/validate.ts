import type { Request } from 'express';
import type { z, ZodTypeAny } from 'zod';

export const parseBody = <S extends ZodTypeAny>(req: Request, schema: S): z.infer<S> => schema.parse(req.body ?? {});
export const parseQuery = <S extends ZodTypeAny>(req: Request, schema: S): z.infer<S> => schema.parse(req.query);
export const parseParams = <S extends ZodTypeAny>(req: Request, schema: S): z.infer<S> => schema.parse(req.params);
