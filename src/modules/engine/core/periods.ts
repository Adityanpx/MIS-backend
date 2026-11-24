import { addDays, addMonths, datedifMonths, daysInclusive, maxDate, monthStart } from '../../../lib/dates';
import type { ISODate } from './types';

export interface Period { from: ISODate; to: ISODate; days: number }
export interface Periods {
  today: Period; mtd: Period; utd: Period;
  /** The user's own from..reportDate window (equals `today` when no range was asked for). */
  range: Period;
  monthsElapsed: number; omMonthNo: number; reportDate: ISODate;
}
export function periodsFor(d: ISODate, misStart: ISODate, omStart: ISODate, from?: ISODate | null): Periods {
  const ms = maxDate(monthStart(d), misStart);
  const rf = from && from < d ? maxDate(from, misStart) : d;
  return {
    today: { from: d, to: d, days: 1 },
    mtd: { from: ms, to: d, days: daysInclusive(ms, d) },
    utd: { from: misStart, to: d, days: daysInclusive(misStart, d) },
    range: { from: rf, to: d, days: daysInclusive(rf, d) },
    monthsElapsed: datedifMonths(misStart, d) + 1,
    omMonthNo: datedifMonths(omStart, d) + 1,
    reportDate: d,
  };
}
export function* eachDay(p: Period): Generator<ISODate> {
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) yield d;
}
/** The first day of each of the M elapsed months (used for monthly allowances). */
export function monthAnchors(misStart: ISODate, months: number): ISODate[] {
  return Array.from({ length: months }, (_, k) => addMonths(misStart, k));
}
