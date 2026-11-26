import type { PlanSnapshot } from '../../db/types';
import { DEFAULT_MAX_MANAGEMENT_USERS, DEFAULT_MAX_USERS_PER_PLANT, DEFAULT_STORAGE_GB_PER_PLANT } from '../../shared/constants';

/** Terms the Super Admin types per plant (no plan catalogue). */
export interface CustomTerms { termYears: number; pricePerYear: string; escalationPct: number }

/**
 * The subscription's locked terms. Stored in plan_snapshot so pricing, extension, user limits and reports
 * keep reading one place. Limits are the platform-wide defaults; billing is always yearly.
 */
export const customSnapshot = (t: CustomTerms): PlanSnapshot => ({
  planId: null, name: 'Custom', code: 'CUSTOM', termYears: t.termYears, pricePerYear: t.pricePerYear,
  escalationPct: String(t.escalationPct), upfrontDiscountPct: '0',
  maxUsersPerPlant: DEFAULT_MAX_USERS_PER_PLANT, maxManagementUsers: DEFAULT_MAX_MANAGEMENT_USERS,
  storageGb: DEFAULT_STORAGE_GB_PER_PLANT, features: {},
});
