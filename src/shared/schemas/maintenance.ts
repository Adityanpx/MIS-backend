import { z } from 'zod';
import {
  BREAKDOWN_STATUSES, CAUSE_CATEGORIES, CRITICALITIES, IMPACTS, STANDBY_STATES,
} from '../enums';
import { isoDate, uuid } from './common';

const text = (max: number) => z.string().trim().min(1).max(max);
const code = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_-]{1,40}$/, 'Use UPPER_CASE letters, digits, _ and -');

export const equipmentCreateBody = z.object({
  code,
  name: text(150),
  category: text(80),
  area: z.string().trim().max(80).optional(),
  makeModel: z.string().trim().max(150).optional(),
  capacity: z.string().trim().max(80).optional(),
  criticality: z.enum(CRITICALITIES),
  standby: z.enum(STANDBY_STATES).default('none'),
  installedOn: isoDate.optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

export const equipmentPatchBody = equipmentCreateBody
  .omit({ code: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict();

export const equipmentOutOfServiceBody = z.object({
  reason: text(500),
  on: isoDate.optional(), // default: today
}).strict();

export const breakdownCreateBody = z.object({
  equipmentId: uuid,
  startedAt: z.string().datetime(), // sent as ISO; the server stores timestamptz
  fault: text(1000),
  causeCategory: z.enum(CAUSE_CATEGORIES).optional(),
  impact: z.enum(IMPACTS),
  standbyRunning: z.enum(STANDBY_STATES).default('none'),
  actionTaken: z.string().trim().max(1000).optional(),
  sparesRequired: z.string().trim().max(500).optional(),
  expectedRestoreOn: isoDate,
}).strict();

export const breakdownPatchBody = z.object({
  fault: text(1000).optional(),
  causeCategory: z.enum(CAUSE_CATEGORIES).optional(),
  impact: z.enum(IMPACTS).optional(),
  standbyRunning: z.enum(STANDBY_STATES).optional(),
  actionTaken: z.string().trim().max(1000).optional(),
  sparesRequired: z.string().trim().max(500).optional(),
  expectedRestoreOn: isoDate.optional(),
  status: z.enum(['open', 'in_progress', 'awaiting_spares']).optional(),
  note: z.string().trim().max(1000).optional(),
}).strict();

export const breakdownRestoreBody = z.object({
  restoredAt: z.string().datetime(),
  rootCause: text(1000),
  correctiveAction: z.string().trim().max(1000).optional(),
  cost: z.coerce.number().min(0).optional(),
  note: z.string().trim().max(1000).optional(),
}).strict();

export const breakdownCancelBody = z.object({ reason: text(500) }).strict();
export const breakdownReopenBody = z.object({ reason: text(500) }).strict();
export const breakdownNoteBody = z.object({ note: text(1000) }).strict();

export const breakdownListQuery = z.object({
  status: z.enum([...BREAKDOWN_STATUSES, 'open_any'] as const).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  equipmentId: uuid.optional(),
  criticality: z.enum(CRITICALITIES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export type EquipmentCreate = z.infer<typeof equipmentCreateBody>;
export type EquipmentPatch = z.infer<typeof equipmentPatchBody>;
export type BreakdownCreate = z.infer<typeof breakdownCreateBody>;
export type BreakdownPatch = z.infer<typeof breakdownPatchBody>;
export type BreakdownRestore = z.infer<typeof breakdownRestoreBody>;
