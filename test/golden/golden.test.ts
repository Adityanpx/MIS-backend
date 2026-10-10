import { buildDashboard } from '../../src/modules/engine/core/dashboard';
import { computeDerived } from '../../src/modules/engine/core/derive';
import { buildMis, type Bundle } from '../../src/modules/engine/core/mis';
import * as rpt from '../../src/modules/reports/reports.service';
import { goldenInput, goldenRows } from './fixture';

const D = '2026-09-21';
const { settings, data } = goldenInput();
const bundle: Bundle = { settings, data, derived: computeDerived(settings, data, D) };
const mis = buildMis(bundle, D);
const row = (code: string) => {
  const r = [...mis.keyParameters, ...mis.chemicals].find((x) => x.code === code);
  if (!r) throw new Error(`missing row ${code}`);
  return r;
};
/** expected value with k decimals → toBeCloseTo(expected, k) */
const near = (actual: number | null | undefined, expected: number, k = 2) => expect(actual).toBeCloseTo(expected, k);

describe('golden: daily derived values equal the Excel for all 690 days', () => {
  it('DG kWh, stock balances (except lime after the "z"), cash, absent, revenue', () => {
    for (const r of goldenRows()) {
      const d = bundle.derived.get(r.date!)!;
      near(d.calc.DG_KWH ?? null, Number(r.dg_kwh), 4);
      near(d.stock.DIESEL, Number(r.diesel_balance_l), 4);
      near(d.stock.POLY, Number(r.poly_balance_kg), 4);
      near(d.stock.CHLORINE, Number(r.chlorine_balance_kg), 4);
      near(d.stock.ALUM, Number(r.alum_balance_kg), 4);
      if (r.date! < '2024-11-07') near(d.stock.LIME, Number(r.lime_balance_kg), 4);
      near(d.cash, Number(r.cash_balance), 4);
      near(d.absent.TP, Number(r.tp_absent), 4);
      near(d.absent.FTC, Number(r.ftc_absent), 4);
      near(d.revStd, Number(r.std_total_rev), 4);
      near(d.revAct, Number(r.act_total_rev), 4);
    }
  });
});

