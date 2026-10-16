import { z } from 'zod';
import { BILLING_MODES, PLANT_TYPES } from '../enums';
import { MAX_TENURE_MONTHS, MAX_CONTRACT_YEARS } from '../constants';
import { address, contact, email, gstin, isoDate, mobile, moneyString, pan, password, personName, reason, stateCode, uuid } from './common';

export const superAdminCreateBody = z.object({ name: personName, email, mobile: mobile.optional() }).strict();
export const superAdminPatchBody = z.object({ name: personName.optional(), mobile: mobile.nullable().optional() }).strict();
export const adminMePatchBody = z.object({ name: personName.optional(), mobile: mobile.nullable().optional() }).strict();

const clientBase = {
  displayName: z.string().trim().min(2).max(150),
  legalName: z.string().trim().min(2).max(200),
  gstin: gstin.optional(),
  pan: pan.optional(),
  stateCode,
  address,
  primaryContact: contact,
  billingEmails: z.array(email).min(1).max(3),
  notes: z.string().trim().max(2000).optional(),
  force2fa: z.boolean().optional(),
};
export const clientCreateBody = z
  .object({
    ...clientBase,
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/).optional(),
    firstAdmin: z.object({ name: personName, email, mobile: mobile.optional(), password }).strict(),
  })
  .strict()
  .refine((b) => !b.gstin || b.gstin.slice(0, 2) === b.stateCode, {
    message: 'GSTIN state code must match the selected state', path: ['gstin'],
  });
export const clientPatchBody = z
  .object({
    displayName: clientBase.displayName.optional(),
    legalName: clientBase.legalName.optional(),
    gstin: gstin.nullable().optional(),
    pan: pan.nullable().optional(),
    stateCode: stateCode.optional(),
    address: address.optional(),
    primaryContact: contact.optional(),
    billingEmails: clientBase.billingEmails.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    force2fa: z.boolean().optional(),
  })
  .strict();
export const clientListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z.string().regex(/^-?[a-zA-Z]+$/).optional(),
  stateCode: stateCode.optional(),
  accountState: z.enum(['active', 'grace', 'read_only', 'suspended', 'terminated']).optional(),
});

const pct = (max: number) => z.coerce.number().min(0).max(max);
export const planCreateBody = z
  .object({
    name: z.string().trim().min(2).max(100),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,30}$/),
    description: z.string().trim().max(1000).optional(),
    termYears: z.coerce.number().int().min(1).max(MAX_CONTRACT_YEARS),
    pricePerYear: moneyString,
    escalationPct: pct(25).default(0),
    upfrontDiscountPct: pct(50).default(0),
    maxUsersPerPlant: z.coerce.number().int().min(1).max(1000).default(10),
    maxManagementUsers: z.coerce.number().int().min(0).max(100).default(5),
    storageGb: z.coerce.number().int().min(1).max(1000).default(5),
    features: z.record(z.boolean()).default({}),
  })
  .strict();
export const planPatchBody = planCreateBody.partial().omit({ code: true }).strict();
export const planPreviewBody = z
  .object({
    termYears: z.coerce.number().int().min(1).max(MAX_CONTRACT_YEARS),
    pricePerYear: moneyString,
    escalationPct: pct(25).default(0),
    upfrontDiscountPct: pct(50).default(0),
    billingMode: z.enum(BILLING_MODES).default('yearly'),
    startDate: isoDate.optional(),
  })
  .strict();

export const subscriptionInput = z
  .object({
    planId: uuid,
    startDate: isoDate,
    billingMode: z.enum(BILLING_MODES),
    customPricePerYear: moneyString.optional(),
    customReason: reason.optional(),
  })
  .strict()
  .refine((s) => !s.customPricePerYear || !!s.customReason, {
    message: 'A reason is required for a custom price', path: ['customReason'],
  });

export const plantCreateBody = z
  .object({
    clientId: uuid,
    name: z.string().trim().min(2).max(150),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/).optional(),
    type: z.enum(PLANT_TYPES),
    capacityMld: z.coerce.number().positive().max(10000),
    city: z.string().trim().max(100).optional(),
    stateCode,
    omStart: isoDate,
    omTenureMonths: z.coerce.number().int().min(1).max(MAX_TENURE_MONTHS),
    misStart: isoDate.optional(),
    subscription: subscriptionInput,
  })
  .strict();
export const plantPatchBody = z
  .object({
    name: z.string().trim().min(2).max(150).optional(),
    type: z.enum(PLANT_TYPES).optional(),
    capacityMld: z.coerce.number().positive().max(10000).optional(),
    city: z.string().trim().max(100).nullable().optional(),
    stateCode: stateCode.optional(),
  })
  .strict();
export const extendTenureBody = z
  .object({ omTenureMonths: z.coerce.number().int().min(1).max(MAX_TENURE_MONTHS), reason })
  .strict();
export const reasonBody = z.object({ reason }).strict();
