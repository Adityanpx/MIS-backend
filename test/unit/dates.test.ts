import { addMonths, daysInclusive, datedifMonths, financialYear, formatDisplayDate, todayIST } from '../../src/lib/dates';

describe('dates (IST, Excel-compatible)', () => {
  it('addMonths clamps to month end like EDATE', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2022-09-01', 60)).toBe('2027-09-01');
  });
  it('daysInclusive / datedifMonths / financialYear / display', () => {
    expect(daysInclusive('2023-09-01', '2024-08-31')).toBe(366);
    expect(datedifMonths('2022-09-01', '2026-09-21')).toBe(48);
    expect(financialYear('2026-09-21')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(formatDisplayDate('2026-09-21')).toBe('21-Sep-2026');
  });
  it('todayIST switches date at 18:30 UTC', () => {
    expect(todayIST(new Date('2026-10-06T18:29:59Z'))).toBe('2026-10-06');
    expect(todayIST(new Date('2026-10-06T18:30:00Z'))).toBe('2026-10-07');
  });
});
