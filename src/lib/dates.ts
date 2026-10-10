export type ISODate = string; // 'YYYY-MM-DD'
const RE = /^\d{4}-\d{2}-\d{2}$/;
const IST_OFFSET_MS = 330 * 60 * 1000;

function parts(s: ISODate): [number, number, number] {
  return [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))];
}
function toUTC(s: ISODate): Date {
  const [y, m, d] = parts(s);
  return new Date(Date.UTC(y, m - 1, d));
}
function fromUTC(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string' || !RE.test(s)) return false;
  const d = toUTC(s);
  return !Number.isNaN(d.getTime()) && fromUTC(d) === s;
}
/** Today's calendar date in India. */
export function todayIST(now: Date = new Date()): ISODate {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
export function addDays(s: ISODate, n: number): ISODate {
  const d = toUTC(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}
/** Excel EDATE / Postgres month addition: day clamped to the last day of the target month. */
export function addMonths(s: ISODate, n: number): ISODate {
  const [y, m, d] = parts(s);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return fromUTC(new Date(Date.UTC(ny, nm, Math.min(d, last))));
}
export function addYears(s: ISODate, n: number): ISODate {
  return addMonths(s, n * 12);
}
/** b - a in days. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86_400_000);
}
/** Inclusive day count a..b (Excel DATEDIF(a,b,"D")+1). */
export function daysInclusive(a: ISODate, b: ISODate): number {
  return diffDays(a, b) + 1;
}
export function monthStart(s: ISODate): ISODate {
  return `${s.slice(0, 7)}-01`;
}
export function monthEnd(s: ISODate): ISODate {
  return addDays(addMonths(monthStart(s), 1), -1);
}
/** Excel DATEDIF(a, b, "M"): complete months from a to b. */
export function datedifMonths(a: ISODate, b: ISODate): number {
  const [y1, m1, d1] = parts(a);
  const [y2, m2, d2] = parts(b);
  let months = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) months -= 1;
  return months;
}
export const cmpDate = (a: ISODate, b: ISODate) => (a < b ? -1 : a > b ? 1 : 0);
export const minDate = (a: ISODate, b: ISODate) => (a <= b ? a : b);
export const maxDate = (a: ISODate, b: ISODate) => (a >= b ? a : b);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 21-Sep-2026 */
export function formatDisplayDate(s: ISODate): string {
  const [y, m, d] = parts(s);
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
}
/** Indian financial year label for a date, e.g. 2026-09-21 → "2026-27". */
export function financialYear(s: ISODate): string {
  const [y, m] = parts(s);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
