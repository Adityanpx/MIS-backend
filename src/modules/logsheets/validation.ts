import { addDays, diffDays, todayIST } from '../../lib/dates';
import { standardAt, valueAt } from '../engine/core/effective';
import { eventOn } from '../engine/core/stats';
import type { DerivedMap, EngineSettings, ParamDef } from '../engine/core/types';

export type Values = Map<string, number | string | null>; // by parameter code
export interface FieldIssue { code: string; parameterId: string; message: string }

/** LOG-08 / LOG-10: is this date open for entry by this user? */
export function dateRule(
  s: EngineSettings,
  opts: { setupStatus: string; allowSameDay: boolean; backfillDays: number; isClientAdmin: boolean; exists: boolean },
  date: string,
): { allowed: boolean; reason: string | null } {
  const today = todayIST();
  if (date < s.plant.misStart || date > s.plant.omEnd) return { allowed: false, reason: 'OUTSIDE_CONTRACT' };
  if (date > today || (date === today && !opts.allowSameDay)) return { allowed: false, reason: 'FUTURE_DATE' };
  if (opts.setupStatus !== 'live') return { allowed: false, reason: 'PLANT_NOT_LIVE' };
  if (!opts.isClientAdmin && !opts.exists && diffDays(date, today) > opts.backfillDays) {
    return { allowed: false, reason: 'OUTSIDE_BACKFILL_WINDOW' };
  }
  return { allowed: true, reason: null };
}

/** Parameters shown on the logsheet for that date (active, not calculated). */
export const typedParams = (s: EngineSettings, d: string) =>
  s.params.filter((p) => p.inputMode !== 'calculated' && (!p.activeFrom || p.activeFrom <= d) && (!p.activeTo || p.activeTo >= d));

const isDefaultZero = (p: ParamDef) => p.linkRole === 'received' || p.linkRole === 'cash_received';

/**
 * full = submit/correct (mandatory checks + cross-field rules); otherwise draft (types and ranges only).
 * Returns hard errors (block) and soft warnings (allowed, listed in the confirmation).
 */
export function validateValues(s: EngineSettings, derived: DerivedMap, d: string, values: Values, full: boolean) {
  const errors: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];
  const params = typedParams(s, d);
  for (const p of params) {
    let v = values.get(p.code);
    if (v === undefined || v === null || v === '') {
      if (isDefaultZero(p)) {
        values.set(p.code, 0);
        v = 0;
      } else {
        if (full && p.mandatory && p.aggregation !== 'text') errors.push({ code: p.code, parameterId: p.id, message: 'Required' });
        continue;
      }
    }
    if (p.aggregation === 'text') {
      if (typeof v !== 'string') errors.push({ code: p.code, parameterId: p.id, message: 'Must be text' });
      else if (v.length > (p.code === 'REMARKS' ? 1000 : 500)) errors.push({ code: p.code, parameterId: p.id, message: 'Too long' });
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push({ code: p.code, parameterId: p.id, message: 'Must be a number' });
      continue;
    }
    if (p.hardMin !== null && v < p.hardMin) errors.push({ code: p.code, parameterId: p.id, message: `Must be at least ${p.hardMin}` });
    if (p.hardMax !== null && v > p.hardMax) errors.push({ code: p.code, parameterId: p.id, message: `Must be at most ${p.hardMax}` });
    if (p.decimals === 0 && (p.group === 'staff' || p.group === 'safety') && !Number.isInteger(v)) {
      errors.push({ code: p.code, parameterId: p.id, message: 'Must be a whole number' });
    }
    // soft: event rule, and warning limits on non-range parameters (e.g. PF < 0.95)
    if (eventOn(s, p, d, v)) warnings.push({ code: p.code, parameterId: p.id, message: `${p.name}: ${v} is outside the standard` });
    const st = standardAt(p, d);
    if (p.stdType !== 'range' && st && ((st.min !== null && v < st.min) || (st.max !== null && v > st.max))) {
      warnings.push({ code: p.code, parameterId: p.id, message: `${p.name}: ${v} is outside the warning limit` });
    }
  }
  if (full) {
    for (const c of s.staff) { // vacant + present + leave <= strength (hard)
      const strength = valueAt(c.strengths, d) ?? 0;
      const sum = [c.vacantCode, c.presentCode, c.leaveCode].reduce((a, k) => a + (Number(values.get(k)) || 0), 0);
      if (sum > strength) {
        const p = params.find((x) => x.code === c.presentCode);
        errors.push({ code: c.presentCode, parameterId: p?.id ?? '', message: `${c.name}: vacant + present + leave (${sum}) exceeds the strength ${strength}` });
      }
    }
    const exp = s.params.find((p) => p.linkRole === 'expense');
    const desc = s.params.find((p) => p.linkRole === 'description');
    const expense = exp ? Number(values.get(exp.code)) || 0 : 0;
    if (desc && expense > 0 && !String(values.get(desc.code) ?? '').trim()) {
      errors.push({ code: desc.code, parameterId: desc.id, message: 'Describe the expenses' });
    }
    if (exp && s.cash.alertLimit !== null && expense > s.cash.alertLimit) {
      warnings.push({ code: exp.code, parameterId: exp.id, message: `Expenses ₹${expense} exceed the daily limit ₹${s.cash.alertLimit}` });
    }
    // stock closing preview (§13.7): yesterday's closing − consumed + received
    const prev = derived.get(addDays(d, -1));
    for (const i of s.stock) {
      const opening = d === addDays(i.openingDate, 1) ? i.opening : prev?.stock[i.code];
      if (opening === undefined) continue;
      const closing = opening - (Number(values.get(i.consumedCode)) || 0) + (Number(values.get(i.receivedCode)) || 0);
      if (closing < 0 || (i.minLevel !== null && closing < i.minLevel)) {
        const p = params.find((x) => x.code === i.consumedCode);
        warnings.push({ code: i.consumedCode, parameterId: p?.id ?? '',
          message: `${i.name} closing balance ${closing} is ${closing < 0 ? 'negative' : 'below the minimum level'}` });
      }
    }
  }
  return { errors, warnings };
}
