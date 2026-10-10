export interface ClientRow {
  id: string; code: string; display_name: string; legal_name: string; gstin: string | null; pan: string | null;
  state_code: string; address: Record<string, unknown>; primary_contact: Record<string, unknown>;
  billing_emails: string[]; logo_key: string | null; notes: string | null; force_2fa: boolean;
  account_state: string; manual_suspended: boolean; hold_until: string | null; status: string;
  terms_version: string | null; terms_accepted_at: string | null; created_at: string; updated_at: string | null;
}
export interface UserRow {
  id: string; tenant_id: string; name: string; email: string; mobile: string | null; designation: string | null;
  password_hash: string | null; totp_secret_enc: string | null; totp_enabled: boolean; is_client_admin: boolean;
  status: 'invited' | 'active' | 'disabled'; token_version: number; failed_logins: number;
  locked_until: string | null; last_login_at: string | null; created_at: string;
}
export interface SuperAdminRow {
  id: string; name: string; email: string; mobile: string | null; password_hash: string | null;
  totp_secret_enc: string | null; totp_enabled: boolean; status: 'invited' | 'active' | 'disabled';
  failed_logins: number; locked_until: string | null; token_version: number; last_login_at: string | null;
  created_at: string;
}
export interface PlanRow {
  id: string; name: string; code: string; description: string | null; term_years: number; price_per_year: string;
  escalation_pct: string; upfront_discount_pct: string; max_users_per_plant: number; storage_gb: number;
  features: Record<string, boolean>; status: 'active' | 'archived'; created_at: string;
}
export interface PlantRow {
  id: string; tenant_id: string; code: string; name: string; type: string; capacity_mld: string; city: string | null;
  state_code: string; om_start: string; om_tenure_months: number; om_end: string; mis_start: string;
  setup_status: string; account_state: string; manual_suspended: boolean; hold_until: string | null;
  closed_at: string | null; created_at: string;
}
export interface ContractYearRow {
  id: string; tenant_id: string; plant_id: string; year_no: number; start_date: string; end_date: string;
  days: number; fixed_fee: string; fee_configured: boolean;
}
export interface SubscriptionRow {
  id: string; tenant_id: string; plant_id: string; plan_id: string; plan_snapshot: PlanSnapshot;
  custom_price_per_year: string | null; custom_reason: string | null; start_date: string; end_date: string;
  billing_mode: 'yearly' | 'upfront'; trial_days: number; status: string; created_at: string;
}
export interface PlanSnapshot {
  planId: string; name: string; code: string; termYears: number; pricePerYear: string; escalationPct: string;
  upfrontDiscountPct: string; maxUsersPerPlant: number; storageGb: number; features: Record<string, boolean>;
}
export interface BillingScheduleRow {
  id: string; tenant_id: string; subscription_id: string; year_no: number; period_from: string; period_to: string;
  amount: string; planned_invoice_date: string; due_date: string; invoice_id: string | null;
}
