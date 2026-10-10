import { addMonths, monthEnd, monthStart, maxDate, minDate } from '../../../lib/dates';
import { dayValue } from './derive';
import { eachDay } from './periods';
import { buildMis, type Bundle, type MisReport, type ParamRowOut } from './mis';
import type { Flag, ISODate, ParamDef } from './types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
type Colour = 'blue' | 'red' | 'grey';

/** D9 fix: badge colour by direction. */
export function badge(p: number | null, direction: string): { pct: number | null; arrow: 'up' | 'down' | null; colour: Colour } {
  if (p === null || p === 0) return { pct: p, arrow: null, colour: 'grey' };
  const up = p > 0;
  const colour: Colour = direction === 'higher_better' ? (up ? 'blue' : 'red') : direction === 'lower_better' ? (up ? 'red' : 'blue') : 'grey';
  return { pct: p, arrow: up ? 'up' : 'down', colour };
}

/** Last 5 completed months before D's month (§13.13). Days before the MIS start are ignored. */
export function chartMonths(d: ISODate): ISODate[] {
  return [5, 4, 3, 2, 1].map((k) => monthStart(addMonths(monthStart(d), -k)));
}
export function monthSeries(b: Bundle, p: ParamDef | 'REVENUE', metric: 'avg_per_day' | 'monthly_total', months: ISODate[]) {
  return months.map((m) => {
    const period = { from: maxDate(m, b.settings.plant.misStart), to: minDate(monthEnd(m), b.settings.plant.omEnd), days: 0 };
    if (period.from > period.to) return null;
    if (p === 'REVENUE') {
      let sum = 0;
      for (const d of eachDay(period)) sum += b.derived.get(d)?.revAct ?? 0;
      return sum / 1e6;
    }
    const vals: number[] = [];
    for (const d of eachDay(period)) {
      const v = dayValue(b.data, b.derived, p.code, d);
      if (v !== null) vals.push(v);
    }
    if (vals.length === 0) return null; // "No data"
    const sum = vals.reduce((a, x) => a + x, 0);
    return metric === 'monthly_total' ? sum : sum / vals.length;
  });
}

export function buildDashboard(b: Bundle, d: ISODate, mis: MisReport = buildMis(b, d)) {
  const s = b.settings;
  const months = chartMonths(d);
  const labels = months.map((m) => `${MONTHS[Number(m.slice(5, 7)) - 1]}-${m.slice(2, 4)}`);
  const rows = new Map<string, ParamRowOut>([...mis.keyParameters, ...mis.chemicals].map((r) => [r.code, r]));
  const sumCard = (code: string, title: string, unit: string, chartType: string, metric: 'avg_per_day' | 'monthly_total', p: ParamDef | 'REVENUE', section: string) => {
    const r = rows.get(code);
    if (!r) return null;
    return {
      code, title, unit, section, bigNumber: r.today.act,
      mtd: { value: r.mtd.act, ...badge(r.mtdPct, r.direction) },
      utd: { value: r.utd.act, ...badge(r.utdResult.pct, r.direction) },
      events: { mtd: r.events.mtd, utd: r.events.utd, flag: r.events.flag },
      chart: {
        type: chartType, title: `${metric === 'avg_per_day' ? 'AVG' : 'MONTHLY'} ${title.toUpperCase()} – LAST 5 MONTHS`,
        months: labels, values: monthSeries(b, p, metric, months),
      },
    };
  };
  const cards = s.params.filter((p) => p.dashboardCard && p.group !== 'lab_outlet' && p.group !== 'lab_inlet' && p.linkRole !== 'expense')
    .sort((a, x) => a.dashboardOrder - x.dashboardOrder)
    .map((p) => {
      const item = s.stock.find((i) => i.consumedCode === p.code);
      return sumCard(p.code, item?.name ?? p.shortName ?? p.name, p.unit, p.chartType, (p.chartMetric ?? 'avg_per_day') as 'avg_per_day',
        p, item ? 'chemicals' : 'key');
    }).filter((c) => c !== null);
  const revenueCard = sumCard('REVENUE', 'Revenue', '₹ million', 'bar', 'monthly_total', 'REVENUE', 'key');
  const keyCards = [...cards.filter((c) => c!.section === 'key'), ...(revenueCard ? [revenueCard] : [])];
  const labCards = mis.lab.outlet.map((l) => {
    const p = s.params.find((x) => x.code === l.code)!;
    return {
      code: l.code, title: l.name, unit: l.unit, bigNumber: l.act, min: l.min, max: l.max, result: l.result,
      resultFlag: l.resultFlag, events: l.events,
      chart: { type: 'cone', title: `AVG ${l.name.toUpperCase()} – LAST 5 MONTHS`, months: labels, values: monthSeries(b, p, 'avg_per_day', months) },
    };
  });
  const expenseP = s.params.find((p) => p.linkRole === 'expense');
  return {
    header: {
      title: s.display.dashboardTitle, subtitle: 'O&M MIS DASHBOARD | PLANT OPERATION & MAINTENANCE', tagline: s.display.tagline,
      reportDate: d, reportMonth: new Date(`${d}T00:00:00Z`).toLocaleString('en-IN', { month: 'long', timeZone: 'UTC' }),
      plantName: s.plant.name, companyName: s.display.companyName, logsheet: mis.header.logsheet,
    },
    keyParameters: keyCards,
    chemicals: cards.filter((c) => c!.section === 'chemicals'),
    quality: labCards,
    registers: mis.registers,
    staff: mis.staff.rows.map((r) => ({ category: r.category, present: r.present, absent: r.absent, absentFlag: r.absentFlag })),
    cash: {
      today: mis.cash.today, mtd: mis.cash.mtd, utd: mis.cash.utd, inHand: mis.cash.inHand,
      chart: expenseP ? { type: 'line', title: 'MONTHLY SITE CASH EXPENSES – LAST 5 MONTHS', months: labels,
        values: monthSeries(b, expenseP, 'monthly_total', months) } : null,
    },
    flags: { verified: mis.header.logsheet?.status === 'verified' } as Record<string, boolean | Flag>,
  };
}
export type Dashboard = ReturnType<typeof buildDashboard>;
