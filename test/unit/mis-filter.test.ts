import { describe, expect, it } from 'vitest';
import { computeDerived } from '../../src/modules/engine/core/derive';
import { buildMis, type Bundle } from '../../src/modules/engine/core/mis';
import { goldenInput } from '../golden/fixture';

const D = '2026-09-21';
function bundle(): Bundle {
  const { settings, data } = goldenInput();
  return { settings, data, derived: computeDerived(settings, data, D) };
}

/** MIS-FILTER: every section carries a value per period so the page / PDF can follow the period filter. */
describe('MIS per-period sections', () => {
  const m = buildMis(bundle(), D, {}, '2026-09-15');

  it('Daily staff / safety equal the day snapshot', () => {
    expect(m.staff.periods.today.total).toMatchObject(m.staff.total);
    expect(m.staff.periods.today.averaged).toBe(false);
    expect(m.safety.periods.today.rows.map((r) => r.actual)).toEqual(m.safety.rows.map((r) => r.actual));
  });

  it('Monthly / UTD / Range staff and safety are averages over the logged days', () => {
    expect(m.staff.periods.mtd).toMatchObject({ averaged: true, dataDays: m.header.mtdDataDays });
    expect(m.staff.periods.utd.dataDays).toBe(m.header.utdDataDays);
    expect(m.staff.periods.range.dataDays).toBe(m.header.rangeDataDays);
    const present = m.staff.periods.mtd.total.present ?? 0;
    expect(present).toBeGreaterThan(0);
    expect(present).toBeLessThanOrEqual(m.staff.periods.mtd.total.contract ?? Infinity);
  });

  it('cash per period matches the existing totals', () => {
    expect(m.cash.periods.today.spent).toBe(m.cash.today);
    expect(m.cash.periods.mtd.spent).toBe(m.cash.mtd);
    expect(m.cash.periods.utd.spent).toBe(m.cash.utd);
  });

  it('lab rows have a value, result and events per period and per standard', () => {
    const r = m.lab.outlet[0]!;
    expect(r.values.today).toBe(r.act);
    expect(r.values.mtd).toBe(r.avg.mtd);
    expect(r.standards.actual.events.mtd).toBeGreaterThanOrEqual(r.standards.actual.events.today);
    expect(r.standards.actual.events.utd).toBeGreaterThanOrEqual(r.standards.actual.events.mtd);
    expect(['WITHIN LIMIT', 'EXCEEDED LIMIT', null]).toContain(r.standards.bidding.results.utd.result);
  });
});
