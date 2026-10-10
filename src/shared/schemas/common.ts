import { z } from 'zod';
import { STATE_CODES } from '../indian-states';

export const uuid = z.string().uuid();
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Invalid date');
export const email = z.string().trim().toLowerCase().email().max(254);
export const mobile = z.string().trim().regex(/^(\+91)?[6-9]\d{9}$/, 'Enter a valid Indian mobile number');
export const password = z.string().min(10).max(128);
export const personName = z.string().trim().min(2).max(120);
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const gstin = z.string().trim().toUpperCase().regex(GSTIN_RE, 'Invalid GSTIN');
export const pan = z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN');
export const stateCode = z.enum(STATE_CODES);
export const moneyString = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Amount with up to 2 decimals');
export const reason = z.string().trim().min(10, 'Please give a reason (at least 10 characters)').max(1000);

export const address = z.object({
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(100),
  pin: z.string().regex(/^\d{6}$/, 'PIN must be 6 digits'),
});
export const contact = z.object({ name: personName, email, mobile: mobile.optional() });
export const idParam = z.object({ id: uuid });
