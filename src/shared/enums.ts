export const PLANT_ROLES = ['editor', 'checker', 'verifier', 'viewer'] as const;
export type PlantRole = (typeof PLANT_ROLES)[number];

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const CLIENT_ACCOUNT_STATES = ['active', 'grace', 'read_only', 'suspended', 'terminated'] as const;
export const PLANT_ACCOUNT_STATES = ['active', 'grace', 'read_only', 'suspended', 'terminated', 'expired'] as const;
export type PlantAccountState = (typeof PLANT_ACCOUNT_STATES)[number];
export const CLIENT_STATUSES = ['active', 'scheduled_for_deletion', 'deleted'] as const;

export const PLANT_TYPES = ['STP', 'WTP', 'ETP', 'CETP', 'OTHER'] as const;
export const SETUP_STATUSES = ['settings_pending', 'live', 'closed'] as const;

export const PLAN_STATUSES = ['active', 'archived'] as const;
export const BILLING_MODES = ['yearly', 'upfront'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
export const SUBSCRIPTION_STATUSES = ['scheduled', 'active', 'ended', 'cancelled'] as const;

// Phase 2
export const PARAM_GROUPS = ['key', 'chemical', 'lab_inlet', 'lab_outlet', 'safety', 'staff', 'cash', 'other'] as const;
export const INPUT_MODES = ['typed', 'calculated', 'suggested'] as const;
export const AGGREGATIONS = ['sum', 'avg', 'snapshot', 'stock', 'text'] as const;
export const STD_TYPES = ['per_day', 'monthly_allowance', 'range', 'required_qty', 'none'] as const;
export const DIRECTIONS = ['higher_better', 'lower_better', 'within_range', 'neutral'] as const;
export const EVENT_RULES = ['above_std', 'below_std', 'outside_range', 'none'] as const;
export const LOGSHEET_STATUSES = ['draft', 'submitted', 'corrected', 'returned', 'checked', 'verified'] as const;
export const PDF_DOC_TYPES = ['logsheet', 'mis', 'dashboard'] as const;
export const PDF_STATUSES = ['current', 'superseded', 'stale', 'failed'] as const;

// Phase 3
export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled', 'written_off'] as const;
export const PAYMENT_MODES = ['razorpay', 'cash', 'neft', 'rtgs', 'imps', 'cheque', 'upi', 'other'] as const;
export const PAYMENT_STATUSES = ['pending_clearance', 'applied', 'bounced', 'reversed'] as const;
export const DOC_SEQUENCE_TYPES = ['invoice', 'credit_note', 'receipt'] as const;

// Phase 3 (additions)
export const OFFLINE_PAYMENT_MODES = ['cash', 'neft', 'rtgs', 'imps', 'cheque', 'upi', 'other'] as const;
export type OfflinePaymentMode = (typeof OFFLINE_PAYMENT_MODES)[number];
export const ADMIN_REPORT_KEYS = [
  'revenue', 'collections', 'ageing', 'gst-register', 'tds', 'renewals', 'contract-value', 'cheques',
  'clients', 'plants', 'subscriptions', 'usage', 'lifecycle-history',
] as const;
export type AdminReportKey = (typeof ADMIN_REPORT_KEYS)[number];
export const SETTINGS_GROUPS = [
  'company', 'tax', 'numbering', 'billing', 'lifecycle', 'reminders', 'plans', 'payment-gateway', 'email', 'branding',
  'security', 'act-as',
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];
export const DOCUMENT_TYPES = ['agreement', 'purchase_order', 'work_order', 'other'] as const;