describe('golden: MIS report on 21-Sep-2026 (Appendix B)', () => {
  it('header', () => {
    expect(mis.header).toMatchObject({ mtdDays: 21, utdDays: 690, monthsElapsed: 23, omMonthNo: 49, omYearNo: '05', mtdDataDays: 21, utdDataDays: 690 });
  });
  it.each([
    // code, today std/act, mtd std/act, utd std/act, avg mtd/utd, events mtd/utd, utd %
    ['INFLOW', 120, 120, 2520, 2604, 82800, 86664, 124, 125.6, 11, 458, 0.0467],
    ['EB_KWH', 18200, 14330, 382200, 397110, 12558000, 13046190, 18910, 18907.52, 13, 422, 0.0389],
    ['DG_HRS', 8, 2, 32, 19, 736, 655, 0.905, 0.949, 0, 0, -0.1101],
    ['DG_KWH', 9360, 2340, 37440, 22230, 861120, 766350, 1058.57, 1110.65, 0, 0, -0.1101],
    ['BGE_HRS', 21.0714, 14, 442.5, 354, 14539.29, 13057, 16.857, 18.923, 0, 79, -0.102],
    ['BGE_KWH', 11800, 10080, 247800, 224160, 8142000, 7845960, 10674.29, 11370.96, 2, 286, -0.0364],
  ])('%s', (code, ts, ta, ms, ma, us, ua, am, au, em, eu, up) => {
    const r = row(code as string);
    near(r.today.std, ts as number, 3); near(r.today.act, ta as number, 3);
    near(r.mtd.std, ms as number, 1); near(r.mtd.act, ma as number, 2);
    near(r.utd.std, us as number, 1); near(r.utd.act, ua as number, 2);
    near(r.avgPerDay.mtd, am as number, 2); near(r.avgPerDay.utd, au as number, 2);
    expect(r.events).toMatchObject({ mtd: em, utd: eu });
    near(r.utdResult.pct, up as number, 3);
  });
  it('revenue (₹ million) with the fixed event rule (D10)', () => {
    const r = row('REVENUE');
    near(r.today.std, 0.127226, 5); near(r.today.act, 0.115137, 5);
    near(r.mtd.std, 2.671737, 5); near(r.mtd.act, 2.469539, 5);
    near(r.utd.std, 83.673112, 4); near(r.utd.act, 80.278146, 4);
    expect(r.events).toMatchObject({ mtd: 21, utd: 521 });
    near(r.utdResult.pct, -0.0406, 3);
    expect(r.utdResult.text).toBe('LESS REVENUE GENERATED');
    near(mis.revenueDay!.fixedPerDay, 73405.55, 2); near(mis.revenueDay!.std, 127225.55, 2); near(mis.revenueDay!.act, 115136.75, 2);
  });
  it.each([
    ['DIESEL', 270, 2520, 2306, 82800, 64634, 8, 222, 43464, -0.2194],
    ['POLY', 25.07, 630, 588.8, 20700, 19922.6, 6, 238, 2605, -0.0376],
    ['CHLORINE', 395.5, 8820, 9086, 289800, 303296, 12, 459, 12424, 0.0466],
    ['LIME', 1180, 25200, 25960, 828000, 866560, 12, 459, 34640, 0.0466],
    ['ALUM', 936, 20160, 20648, 662400, 693128, 11, 458, 27832, 0.0464],
  ])('chemical %s', (code, ta, ms, ma, us, ua, em, eu, bal, up) => {
    const r = mis.chemicals.find((x) => x.code === `${code}_CONSUMED`)!;
    near(r.today.act, ta as number, 2);
    near(r.mtd.std, ms as number, 2); near(r.mtd.act, ma as number, 2);
    near(r.utd.std, us as number, 2); near(r.utd.act, ua as number, 2);
    expect(r.events).toMatchObject({ mtd: em, utd: eu });
    near(r.balance, bal as number, 2);
    expect(r.received).toBe(0);
    near(r.utdResult.pct, up as number, 3);
  });
  it('lab (B3), including the inlet pH low-limit fix (D3)', () => {
    const inl = (c: string) => mis.lab.inlet.find((l) => l.code === c)!;
    const out = (c: string) => mis.lab.outlet.find((l) => l.code === c)!;
    near(inl('IN_PH').act, 7.3, 2); near(inl('IN_PH').avg.mtd, 7.443, 2); near(inl('IN_PH').avg.utd, 7.501, 2);
    expect(inl('IN_PH').events).toMatchObject({ mtd: 0, utd: 1 });
    near(inl('IN_BOD').avg.mtd, 188.52, 1); near(inl('IN_COD').avg.utd, 402.38, 1); near(inl('IN_FC').avg.mtd, 9310902.43, 0);
    near(out('OUT_BOD').act, 7, 2); near(out('OUT_BOD').avg.mtd, 4.524, 2); near(out('OUT_BOD').avg.utd, 3.277, 2);
    near(out('OUT_COD').avg.utd, 17.567, 2); near(out('OUT_FC').avg.utd, 85.394, 2);
    expect(out('OUT_TSS').events).toMatchObject({ mtd: 0, utd: 2 });
    expect(out('OUT_PH').result).toBe('WITHIN LIMIT');
  });
  it('cash, staff, safety on D (B4)', () => {
    expect(mis.cash).toMatchObject({ today: 473, mtd: 8525, utd: 242764, received: 0, inHand: 12614, description: 'FOR BILL PRINTING & XEROX' });
    expect(mis.staff.total).toMatchObject({ contract: 32, vacant: 0, present: 30, leave: 0, absent: 2 });
    expect(mis.safety.rows.map((s) => [s.required, s.actual, s.deficit])).toEqual([[12, 10, 2], [21, 19, 2], [15, 15, 0]]);
    expect(mis.safety.total).toMatchObject({ required: 48, actual: 44, deficit: 4 });
  });
  it('registers on D (BG-04, INS-02)', () => {
    expect(mis.registers.bankGuarantees[0]).toMatchObject({ label: 'BG-1', status: 'VALID', claimUpTo: '2029-09-04' });
    expect(mis.registers.insurance.map((r) => [r.label, r.status])).toEqual([['WC', 'VALID'], ['FIRE', 'VALID'], ['IAR', 'NOT_AVAILABLE']]);
  });
});

