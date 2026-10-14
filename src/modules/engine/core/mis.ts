import { addDays, addMonths } from '../../../lib/dates';
import { EXPIRING_ALERT_DAYS } from '../../../config/constants';
import type { MonitoringTab, ResultMode, StandardKind } from '../../../shared/enums';
import { standardAt, valueAt } from './effective';
import { dayValue } from './derive';
import { buildMaintenanceTab, type MaintenanceTab } from './maintenance';
import { eachDay, periodsFor, type Period, type Periods } from './periods';
import { actual, dataDays, events, flagFor, pct, resultText, standard, triple, type Triple } from './stats';
import type { DerivedMap, EngineData, EngineSettings, Flag, ISODate, ParamDef, RegisterDef } from './types';

export interface ResultLine { qty: number | null; pct: number | null; text: string | null; flag: Flag }
/** v1.1 (C2): one kind's (Bidding or Actual) full set of results for a parameter. */
export interface PerKind {
  today: Triple; mtd: Triple; utd: Triple;
  events: { mtd: number; utd: number; flag: Flag };
  results: { today: ResultLine; mtd: ResultLine; utd: ResultLine };
}
export interface ParamRowOut {
  code: string; name: string; unit: string; decimals: number; direction: string;
  today: Triple; mtd: Triple; utd: Triple;
  avgPerDay: { mtd: number | null; utd: number | null };
  events: { mtd: number; utd: number; flag: Flag };
  utdResult: { pct: number | null; text: string | null; flag: Flag };
  mtdPct: number | null;
  // --- v1.1 additions (additive only — the fields above never change shape or meaning) ---
  monitoringTab: MonitoringTab;
  resultDisplay: ResultMode;
  standards: { bidding: PerKind; actual: PerKind };
  primaryKind: StandardKind;
}
export interface Bundle { settings: EngineSettings; data: EngineData; derived: DerivedMap }

function avgPerDay(b: Bundle, act: number | null, period: Period): number | null {
  if (act === null) return null;
  const days = b.settings.avgDivisor === 'data_days' ? dataDays(b.data, period) : period.days;
  return days > 0 ? act / days : null;
}

const mkResult = (t: Triple, resultNoun: string | null, direction: ParamDef['direction']): ResultLine => {
  const p = pct(t.var, t.std);
  return { qty: t.var, pct: p, text: resultText(p, resultNoun), flag: flagFor(direction, t.var) };
};

function perKind(b: Bundle, p: ParamDef, per: Periods, kind: StandardKind): PerKind {
  const s = b.settings;
  const today = triple(
    standard(s, p, per.today, 'today', per, kind),
    b.data.days.has(per.reportDate) ? actual(b.data, b.derived, p, per.today) : null,
    p.direction,
  );
  const mtd = triple(standard(s, p, per.mtd, 'mtd', per, kind), actual(b.data, b.derived, p, per.mtd), p.direction);
  const utd = triple(standard(s, p, per.utd, 'utd', per, kind), actual(b.data, b.derived, p, per.utd), p.direction);
  const ev = { mtd: events(s, b.data, b.derived, p, per.mtd, kind), utd: events(s, b.data, b.derived, p, per.utd, kind) };
  return {
    today, mtd, utd,
    events: { ...ev, flag: ev.mtd + ev.utd > 0 ? 'bad' : 'ok' },
    results: { today: mkResult(today, p.resultNoun, p.direction), mtd: mkResult(mtd, p.resultNoun, p.direction), utd: mkResult(utd, p.resultNoun, p.direction) },
  };
}
/** Resolves PAR-19: a parameter's own override, 'none' meaning "inherit the plant default". */
function resolveResultDisplay(p: ParamDef, s: EngineSettings): ResultMode {
  if (p.resultDisplayOverride && p.resultDisplayOverride !== 'none') return p.resultDisplayOverride;
  return s.resultsDisplay;
}

