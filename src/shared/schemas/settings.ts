import { z } from 'zod';
import {
  AGGREGATIONS, DIRECTIONS, EVENT_RULES, INPUT_MODES, MONITORING_TABS, PARAM_GROUPS,
  RESULT_DISPLAY_OVERRIDES, RESULT_MODES, STANDARD_KINDS, STANDARDS_SHOWN, STD_TYPES,
} from '../enums';
import { isoDate, moneyString, reason } from './common';

const num = z.coerce.number().finite();
const code = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,40}$/, 'Use UPPER_CASE letters, digits and _');
const text = (max: number) => z.string().trim().min(1).max(max);
/** Effective-dated changes (CHG-01/02): effectiveFrom defaults to today; a past date needs a reason. */
const effective = { effectiveFrom: isoDate.optional(), reason: z.string().trim().max(1000).optional() };

export const generalPatchBody = z.object({
  displayName: text(150).optional(),
  misStart: isoDate.optional(),
  confirmMisStartChange: z.boolean().optional(),
  endCustomerName: z.string().trim().max(200).nullable().optional(),
  reportCompanyName: z.string().trim().max(200).nullable().optional(),
  logsheetTitle: z.string().trim().max(150).nullable().optional(),
  dashboardTitle: z.string().trim().max(150).nullable().optional(),
  tagline: text(150).optional(),
  sigPreparedLabel: text(80).optional(),
  sigCheckedLabel: text(80).optional(),
  sigVerifiedLabel: text(80).optional(),
  allowSameDay: z.boolean().optional(),
  editorBackfillDays: z.coerce.number().int().min(0).max(365).optional(),
  avgDivisor: z.enum(['calendar_days', 'data_days']).optional(),
  pdfPrefixMis: text(60).optional(),
  // v1.1 (SET-09..12)
  primaryStandard: z.enum(STANDARD_KINDS).optional(),
  standardsShown: z.enum(STANDARDS_SHOWN).optional(),
  resultsDisplay: z.enum(RESULT_MODES).optional(),
  tabLabels: z.record(z.enum(MONITORING_TABS), z.string().trim().max(80)).optional(),
  maintenanceSettings: z.object({
    enabled: z.boolean().optional(),
    reviewTickRequired: z.boolean().optional(),
    longOpenAlertDays: z.coerce.number().int().min(1).max(60).optional(),
    criticalLongOpenDays: z.coerce.number().int().min(1).max(60).optional(),
    repeatThreshold: z.coerce.number().int().min(2).max(20).optional(),
    repeatWindowDays: z.coerce.number().int().min(7).max(365).optional(),
    criticalAlertEnabled: z.boolean().optional(),
  }).strict().optional(),
  v1_1Enabled: z.boolean().optional(),
}).strict();

const parameterFields = {
  name: text(150),
  shortName: z.string().trim().max(60).optional(),
  groupKey: z.enum(PARAM_GROUPS),
  unit: text(30),
  inputMode: z.enum(INPUT_MODES).default('typed'),
  formula: z.string().trim().max(500).optional(),
  decimals: z.coerce.number().int().min(0).max(6).default(2),
  hardMin: num.nullable().optional(),
  hardMax: num.nullable().optional(),
  aggregation: z.enum(AGGREGATIONS),
  stdType: z.enum(STD_TYPES),
  direction: z.enum(DIRECTIONS),
  eventRule: z.enum(EVENT_RULES),
  resultNoun: z.string().trim().max(60).optional(),
  logsheetBlock: z.coerce.number().int().min(1).max(20).optional(),
  logsheetOrder: z.coerce.number().int().min(0).max(1000).optional(),
  misSection: z.enum(['key', 'chemicals', 'lab_inlet', 'lab_outlet']).nullable().optional(),
  misOrder: z.coerce.number().int().min(0).max(1000).optional(),
  monitoringTab: z.enum(MONITORING_TABS).optional(),
  resultDisplay: z.enum(RESULT_DISPLAY_OVERRIDES).nullable().optional(),
  dashboardCard: z.boolean().default(false),
  dashboardOrder: z.coerce.number().int().min(0).max(1000).optional(),
  chartType: z.enum(['bar', 'line', 'cone', 'none']).default('none'),
  chartMetric: z.enum(['avg_per_day', 'monthly_total']).nullable().optional(),
  mandatory: z.boolean().default(true),
};
export const parameterCreateBody = z.object({
  code,
  ...parameterFields,
  standard: z.object({ std: num.optional(), monthly: num.optional(), min: num.optional(), max: num.optional() }).optional(),
}).strict().refine((b) => b.inputMode !== 'calculated' || !!b.formula, { message: 'A formula is required', path: ['formula'] });
/** PATCH: every field optional; defaults are NOT applied (zod's .partial() skips them for missing keys). */
export const parameterPatchBody = z.object(parameterFields).partial().strict();

