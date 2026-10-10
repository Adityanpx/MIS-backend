import type { MisReport } from '../engine/core/mis';

/**
 * Pure functions (no DB, no Express) that turn an MIS report into
 *  - the "Today's alerts" list shown on the dashboard and on the company overview cards, and
 *  - a small summary (outlet compliance %, data days) used by the gauge widgets.
 * Every alert is derived from flags the engine already computed — no second set of rules.
 */
export type AlertLevel = 'critical' | 'warning' | 'info';
export type AlertKind = 'lab' | 'stock' | 'register' | 'cash' | 'staff' | 'safety' | 'param' | 'logsheet';

export interface PlantAlert {
  id: string;
  level: AlertLevel;
  kind: AlertKind;
  title: string;
  detail: string;
  /** parameter / stock item / register label the alert is about (frontend deep links) */
  code: string | null;
}

export interface DashboardSummary {
  compliance: {
    mtdPct: number | null; utdPct: number | null;
    exceedancesMtd: number; exceedancesUtd: number; testsMtd: number; testsUtd: number;
    failingToday: number; parameters: number;
  };
  dataDays: { mtd: number; mtdDays: number; utd: number; utdDays: number };
  omMonthNo: number;
  omYearNo: string | null;
}

const LEVEL_ORDER: Record<AlertLevel, number> = { critical: 0, warning: 1, info: 2 };

const n = (v: number | null | undefined, decimals = 2): string =>
  v === null || v === undefined ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: decimals });

export function buildAlerts(mis: MisReport): PlantAlert[] {
  const out: PlantAlert[] = [];
  const d = mis.header.reportDate;

  for (const l of mis.lab.outlet) {
    if (l.act === null || l.resultFlag !== 'bad') continue;
    const limit = [l.min !== null ? `≥ ${n(l.min)}` : null, l.max !== null ? `≤ ${n(l.max)}` : null].filter(Boolean).join(' and ');
    out.push({
      id: `lab:${l.code}`, level: 'critical', kind: 'lab', code: l.code,
      title: `${l.name} exceeded the limit`,
      detail: `${n(l.act, l.decimals)} ${l.unit} on ${d} (limit ${limit || '—'}).`,
    });
  }
  for (const c of mis.chemicals) {
    if (c.balance === null || c.balanceFlag !== 'bad') continue;
    out.push({
      id: `stock:${c.code}`, level: c.balance < 0 ? 'critical' : 'warning', kind: 'stock', code: c.code,
      title: c.balance < 0 ? `${c.name} stock is negative` : `${c.name} stock is low`,
      detail: `Closing balance ${n(c.balance)} ${c.unit}.`,
    });
  }
  for (const [group, rows] of [['Bank guarantee', mis.registers.bankGuarantees], ['Insurance', mis.registers.insurance]] as const) {
    for (const r of rows) {
      if (r.status !== 'EXPIRED' && r.status !== 'EXPIRING') continue;
      const end = 'end' in r ? (r.end as string | undefined) : undefined;
      out.push({
        id: `register:${group}:${r.label}`, level: r.status === 'EXPIRED' ? 'critical' : 'warning', kind: 'register', code: r.label,
        title: `${group} ${r.label} ${r.status === 'EXPIRED' ? 'has expired' : 'expires soon'}`,
        detail: end ? `Valid until ${end}.` : 'Check the register.',
      });
    }
  }
  const cash = mis.cash;
  if (cash.inHand !== null && (cash.inHand < 0 || (cash.alertLimit !== null && cash.inHand < cash.alertLimit))) {
    out.push({
      id: 'cash:low', level: cash.inHand < 0 ? 'critical' : 'warning', kind: 'cash', code: null,
      title: cash.inHand < 0 ? 'Site cash is negative' : 'Site cash is below the alert limit',
      detail: `Cash in hand ₹${n(cash.inHand, 0)}${cash.alertLimit !== null ? ` (limit ₹${n(cash.alertLimit, 0)})` : ''}.`,
    });
  }
  for (const s of mis.safety.rows) {
    if (s.deficit === null || s.deficitFlag !== 'bad') continue;
    out.push({
      id: `safety:${s.item}`, level: 'warning', kind: 'safety', code: null,
      title: `${s.item}: ${n(s.deficit, 0)} short`,
      detail: `${n(s.actual, 0)} available of ${n(s.required, 0)} required.`,
    });
  }
  for (const s of mis.staff.rows) {
    if (s.absent === null || s.absentFlag !== 'bad') continue;
    out.push({
      id: `staff:${s.category}`, level: 'info', kind: 'staff', code: null,
      title: `${n(s.absent, 0)} absent · ${s.category}`,
      detail: `${n(s.present, 0)} present of ${n(s.contract, 0)} on contract.`,
    });
  }
  for (const p of mis.keyParameters) {
    if (p.code === 'REVENUE' || p.today.act === null || p.today.varFlag !== 'bad') continue;
    out.push({
      id: `param:${p.code}`, level: 'info', kind: 'param', code: p.code,
      title: `${p.name} off standard today`,
      detail: `${n(p.today.act, p.decimals)} ${p.unit} against ${n(p.today.std, p.decimals)} (variance ${n(p.today.var, p.decimals)}).`,
    });
  }
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/** Outlet compliance = 1 − exceedances / tests, where tests = outlet parameters × days with a logsheet. */
export function buildSummary(mis: MisReport): DashboardSummary {
  const h = mis.header;
  const outlet = mis.lab.outlet;
  const testsMtd = outlet.length * h.mtdDataDays;
  const testsUtd = outlet.length * h.utdDataDays;
  const exceedancesMtd = outlet.reduce((s, l) => s + l.events.mtd, 0);
  const exceedancesUtd = outlet.reduce((s, l) => s + l.events.utd, 0);
  const pct = (exc: number, tests: number) => (tests > 0 ? Math.max(0, (1 - exc / tests) * 100) : null);
  return {
    compliance: {
      mtdPct: pct(exceedancesMtd, testsMtd), utdPct: pct(exceedancesUtd, testsUtd),
      exceedancesMtd, exceedancesUtd, testsMtd, testsUtd,
      failingToday: outlet.filter((l) => l.act !== null && l.resultFlag === 'bad').length,
      parameters: outlet.length,
    },
    dataDays: { mtd: h.mtdDataDays, mtdDays: h.mtdDays, utd: h.utdDataDays, utdDays: h.utdDays },
    omMonthNo: h.omMonthNo,
    omYearNo: h.omYearNo,
  };
}