export function paramRow(b: Bundle, p: ParamDef, per: Periods): ParamRowOut {
  const s = b.settings;
  const bidding = perKind(b, p, per, 'bidding');
  const act = perKind(b, p, per, 'actual');
  const primary = s.primaryStandard === 'bidding' ? bidding : act;
  return {
    code: p.code, name: p.shortName ?? p.name, unit: p.unit, decimals: p.decimals, direction: p.direction,
    today: primary.today, mtd: primary.mtd, utd: primary.utd,
    avgPerDay: p.aggregation === 'sum'
      ? { mtd: avgPerDay(b, primary.mtd.act, per.mtd), utd: avgPerDay(b, primary.utd.act, per.utd) }
      : { mtd: primary.mtd.act, utd: primary.utd.act },
    events: primary.events,
    utdResult: { pct: primary.results.utd.pct, text: primary.results.utd.text, flag: primary.results.utd.flag },
    mtdPct: primary.results.mtd.pct,
    monitoringTab: p.monitoringTab, resultDisplay: resolveResultDisplay(p, s),
    standards: { bidding, actual: act }, primaryKind: s.primaryStandard,
  };
}

/** Revenue row in ₹ million (§13.10). Events = days with a logsheet where ACT_REV < STD_REV (fix D10). */
export function revenueRow(b: Bundle, per: Periods): ParamRowOut {
  const s = b.settings;
  const sum = (p: Period, k: 'revStd' | 'revStdActual' | 'revAct') => {
    let x = 0;
    for (const d of eachDay(p)) x += b.derived.get(d)?.[k] ?? 0;
    return x / 1e6;
  };
  const stdKey = (kind: StandardKind): 'revStd' | 'revStdActual' => (kind === 'bidding' ? 'revStd' : 'revStdActual');
  const ev = (p: Period, kind: StandardKind) => {
    let n = 0;
    for (const d of eachDay(p)) {
      const dd = b.derived.get(d);
      if (dd?.hasData && dd.revAct < (kind === 'bidding' ? dd.revStd : dd.revStdActual)) n++;
    }
    return n;
  };
  const mkKind = (kind: StandardKind): PerKind => {
    const mk = (p: Period) => triple(sum(p, stdKey(kind)), sum(p, 'revAct'), 'higher_better');
    const today = mk(per.today);
    const mtd = mk(per.mtd);
    const utd = mk(per.utd);
    const e = { mtd: ev(per.mtd, kind), utd: ev(per.utd, kind) };
    return {
      today, mtd, utd, events: { ...e, flag: e.mtd + e.utd > 0 ? 'bad' : 'ok' },
      results: { today: mkResult(today, 'REVENUE GENERATED', 'higher_better'), mtd: mkResult(mtd, 'REVENUE GENERATED', 'higher_better'),
        utd: mkResult(utd, 'REVENUE GENERATED', 'higher_better') },
    };
  };
  const bidding = mkKind('bidding');
  const act = mkKind('actual');
  const primary = s.primaryStandard === 'bidding' ? bidding : act;
  return {
    code: 'REVENUE', name: 'O&M revenue', unit: '₹ million', decimals: 2, direction: 'higher_better',
    today: primary.today, mtd: primary.mtd, utd: primary.utd,
    avgPerDay: { mtd: primary.mtd.act === null ? null : primary.mtd.act / per.mtd.days, utd: primary.utd.act === null ? null : primary.utd.act / per.utd.days },
    events: primary.events,
    utdResult: { pct: primary.results.utd.pct, text: primary.results.utd.text, flag: primary.results.utd.flag },
    mtdPct: primary.results.mtd.pct,
    monitoringTab: 'key', resultDisplay: s.resultsDisplay,
    standards: { bidding, actual: act }, primaryKind: s.primaryStandard,
  };
}

