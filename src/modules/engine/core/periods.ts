import { addDays, addMonths, datedifMonths, daysInclusive, maxDate, monthStart } from '../../../lib/dates';
import type { ISODate } from './types';

export interface Period { from: ISODate; to: ISODate; days: number }
export interface Periods {
  today: Period; mtd: Period; utd: Period;
  monthsElapsed: number; omMonthNo: number; reportDate: ISODate;
}
export function periodsFor(d: ISODate, misStart: ISODate, omStart: ISODate): Periods {
  const ms = maxDate(monthStart(d), misStart);
  return {
    today: { from: d, to: d, days: 1 },
    mtd: { from: ms, to: d, days: daysInclusive(ms, d) },
    utd: { from: misStart, to: d, days: daysInclusive(misStart, d) },
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