export const standardCreateBody = z.object({
  kind: z.enum(STANDARD_KINDS).default('actual'),
  std: num.nullable().optional(),
  monthly: num.nullable().optional(),
  min: num.nullable().optional(),
  max: num.nullable().optional(),
  inheritFromKind: z.enum(STANDARD_KINDS).nullable().optional(),
  ...effective,
}).strict();
export const constantCreateBody = z.object({
  code, name: text(150), value: num, unit: z.string().trim().max(30).optional(), ...effective,
}).strict();

export const stockItemCreateBody = z.object({
  name: text(60), unit: text(20), code: code.optional(),
  stdPerDay: num.min(0), openingBalance: num.default(0), openingDate: isoDate.optional(), minLevel: num.min(0).nullable().optional(),
}).strict();
export const stockItemPatchBody = z.object({
  name: text(60).optional(), unit: text(20).optional(), openingBalance: num.optional(), openingDate: isoDate.optional(),
  minLevel: num.min(0).nullable().optional(), displayOrder: z.coerce.number().int().optional(), isActive: z.boolean().optional(),
  reason: z.string().trim().max(1000).optional(),
}).strict();
export const stockAdjustmentBody = z.object({ adjDate: isoDate, qty: num, reason }).strict();

export const staffCreateBody = z.object({ name: text(60), code: code.optional(), strength: z.coerce.number().int().min(0) }).strict();
export const safetyCreateBody = z.object({ name: text(60), code: code.optional(), qty: z.coerce.number().int().min(0) }).strict();
export const itemPatchBody = z.object({
  name: text(60).optional(), displayOrder: z.coerce.number().int().optional(), isActive: z.boolean().optional(),
}).strict();
export const strengthBody = z.object({ strength: z.coerce.number().int().min(0), ...effective }).strict();
export const requirementBody = z.object({ qty: z.coerce.number().int().min(0), ...effective }).strict();

export const contractYearPatchBody = z.object({ fixedFee: moneyString }).strict();
export const componentCreateBody = z.object({
  name: text(100), parameterCode: code, rate: num.min(0), stdQtyPerDay: num.min(0).default(0),
  actualStdQtyPerDay: num.min(0).nullable().optional(), // v1.1: NULL = same as stdQtyPerDay (Bidding)
}).strict();
export const componentPatchBody = z.object({
  name: text(100).optional(), rate: num.min(0).optional(), stdQtyPerDay: num.min(0).optional(),
  actualStdQtyPerDay: num.min(0).nullable().optional(),
}).strict();
export const applyEscalationBody = z.object({
  fromYearNo: z.coerce.number().int().min(2).max(15), pct: num.min(-50).max(100),
  target: z.enum(['fixed_fee', 'component_rates', 'both']).default('fixed_fee'), roundUpToRupee: z.boolean().default(false),
}).strict();

export const cashPatchBody = z.object({
  cashOpening: num.optional(), cashOpeningDate: isoDate.optional(),
  cashAlertLimit: num.min(0).nullable().optional(), pettyFloat: num.min(0).nullable().optional(),
}).strict();

const registerDates = { startDate: isoDate, endDate: isoDate };
export const bgCreateBody = z.object({
  label: text(30), bgNumber: text(60), bank: text(100), ...registerDates, amount: moneyString,
  claimMonths: z.coerce.number().int().min(0).max(60).default(12), remarks: z.string().trim().max(500).optional(),
}).strict().refine((b) => b.endDate >= b.startDate, { message: 'End date must be on or after the start date', path: ['endDate'] });
export const bgPatchBody = z.object({
  label: text(30).optional(), bgNumber: text(60).optional(), bank: text(100).optional(), startDate: isoDate.optional(),
  endDate: isoDate.optional(), amount: moneyString.optional(), claimMonths: z.coerce.number().int().min(0).max(60).optional(),
  remarks: z.string().trim().max(500).nullable().optional(),
}).strict();
export const insuranceCreateBody = z.object({
  policyType: text(30), policyNumber: text(80), insurer: text(100), ...registerDates,
  sumAssured: moneyString.optional(), premium: moneyString.optional(), remarks: z.string().trim().max(500).optional(),
}).strict().refine((b) => b.endDate >= b.startDate, { message: 'End date must be on or after the start date', path: ['endDate'] });
export const insurancePatchBody = z.object({
  policyType: text(30).optional(), policyNumber: text(80).optional(), insurer: text(100).optional(),
  startDate: isoDate.optional(), endDate: isoDate.optional(), sumAssured: moneyString.nullable().optional(),
  premium: moneyString.nullable().optional(), remarks: z.string().trim().max(500).nullable().optional(),
}).strict();

export const copyFromBody = z.object({ sourcePlantId: z.string().uuid() }).strict();
