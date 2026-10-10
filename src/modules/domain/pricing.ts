import { addDays, addMonths, maxDate, minDate, type ISODate } from '../../lib/dates';
import { unprocessable } from '../../lib/errors';
import { D, money, round2 } from '../../lib/money';
import type { BillingMode } from '../../shared/enums';
import { MAX_CONTRACT_YEARS } from '../../shared/constants';

export interface YearAmount {
  yearNo: number;
  amount: string;
}

export function assertTermYears(termYears: number): void {
  if (!Number.isInteger(termYears) || termYears < 1 || termYears > MAX_CONTRACT_YEARS) {
    throw unprocessable('CONTRACT_TOO_LONG', `Subscription term must be 1 to ${MAX_CONTRACT_YEARS} years.`);
  }
}

export function escalatedYearAmounts(pricePerYear: string, escalationPct: string | number, termYears: number): YearAmount[] {
  assertTermYears(termYears);
  const factor = D(1).plus(D(escalationPct).div(100));
  return Array.from({ length: termYears }, (_, i) => ({
    yearNo: i + 1,
    amount: money(D(pricePerYear).mul(factor.pow(i))),
  }));
}

export const sumAmounts = (rows: Array<{ amount: string }>): string =>
  money(rows.reduce((s, r) => s.plus(r.amount), D(0)));

export function upfrontAmount(years: YearAmount[], discountPct: string | number): string {
  return money(D(sumAmounts(years)).mul(D(1).minus(D(discountPct).div(100))));
}

export interface GstSplit {
  taxable: string;
  gstType: 'intra' | 'inter' | 'unknown';
  ratePct: number;
  cgst: string;
  sgst: string;
  igst: string;
  gst: string;
  total: string;
}
/** intra = seller and buyer in the same state; null = seller state not configured yet (shown as IGST, type 'unknown'). */
export function gstSplit(taxable: string, ratePct: number, intra: boolean | null): GstSplit {
  const t = D(taxable);
  let cgst = D(0);
  let sgst = D(0);
  let igst = D(0);
  if (intra === true) {
    cgst = round2(t.mul(ratePct).div(100).div(2));
    sgst = cgst;
  } else {
    igst = round2(t.mul(ratePct).div(100));
  }
  const gst = cgst.plus(sgst).plus(igst);
  return {
    taxable: money(t), gstType: intra === null ? 'unknown' : intra ? 'intra' : 'inter', ratePct,
    cgst: money(cgst), sgst: money(sgst), igst: money(igst), gst: money(gst), total: money(t.plus(gst)),
  };
}

export interface PriceTableInput {
  termYears: number;
  pricePerYear: string;
  escalationPct: string | number;
  upfrontDiscountPct: string | number;
  gstRatePct: number;
}
/** PLN-05: year-by-year table, totals with GST, and the upfront price. */
export function priceTable(p: PriceTableInput) {
  const years = escalatedYearAmounts(p.pricePerYear, p.escalationPct, p.termYears);
  const total = sumAmounts(years);
  const totalGst = gstSplit(total, p.gstRatePct, null);
  const upfront = upfrontAmount(years, p.upfrontDiscountPct);
  const upfrontGst = gstSplit(upfront, p.gstRatePct, null);
  return {
    years,
    totalExGst: total,
    gstRatePct: p.gstRatePct,
    gst: totalGst.gst,
    totalIncGst: totalGst.total,
    upfront: {
      discountPct: Number(p.upfrontDiscountPct),
      amountExGst: upfront,
      gst: upfrontGst.gst,
      totalIncGst: upfrontGst.total,
      savingExGst: money(D(total).minus(upfront)),
    },
  };
}

export function subscriptionEndDate(startDate: ISODate, termYears: number): ISODate {
  assertTermYears(termYears);
  return addDays(addMonths(startDate, 12 * termYears), -1);
}

export interface ScheduleRow {
  yearNo: number;
  periodFrom: ISODate;
  periodTo: ISODate;
  amount: string;
  plannedInvoiceDate: ISODate;
  dueDate: ISODate;
}
export interface ScheduleInput {
  startDate: ISODate;
  termYears: number;
  billingMode: BillingMode;
  pricePerYear: string;
  escalationPct: string | number;
  upfrontDiscountPct: string | number;
  today: ISODate;
  invoiceLeadDays: number;
  minPaymentTermsDays: number;
}
export function buildBillingSchedule(p: ScheduleInput): ScheduleRow[] {
  const end = subscriptionEndDate(p.startDate, p.termYears);
  const dates = (from: ISODate) => {
    const planned = maxDate(p.today, addDays(from, -p.invoiceLeadDays));
    const earliestDue = addDays(planned, p.minPaymentTermsDays);
    return { plannedInvoiceDate: planned, dueDate: from < earliestDue ? earliestDue : from };
  };
  const years = escalatedYearAmounts(p.pricePerYear, p.escalationPct, p.termYears);
  if (p.billingMode === 'upfront') {
    return [{ yearNo: 1, periodFrom: p.startDate, periodTo: end, amount: upfrontAmount(years, p.upfrontDiscountPct), ...dates(p.startDate) }];
  }
  return years.map((y) => {
    const from = addMonths(p.startDate, 12 * (y.yearNo - 1));
    const to = minDate(addDays(addMonths(p.startDate, 12 * y.yearNo), -1), end);
    return { yearNo: y.yearNo, periodFrom: from, periodTo: to, amount: y.amount, ...dates(from) };
  });
}
