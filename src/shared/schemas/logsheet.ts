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

/** Excel import: date range for both the template download and the upload preview/run. */
export const importRangeQuery = z.object({ from: isoDate, to: isoDate })
  .refine((v) => v.from <= v.to, { message: 'from must be on or before to', path: ['from'] })
  // Cap the range to ~400 days so a single workbook stays small and memory-safe.
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 400,
    { message: 'Range is too large (max 400 days)', path: ['to'] });

/** 'use_excel' = replace existing days with the file's values · 'keep_existing' = skip them. */
export const importConflictPolicy = z.enum(['use_excel', 'keep_existing']);
/**
 * Multipart form fields that accompany the uploaded .xlsx on preview and run. The date range is
 * read from the file itself; from/to are still accepted (older clients send them) but ignored.
 */
export const importBody = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  conflict: importConflictPolicy.optional(), // required on /import, ignored on /import/preview
}).strict();
