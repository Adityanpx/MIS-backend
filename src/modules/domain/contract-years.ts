import { addDays, addMonths, daysInclusive, minDate, type ISODate } from '../../lib/dates';
import { unprocessable } from '../../lib/errors';
import { MAX_CONTRACT_YEARS, MAX_TENURE_MONTHS } from '../../shared/constants';

export interface ContractYearSpan {
  yearNo: number;
  startDate: ISODate;
  endDate: ISODate;
  days: number;
}

export function assertTenure(months: number): void {
  if (!Number.isInteger(months) || months < 1 || months > MAX_TENURE_MONTHS) {
    throw unprocessable(
      'CONTRACT_TOO_LONG',
      `O&M tenure must be between 1 and ${MAX_TENURE_MONTHS} months (maximum ${MAX_CONTRACT_YEARS} years).`,
    );
  }
}

export function omEndDate(omStart: ISODate, tenureMonths: number): ISODate {
  assertTenure(tenureMonths);
  return addDays(addMonths(omStart, tenureMonths), -1);
}

export function buildContractYears(omStart: ISODate, tenureMonths: number): ContractYearSpan[] {
  const omEnd = omEndDate(omStart, tenureMonths);
  const count = Math.ceil(tenureMonths / 12);
  const years: ContractYearSpan[] = [];
  for (let k = 1; k <= count; k++) {
    const startDate = addMonths(omStart, 12 * (k - 1));
    const endDate = minDate(addDays(addMonths(omStart, 12 * k), -1), omEnd);
    years.push({ yearNo: k, startDate, endDate, days: daysInclusive(startDate, endDate) });
  }
  return years;
}

/** The contract year containing a date (undefined outside the contract). Used by the Phase 2 engine. */
export function contractYearOf(date: ISODate, years: ContractYearSpan[]): ContractYearSpan | undefined {
  return years.find((y) => date >= y.startDate && date <= y.endDate);
}