describe('golden: dashboard (B6, B7)', () => {
  const dash = buildDashboard(bundle, D);
  const card = (code: string) => [...dash.keyParameters, ...dash.chemicals].find((c) => c!.code === code)!;
  it('MTD % badges and colours by direction (D9)', () => {
    near(card('INFLOW').mtd.value, 2604, 0); near(card('INFLOW').mtd.arrow === 'up' ? 1 : 0, 1, 0);
    const pctOf = (code: string) => row(code).mtdPct!;
    near(pctOf('INFLOW'), 0.033, 3); near(pctOf('EB_KWH'), 0.039, 3); near(pctOf('BGE_KWH'), -0.095, 3);
    near(pctOf('DG_KWH'), -0.406, 3); near(pctOf('REVENUE'), -0.076, 3);
    near(pctOf('DIESEL_CONSUMED'), -0.085, 3); near(pctOf('CHLORINE_CONSUMED'), 0.030, 3); near(pctOf('ALUM_CONSUMED'), 0.024, 3);
    expect(card('EB_KWH').mtd.colour).toBe('red');
    expect(card('INFLOW').mtd.colour).toBe('blue');
  });
  it('chart series Apr–Aug 2026 (B7)', () => {
    const vals = (code: string) => card(code).chart.values;
    const exp = (a: Array<number | null>, e: number[], k = 2) => e.forEach((x, i) => near(a[i], x, k));
    expect(card('INFLOW').chart.months).toEqual(['Apr-26', 'May-26', 'Jun-26', 'Jul-26', 'Aug-26']);
    exp(vals('INFLOW'), [127.5, 125.13, 126.87, 128.81, 123.55]);
    exp(vals('EB_KWH'), [19062, 19247.42, 18559.67, 19837.74, 18583.23]);
    exp(vals('BGE_KWH'), [11760, 11129.03, 11480, 11458.06, 11322.58]);
    exp(vals('DG_KWH'), [1053, 905.81, 1677, 905.81, 981.29]);
    exp(vals('REVENUE'), [3.57, 3.61, 3.54, 3.65, 3.64], 1);
    exp(vals('DIESEL_CONSUMED'), [88.2, 75.87, 140.47, 75.87, 82.19]);
    exp(vals('ALUM_CONSUMED'), [1020, 1001.03, 1014.93, 1030.45, 988.39]);
    exp(dash.quality.find((q) => q.code === 'OUT_TSS')!.chart.values, [4.27, 4.74, 4.63, 4.68, 6.52]);
    exp(dash.quality.find((q) => q.code === 'OUT_FC')!.chart.values, [86.2, 85.1, 86.7, 83.32, 86.26]);
    exp(dash.cash.chart!.values, [10859, 10719, 10431, 10981, 10922], 0);
  });
});

describe('golden: reports (B8)', () => {
  it('monthly Sep-2026: statistics over days with data only (D16)', () => {
    const t = rpt.monthly(bundle, '2026-09', ['BGE_HRS', 'BGE_KWH']);
    const f = (label: string) => t.footer!.find((x) => x.date === label)!;
    expect(f('Total')).toMatchObject({ BGE_HRS: 354, BGE_KWH: 224160 });
    near(f('Average').BGE_HRS as number, 16.86, 2);
    near(f('Average').BGE_KWH as number, 10674.29, 2);
    expect(f('Maximum')).toMatchObject({ BGE_HRS: 21, BGE_KWH: 12600 });
    expect(f('Minimum')).toMatchObject({ BGE_HRS: 14, BGE_KWH: 9600 });
  });
  it('custom range 01-Nov-2024 … 21-Sep-2026', () => {
    const t = rpt.custom(bundle, '2024-11-01', D, ['INFLOW', 'EB_KWH', 'DG_KWH', 'OUT_PH', 'OUT_FC']);
    const v = (item: string) => t.rows.find((r) => String(r.item).startsWith(item))!.value as number;
    expect(v('Inflow')).toBe(86664);
    expect(v('EB power')).toBe(13046190);
    expect(v('DG power')).toBe(766350);
    near(v('Outlet pH'), 7.378, 2);
    near(v('Outlet FC'), 85.394, 2);
  });
});
