import { many } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { DEFAULT_GST_RATE_PCT } from '../../shared/constants';

export interface SellerSettings {
  legalName: string; tradeName: string; stateCode: string; gstin: string; pan: string; cin: string;
  email: string; phone: string; logoKey: string | null;
  address: { line1?: string; line2?: string; city?: string; pin?: string };
  bank: { accountName: string; accountNo: string; ifsc: string; branch: string };
  upiId: string; signatory: { name: string; designation: string }; footerTerms: string;
}
export interface TaxSettings { gstRatePct: number; sac: string; tdsSections: string[]; closeTolerance: string }
export interface NumberingSettings { invoicePrefix: string; creditNotePrefix: string; receiptPrefix: string }
export interface BillingSettings {
  invoiceLeadDays: number; minPaymentTermsDays: number; autoIssue: boolean; autoApplyCredit: boolean;
  gatewayFeeMode: 'absorb' | 'convenience'; gatewayFeePct: number; linkExpiryDaysAfterDue: number;
}
export interface LifecycleSettings {
  graceDays: number; readOnlyDays: number; suspendedDays: number; retentionDays: number;
  chequePauseMaxDays: number; renewalWindowDays: number; expiringAlertDays: number;
}
export interface ReminderSettings { preDueDays: number[]; overdueDays: number[]; renewalDays: number[] }
export interface BillingConfig {
  seller: SellerSettings; tax: TaxSettings; numbering: NumberingSettings; billing: BillingSettings;
  lifecycle: LifecycleSettings; reminders: ReminderSettings; platformName: string;
}

export const DEFAULT_SELLER: SellerSettings = {
  legalName: '', tradeName: '', stateCode: '', gstin: '', pan: '', cin: '', email: '', phone: '', logoKey: null, address: {},
  bank: { accountName: '', accountNo: '', ifsc: '', branch: '' }, upiId: '', signatory: { name: '', designation: '' }, footerTerms: '',
};
export const DEFAULT_TAX: TaxSettings = { gstRatePct: DEFAULT_GST_RATE_PCT, sac: '998314', tdsSections: ['194J', '194C'], closeTolerance: '10.00' };
export const DEFAULT_NUMBERING: NumberingSettings = { invoicePrefix: 'INV', creditNotePrefix: 'CN', receiptPrefix: 'RCPT' };
export const DEFAULT_BILLING: BillingSettings = {
  invoiceLeadDays: 30, minPaymentTermsDays: 7, autoIssue: true, autoApplyCredit: true,
  gatewayFeeMode: 'absorb', gatewayFeePct: 0, linkExpiryDaysAfterDue: 30,
};
export const DEFAULT_LIFECYCLE: LifecycleSettings = {
  graceDays: 15, readOnlyDays: 15, suspendedDays: 60, retentionDays: 90, chequePauseMaxDays: 15, renewalWindowDays: 30, expiringAlertDays: 30,
};
export const DEFAULT_REMINDERS: ReminderSettings = {
  preDueDays: [30, 15, 7, 1], overdueDays: [1, 7, 14, 16, 23, 31, 60, 83], renewalDays: [90, 60, 30],
};

/** All billing-related settings in one query, merged over the defaults. */
export async function loadBillingConfig(tx: Tx): Promise<BillingConfig> {
  const rows = await many<{ key: string; value: Record<string, unknown> }>(
    tx,
    `SELECT key, value FROM app.platform_settings
      WHERE key IN ('seller.company', 'tax', 'numbering', 'billing', 'lifecycle', 'reminders', 'platform.branding')`,
  );
  const v = (k: string) => (rows.find((r) => r.key === k)?.value ?? {}) as Record<string, unknown>;
  const seller = { ...DEFAULT_SELLER, ...v('seller.company') } as SellerSettings;
  return {
    seller: { ...seller, bank: { ...DEFAULT_SELLER.bank, ...seller.bank }, signatory: { ...DEFAULT_SELLER.signatory, ...seller.signatory } },
    tax: { ...DEFAULT_TAX, ...v('tax') } as TaxSettings,
    numbering: { ...DEFAULT_NUMBERING, ...v('numbering') } as NumberingSettings,
    billing: { ...DEFAULT_BILLING, ...v('billing') } as BillingSettings,
    lifecycle: { ...DEFAULT_LIFECYCLE, ...v('lifecycle') } as LifecycleSettings,
    reminders: { ...DEFAULT_REMINDERS, ...v('reminders') } as ReminderSettings,
    platformName: String(v('platform.branding').name ?? 'OMMIS'),
  };
}

/** A tax invoice needs the seller's legal name, state and GSTIN (PRD §8.1). */
export function sellerReady(s: SellerSettings): boolean {
  return !!(s.legalName && s.stateCode && s.gstin);
}

/** Serialises all billing writes of ONE tenant (credit, allocations, numbering order). Released at commit/rollback. */
export async function lockTenantBilling(tx: Tx, tenantId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`billing:${tenantId}`]);
}
