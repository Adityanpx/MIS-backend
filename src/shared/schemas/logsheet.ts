import { z } from 'zod';
import { isoDate, reason, uuid } from './common';

export const dateParam = z.object({ plantId: uuid, date: isoDate });
export const monthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM') });
export const valueItem = z.object({
  parameterId: uuid,
  value: z.union([z.number().finite(), z.string().max(1000), z.null()]),
}).strict();
export const saveDraftBody = z.object({ values: z.array(valueItem).max(500), version: z.coerce.number().int().min(0) }).strict();
export const submitBody = z.object({
  values: z.array(valueItem).max(500).optional(),
  version: z.coerce.number().int().min(0),
  remarks: z.string().trim().max(1000).optional(),
  breakdownReviewed: z.boolean().optional(), // required by block 8 when maintenance is enabled
}).strict();
export const correctBody = z.object({ values: z.array(valueItem).min(1).max(500), version: z.coerce.number().int().min(1), reason }).strict();
export const correctionRequestBody = z.object({ values: z.array(valueItem).min(1).max(500), reason }).strict();
export const decideBody = z.object({ comment: z.string().trim().max(1000).optional() }).strict();
