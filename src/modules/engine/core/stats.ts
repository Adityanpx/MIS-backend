import { isActive, standardAt, valueAt } from './effective';
import { dayValue } from './derive';
import { eachDay, monthAnchors, type Period, type Periods } from './periods';
import type { DerivedMap, EngineData, EngineSettings, Flag, ISODate, ParamDef } from './types';

export interface Triple { std: number | null; act: number | null; var: number | null; varFlag: Flag }

/** Unfavourable direction → 'bad' (fixes D9/D10: EB savings are not red). */
export function flagFor(direction: ParamDef['direction'], variance: number | null): Flag {
  if (variance === null || variance === 0) return 'neutral';
  if (direction === 'lower_better') return variance > 0 ? 'bad' : 'ok';
  if (direction === 'higher_better') return variance < 0 ? 'bad' : 'ok';
  return 'neutral';
}

/** Per-day standard of a parameter (safety → required qty, others → std_value). */
export function dailyStd(s: EngineSettings, p: ParamDef, d: ISODate): number | null {
  if (p.stdType === 'required_qty' && p.safetyItemId) {
    const item = s.safety.find((x) => x.id === p.safetyItemId);
    return item ? valueAt(item.required, d) ?? null : null;
  }
  return standardAt(p, d)?.std ?? null;
}

export function eventOn(s: EngineSettings, p: ParamDef, d: ISODate, value: number): boolean {
  if (p.eventRule === 'none') return false;
  if (p.eventRule === 'outside_range') {
    const st = standardAt(p, d);
    return (st?.min != null && value < st.min) || (st?.max != null && value > st.max);
  }
  const std = dailyStd(s, p, d);
  if (std === null) return false;
  return p.eventRule === 'above_std' ? value > std : value < std;
}

export function actual(data: EngineData, derived: DerivedMap, p: ParamDef, period: Period): number | null {
  const vals: number[] = [];
  for (const d of eachDay(period)) {
    if (!isActive(p, d)) continue;
    const v = dayValue(data, derived, p.code, d);
    if (v !== null) vals.push(v);
  }
  if (p.aggregation === 'snapshot') return dayValue(data, derived, p.code, period.to);
  if (vals.length === 0) return p.aggregation === 'sum' ? 0 : null;
  const sum = vals.reduce((a, b) => a + b, 0);
  return p.aggregation === 'avg' ? sum / vals.length : sum;
}

/** STD over a period: per-day standards summed day by day; monthly allowances per §13.2. */
export function standard(s: EngineSettings, p: ParamDef, period: Period, kind: 'today' | 'mtd' | 'utd', periods: Periods): number | null {
  if (p.stdType === 'monthly_allowance') {
    if (kind === 'today') return standardAt(p, period.to)?.std ?? null;
    if (kind === 'mtd') return standardAt(p, period.to)?.monthly ?? null;
    let sum = 0;
    for (const a of monthAnchors(s.plant.misStart, periods.monthsElapsed)) sum += standardAt(p, a)?.monthly ?? 0;
    return sum;
  }
  if (p.stdType === 'per_day' || p.stdType === 'required_qty') {
    let sum = 0;
    let any = false;
    for (const d of eachDay(period)) {
      const v = dailyStd(s, p, d);
      if (v !== null) {
        sum += v;
        any = true;
      }
    }
    return any ? sum : null;
  }
  return null;
}

export function events(s: EngineSettings, data: EngineData, derived: DerivedMap, p: ParamDef, period: Period): number {
  let n = 0;
  for (const d of eachDay(period)) {
    if (!data.days.has(d) || !isActive(p, d)) continue;
    const v = dayValue(data, derived, p.code, d);
    if (v !== null && eventOn(s, p, d, v)) n++;
  }
  return n;
}

export function dataDays(data: EngineData, period: Period): number {
  let n = 0;
  for (const d of eachDay(period)) if (data.days.has(d)) n++;
  return n;
}

export const triple = (std: number | null, act: number | null, direction: ParamDef['direction']): Triple => {
  const v = std === null || act === null ? null : act - std;
  return { std, act, var: v, varFlag: flagFor(direction, v) };
};
export const pct = (variance: number | null, std: number | null): number | null =>
  variance === null || std === null || std === 0 ? null : variance / std;
export const resultText = (p: number | null, noun: string | null): string | null =>
  p === null || !noun ? null : `${p <= 0 ? 'LESS' : 'EXCESS'} ${noun}`;
