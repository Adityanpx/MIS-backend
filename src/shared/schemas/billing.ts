import { z } from 'zod';
import { MAX_CONTRACT_YEARS } from '../constants';
import { BILLING_MODES, DOCUMENT_TYPES, OFFLINE_PAYMENT_MODES } from '../enums';
import { isoDate, moneyString, reason, uuid } from './common';

const positive = (v: string) => Number(v) > 0;
const money = moneyString.refine(positive, 'Amount must be greater than 0');

export const allocationInput = z.object({ invoiceId: uuid, amount: money }).strict();

/** OFF-01: record an offline payment (proof is uploaded separately: POST /payments/:id/proof). */
export const offlinePaymentBody = z
  .object({
    clientId: uuid,
    mode: z.enum(OFFLINE_PAYMENT_MODES),
    amount: money,
    paymentDate: isoDate,
    reference: z.string().trim().max(100).optional(),
    bank: z.string().trim().max(100).optional(),
    chequeDate: isoDate.optional(),
    remarks: z.string().trim().max(1000).optional(),
    allocations: z.array(allocationInput).max(50).optional(), // empty/omitted = oldest invoices first (OFF-04)
    overrideReason: reason.optional(), // OFF-03 (269ST)
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.mode !== 'cash' && !b.reference) {
      ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Reference (UTR / cheque no. / UPI ref) is required' });
    }
    if (b.mode === 'cheque' && (!b.bank || !b.chequeDate)) {
      ctx.addIssue({ code: 'custom', path: ['bank'], message: 'Bank and cheque date are required for a cheque' });
    }
  });
export const allocationsPutBody = z.object({ allocations: z.array(allocationInput).max(50) }).strict();
export const chequeClearBody = z.object({ clearedOn: isoDate }).strict();
export const chequeBounceBody = z.object({ bouncedOn: isoDate, reason, chargeAmount: money.optional() }).strict();
export const reverseBody = z.object({ reason }).strict();

/** INV-09: one-off invoice with free-text lines. */
export const manualInvoiceBody = z
  .object({
    clientId: uuid,
    plantId: uuid.optional(),
    lines: z
      .array(z.object({
        description: z.string().trim().min(3).max(300),
        sac: z.string().trim().regex(/^\d{4,8}$/).optional(),
        qty: z.coerce.number().positive().max(100000).default(1),
        rate: money,
      }).strict())
      .min(1)
      .max(20),
    dueDate: isoDate.optional(),
    issueNow: z.boolean().default(true),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
export const creditNoteBody = z.object({ amount: money, reason }).strict(); // amount = taxable value (GST added)
export const cancelInvoiceBody = z.object({ reason, releaseSchedule: z.boolean().default(false) }).strict();

export const adminTdsBody = z
  .object({
    amount: money,
    section: z.string().trim().min(2).max(20),
    deductionDate: isoDate,
    certificateStatus: z.enum(['pending', 'received']).default('pending'),
  })
  .strict();
export const tdsPatchBody = z
  .object({
    certificateStatus: z.enum(['pending', 'received']).optional(),
    verified: z.boolean().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
/** Multipart text fields (CA-13). */
export const clientTdsFields = z.object({ amount: money, section: z.string().trim().min(2).max(20), deductionDate: isoDate });
/** Multipart text fields (CA-12). */
export const paymentNotificationFields = z.object({ amount: money, paidOn: isoDate, reference: z.string().trim().min(3).max(100) });
export const verifyNotificationBody = z
  .object({ mode: z.enum(['neft', 'rtgs', 'imps', 'upi', 'other']).default('neft'), allocations: z.array(allocationInput).max(50).optional() })
  .strict();
export const rejectNotificationBody = z.object({ note: z.string().trim().min(3).max(500) }).strict();

export const refundBody = z
  .object({ amount: money, refundDate: isoDate, mode: z.enum(OFFLINE_PAYMENT_MODES), reference: z.string().trim().max(100).optional(), reason })
  .strict();
export const applyCreditBody = z.object({ invoiceId: uuid, amount: money.optional() }).strict();

export const holdBody = z.object({ until: isoDate.nullable(), reason }).strict();
export const deleteClientBody = z.object({ confirmCode: z.string().trim().min(3).max(20), reason }).strict();

export const renewBody = z
  .object({
    plantId: uuid,
    planId: uuid,
    startDate: isoDate.optional(), // default: the day after the current subscription ends (SUB-04)
    billingMode: z.enum(BILLING_MODES),
    customPricePerYear: money.optional(),
    customReason: reason.optional(),
  })
  .strict()
  .refine((b) => !b.customPricePerYear || !!b.customReason, { message: 'A reason is required for a custom price', path: ['customReason'] });
export const extendSubscriptionBody = z
  .object({ addYears: z.coerce.number().int().min(1).max(MAX_CONTRACT_YEARS - 1), pricePerYear: money.optional(), reason })
  .strict();
export const changePlanBody = z.object({ planId: uuid, reason }).strict();
export const cancelSubscriptionBody = z
  .object({ reason, effectiveDate: isoDate.optional(), unpaidInvoices: z.enum(['keep', 'credit_note']).default('keep') })
  .strict();

export const actAsBody = z
  .object({ mode: z.enum(['view', 'edit']), reason: z.string().trim().max(1000).optional() })
  .strict()
  .refine((b) => b.mode === 'view' || (b.reason?.length ?? 0) >= 10, {
    path: ['reason'], message: 'A reason (at least 10 characters) is required for an edit session',
  });

export const announcementBody = z
  .object({
    message: z.string().trim().min(3).max(500),
    level: z.enum(['info', 'warning']).default('info'),
    clientIds: z.array(uuid).max(500).optional(), // omitted = all clients
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    sendEmail: z.boolean().default(false),
  })
  .strict()
  .refine((b) => Date.parse(b.endsAt) > Date.parse(b.startsAt), { path: ['endsAt'], message: 'End must be after start' });
export const announcementPatchBody = z
  .object({
    message: z.string().trim().min(3).max(500).optional(),
    level: z.enum(['info', 'warning']).optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/** Multipart text fields (CL-09). */
export const documentFields = z.object({
  docType: z.enum(DOCUMENT_TYPES),
  title: z.string().trim().min(2).max(200),
  docDate: isoDate.optional(),
  remarks: z.string().trim().max(500).optional(),
});
export const exportRequestBody = z.object({ plantIds: z.array(uuid).max(200).optional() }).strict();