export type RegisterStatus = 'VALID' | 'EXPIRING' | 'EXPIRED' | 'NOT_AVAILABLE';
/** BG-02/04: the record valid on D, else the most recent earlier one; status uses the report date. */
export function registerOn(rows: RegisterDef[], d: ISODate) {
  const valid = rows.filter((r) => r.start <= d && r.end >= d).sort((a, b) => (a.end < b.end ? 1 : -1))[0];
  const earlier = rows.filter((r) => r.start <= d).sort((a, b) => (a.end < b.end ? 1 : -1))[0];
  const r = valid ?? earlier;
  if (!r) return { record: null, status: 'NOT_AVAILABLE' as RegisterStatus, claimUpTo: null };
  const status: RegisterStatus = d > r.end ? 'EXPIRED' : d > addDays(r.end, -EXPIRING_ALERT_DAYS) ? 'EXPIRING' : 'VALID';
  const claimUpTo = r.kind === 'bg' && r.claimMonths !== null ? addDays(addMonths(r.end, r.claimMonths), -1) : null;
  return { record: r, status, claimUpTo };
}

export function buildMis(b: Bundle, d: ISODate, meta: { lastCorrectedAt?: string | null; generatedAt?: string } = {}) {
  const s = b.settings;
  const per = periodsFor(d, s.plant.misStart, s.plant.omStart);
  const active = s.params.filter((p) => (!p.activeTo || p.activeTo >= per.mtd.from));
  const rec = b.data.days.get(d);
  const dd = b.derived.get(d);
  const year = s.contractYears.find((y) => d >= y.start && d <= y.end);

  const keyParameters = [
    ...active.filter((p) => p.misSection === 'key').sort((a, x) => a.misOrder - x.misOrder).map((p) => paramRow(b, p, per)),
    revenueRow(b, per),
  ];
  const chemicals = s.stock.filter((i) => i.active).map((i) => {
    const p = s.params.find((x) => x.code === i.consumedCode)!;
    const row = paramRow(b, p, per);
    const balance = dd?.stock[i.code] ?? null;
    const balanceFlag: Flag = balance !== null && (balance < 0 || (i.minLevel !== null && balance < i.minLevel)) ? 'bad' : 'ok';
    return { ...row, name: i.name, unit: i.unit, received: rec ? dayValue(b.data, b.derived, i.receivedCode, d) ?? 0 : 0, balance, balanceFlag };
  });
  const lab = (section: 'lab_inlet' | 'lab_outlet') =>
    active.filter((p) => p.misSection === section || p.group === section).sort((a, x) => a.misOrder - x.misOrder).map((p) => {
      const st = standardAt(p, d, s.primaryStandard);
      const act = rec ? dayValue(b.data, b.derived, p.code, d) : null;
      const exceeded = act !== null && ((st?.min != null && act < st.min) || (st?.max != null && act > st.max));
      const ev = { mtd: events(s, b.data, b.derived, p, per.mtd, s.primaryStandard), utd: events(s, b.data, b.derived, p, per.utd, s.primaryStandard) };
      return {
        code: p.code, name: p.shortName ?? p.name, unit: p.unit, decimals: p.decimals, min: st?.min ?? null, max: st?.max ?? null,
        act, result: act === null ? null : exceeded ? 'EXCEEDED LIMIT' : 'WITHIN LIMIT', resultFlag: (exceeded ? 'bad' : 'ok') as Flag,
        avg: { mtd: actual(b.data, b.derived, p, per.mtd), utd: actual(b.data, b.derived, p, per.utd) },
        events: { ...ev, flag: (ev.mtd + ev.utd > 0 ? 'bad' : 'ok') as Flag },
      };
    });
  const regRows = (kind: 'bg' | 'insurance') => {
    const labels = [...new Set([...(kind === 'insurance' ? ['WC', 'FIRE', 'IAR'] : []),
      ...s.registers.filter((r) => r.kind === kind).map((r) => r.label)])];
    return labels.map((label) => {
      const x = registerOn(s.registers.filter((r) => r.kind === kind && r.label === label), d);
      return { label, ...x.record, claimUpTo: x.claimUpTo, status: x.status,
        statusFlag: (x.status === 'VALID' ? 'ok' : x.status === 'EXPIRING' ? 'neutral' : 'bad') as Flag };
    });
  };
  const expenseP = s.params.find((p) => p.linkRole === 'expense');
  const receivedP = s.params.find((p) => p.linkRole === 'cash_received');
  const descP = s.params.find((p) => p.linkRole === 'description');
  const sumOf = (p: ParamDef | undefined, period: Period) => (p ? actual(b.data, b.derived, p, period) ?? 0 : 0);
  const staff = s.staff.map((c) => {
    const contract = valueAt(c.strengths, d) ?? 0;
    const g = (code: string) => (rec ? dayValue(b.data, b.derived, code, d) ?? 0 : null);
    const absent = rec ? dd?.absent[c.code] ?? null : null;
    return { category: c.name, contract, vacant: g(c.vacantCode), present: g(c.presentCode), leave: g(c.leaveCode), absent,
      absentFlag: (absent !== null && absent > 0 ? 'bad' : 'ok') as Flag };
  });
  const safety = s.safety.map((i) => {
    const required = valueAt(i.required, d) ?? 0;
    const act = rec ? dayValue(b.data, b.derived, i.availableCode, d) : null;
    const deficit = act === null ? null : required - act;
    return { item: i.name, required, actual: act, deficit, deficitFlag: (deficit !== null && deficit > 0 ? 'bad' : 'ok') as Flag };
  });
  const tot = <T extends Record<string, unknown>>(rows: T[], keys: (keyof T)[]) =>
    Object.fromEntries(keys.map((k) => [k, rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)]));

  const labTab = { inlet: lab('lab_inlet'), outlet: lab('lab_outlet') };
  const registersTab = { bankGuarantees: regRows('bg'), insurance: regRows('insurance') };
  const cashTab = {
    today: rec ? sumOf(expenseP, per.today) : null, mtd: sumOf(expenseP, per.mtd), utd: sumOf(expenseP, per.utd),
    received: rec ? sumOf(receivedP, per.today) : null, inHand: dd?.cash ?? null,
    description: rec && descP ? (rec.values[descP.code] as string | null) ?? null : null,
    alertLimit: s.cash.alertLimit,
  };
  const staffTab = { rows: staff, total: tot(staff, ['contract', 'vacant', 'present', 'leave', 'absent']) };
  const safetyTab = { rows: safety, total: tot(safety, ['required', 'actual', 'deficit']) };
  const maintenanceTab: MaintenanceTab | null = s.maintenance.enabled
    ? buildMaintenanceTab(s.maintenance, per.today, per.mtd, per.utd)
    : null;

  return {
    header: {
      companyName: s.display.companyName, plantName: s.plant.name, clientName: s.display.clientName,
      misStart: s.plant.misStart, omStart: s.plant.omStart, omEnd: s.plant.omEnd, tenureMonths: s.plant.tenureMonths,
      omMonthNo: per.omMonthNo, omYearNo: year ? String(year.yearNo).padStart(2, '0') : null, reportDate: d,
      mtdDays: per.mtd.days, utdDays: per.utd.days, mtdDataDays: dataDays(b.data, per.mtd), utdDataDays: dataDays(b.data, per.utd),
      monthsElapsed: per.monthsElapsed, lastCorrectedAt: meta.lastCorrectedAt ?? rec?.correctedAt ?? null,
      logsheet: rec ? { status: rec.status, version: rec.version, submittedBy: rec.submittedByName, submittedAt: rec.submittedAt } : null,
      // v1.1 (SET-09..12)
      primaryStandard: s.primaryStandard, standardsShown: s.standardsShown, resultsDisplay: s.resultsDisplay, tabLabels: s.tabLabels,
    },
    // v1.1 (C5): the same rows above, grouped into the five monitoring tabs.
    tabs: {
      key: keyParameters,
      chemicals,
      compliance: { lab: labTab, registers: registersTab },
      administrative: { cash: cashTab, staff: staffTab, safety: safetyTab },
      maintenance: maintenanceTab,
    },
    keyParameters,
    chemicals,
    lab: labTab,
    registers: registersTab,
    cash: cashTab,
    staff: staffTab,
    safety: safetyTab,
    revenueDay: dd ? { fixedPerDay: dd.revFp, std: dd.revStd, act: dd.revAct, stdActual: dd.revStdActual } : null,
    meta: { generatedAt: meta.generatedAt ?? new Date().toISOString() },
  };
}
export type MisReport = ReturnType<typeof buildMis>;
