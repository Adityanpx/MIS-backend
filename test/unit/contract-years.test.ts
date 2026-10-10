import { buildContractYears, contractYearOf, omEndDate } from '../../src/modules/domain/contract-years';

describe('contract years (PRD REV-01)', () => {
  it('matches the reference plant (01-Sep-2022, 60 months)', () => {
    const y = buildContractYears('2022-09-01', 60);
    expect(y).toHaveLength(5);
    expect(y.map((r) => [r.startDate, r.endDate, r.days])).toEqual([
      ['2022-09-01', '2023-08-31', 365],
      ['2023-09-01', '2024-08-31', 366],
      ['2024-09-01', '2025-08-31', 365],
      ['2025-09-01', '2026-08-31', 365],
      ['2026-09-01', '2027-08-31', 365],
    ]);
    expect(omEndDate('2022-09-01', 60)).toBe('2027-08-31');
  });
  it('allows a partial last year (90 months)', () => {
    const y = buildContractYears('2022-09-01', 90);
    expect(y).toHaveLength(8);
    expect(y[7]).toEqual({ yearNo: 8, startDate: '2029-09-01', endDate: '2030-02-28', days: 181 });
  });
  it('max 15 years / 180 months', () => {
    expect(buildContractYears('2022-09-01', 180)).toHaveLength(15);
    expect(() => buildContractYears('2022-09-01', 181)).toThrow(/180 months/);
    expect(() => buildContractYears('2022-09-01', 0)).toThrow();
  });
  it('finds the year containing a date', () => {
    const y = buildContractYears('2022-09-01', 60);
    expect(contractYearOf('2026-09-21', y)?.yearNo).toBe(5);
    expect(contractYearOf('2027-09-01', y)).toBeUndefined();
  });
});
