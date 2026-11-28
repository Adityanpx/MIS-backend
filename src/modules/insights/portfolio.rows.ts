import type { LOGSHEET_STATUSES, StandardKind } from '../../shared/enums';
import type { Flag } from '../engine/core/types';
import type { MisReport } from '../engine/core/mis';
import { buildAlerts, type PlantAlert } from './insights';

/**
 * Pure functions (no DB, no Express) behind the company Portfolio (MGT-11, §16A/C3):
 *  - one summary row per plant, read from the same MIS report the plant pages show, and
 *  - the system-detected issues across all plants.
 * MIS-derived issues reuse buildAlerts() (the dashboard / overview alert rules) so the screens never disagree;
 * the Portfolio adds only what a single MIS report cannot say on its own: logsheet state, breakdowns, account state.
 */

export type IssueLevel = 'critical' | 'warning';
export type IssueCategory = 'logsheet' | 'compliance' | 'chemicals' | 'admin' | 'maintenance' | 'account' | 'data';
export type IssueType =
  | 'MISSING_LOGSHEET' | 'LOGSHEET_DRAFT' | 'LOGSHEET_RETURNED'
  | 'OUTLET_EXCEEDED' | 'REGISTER_EXPIRED' | 'REGISTER_EXPIRING'
  | 'STOCK_NEGATIVE' | 'STOCK_LOW'
  | 'CASH_NEGATIVE' | 'CASH_LOW' | 'SAFETY_DEFICIT'
  | 'CRITICAL_BREAKDOWN' | 'BREAKDOWN_LONG_OPEN'
  | 'ACCOUNT_RESTRICTED' | 'DATA_UNAVAILABLE';

export interface PortfolioIssue {
  id: string;
  plantId: string; plantName: string; plantCode: string;
  level: IssueLevel; category: IssueCategory; type: IssueType;
  title: string; detail: string;
}

type LogsheetStatus = (typeof LOGSHEET_STATUSES)[number];
/** not_due: before the plant's MIS start or a future date · not_live: setup pending / closed / suspended · unavailable: MIS failed. */
export type PortfolioLogsheetStatus = LogsheetStatus | 'missing' | 'not_due' | 'not_live' | 'unavailable';
export type PlantHealth = 'critical' | 'warning' | 'ok' | 'inactive';

export interface PortfolioPlant {
  id: string; code: string; name: string; type: string; capacityMld: number; city: string | null;
  accountState: string; setupStatus: string;
}

export interface PortfolioRow {
  plantId: string; code: string; name: string; type: string; capacityMld: number; city: string | null;
  accountState: string; setupStatus: string;
  logsheetStatus: PortfolioLogsheetStatus;
  hasData: boolean;
  health: PlantHealth;
  /** The plant's first key parameter (MIS order) in the chosen standard. */
  key: {
    code: string; name: string; unit: string; decimals: number;
    today: { act: number | null; std: number | null; flag: Flag };
    mtd: { act: number | null; std: number | null; flag: Flag };
    resultPct: number | null; resultText: string | null;
  } | null;
  /** Revenue in ₹ million (the engine's unit), month to date, in the chosen standard. */
  revenue: { mtdAct: number | null; mtdStd: number | null; achievementPct: number | null } | null;
  chemicals: { tracked: number; aboveStdMtd: number; belowMin: number };
  compliance: {
    outletToday: 'within' | 'exceeded' | 'no_data'; outletFailingToday: number; outletEventsMtd: number;
    worstRegister: 'ok' | 'expiring' | 'expired' | 'not_available';
  };
  administrative: { staffAbsentToday: number | null; safetyDeficit: number; cashInHand: number | null; cashAlertLimit: number | null };
  maintenance: {
    enabled: boolean; openBreakdowns: number; criticalOpen: number; longestOpenDays: number | null; availabilityMtd: number | null;
  };
  issues: { critical: number; warning: number };
}

export interface PortfolioSummary {
  plants: number;
  live: number;
  logsheets: { expected: number; submitted: number; draft: number; returned: number; missing: number };
  issues: { critical: number; warning: number; plantsAffected: number };
  outletExceededPlants: number;
  breakdowns: { open: number; critical: number };
  /** ₹ million, summed over plants that have both figures. */
  revenueMtd: { act: number; std: number; plants: number } | null;
}

export type PlantInput =
  | { kind: 'mis'; mis: MisReport; longOpenAlertDays: number }
  | { kind: 'not_live' }
  | { kind: 'not_due' }
  | { kind: 'unavailable' };

/** Logsheet states that count as "submitted" for the day. */
export const SUBMITTED_STATES: readonly PortfolioLogsheetStatus[] = ['submitted', 'corrected', 'checked', 'verified'];
/** Account states in which the plant still reports (portfolio builds its MIS). */
export const REPORTING_ACCOUNT_STATES = ['active', 'grace', 'read_only'] as const;

const LEVEL_ORDER: Record<IssueLevel, number> = { critical: 0, warning: 1 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' → '21-Sep-2026' (the format of every MIS document). */
export const fmtIsoDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTHS[Number(m) - 1] ?? m}-${y}`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whole days a breakdown has been open at the end of report date D (IST). */
export function daysOpen(startedAt: string, d: string): number {
  const end = Date.parse(`${d}T23:59:59+05:30`);
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return 0;
  return Math.floor((end - start) / 86_400_000);
}

/** Maps a dashboard alert (critical / warning only) onto a Portfolio issue. Info-level alerts stay on the plant dashboard. */
function fromAlert(a: PlantAlert): Pick<PortfolioIssue, 'level' | 'category' | 'type' | 'title' | 'detail'> | null {
  if (a.level === 'info') return null;
  const level: IssueLevel = a.level;
  const base = { level, title: a.title, detail: a.detail };
  switch (a.kind) {
    case 'lab': return { ...base, category: 'compliance', type: 'OUTLET_EXCEEDED' };
    case 'register': return { ...base, category: 'compliance', type: level === 'critical' ? 'REGISTER_EXPIRED' : 'REGISTER_EXPIRING' };
    case 'stock': return { ...base, category: 'chemicals', type: level === 'critical' ? 'STOCK_NEGATIVE' : 'STOCK_LOW' };
    case 'cash': return { ...base, category: 'admin', type: level === 'critical' ? 'CASH_NEGATIVE' : 'CASH_LOW' };
    case 'safety': return { ...base, category: 'admin', type: 'SAFETY_DEFICIT' };
    default: return null; // staff / param / logsheet alerts are info-level or handled below
  }
}

function accountIssue(accountState: string): Pick<PortfolioIssue, 'level' | 'title' | 'detail'> | null {
  switch (accountState) {
    case 'grace': return { level: 'warning', title: 'Account in grace period', detail: 'Payment is overdue. Data entry stays open until the grace period ends.' };
    case 'read_only': return { level: 'warning', title: 'Account is read-only', detail: 'Logsheets cannot be entered until the overdue amount is paid.' };
    case 'expired': return { level: 'warning', title: 'Subscription expired', detail: 'Renew the plant subscription to continue reporting.' };
    case 'suspended': return { level: 'critical', title: 'Account suspended', detail: 'The plant is suspended. Contact your provider.' };
    default: return null;
  }
}

/**
 * One plant → its Portfolio row and its issues. `today` (IST) decides whether a missing logsheet is still pending
 * (warning) or overdue (critical).
 */
export function buildPortfolioRow(
  p: PortfolioPlant, input: PlantInput, opts: { standard: StandardKind | 'primary'; date: string; today: string },
): { row: PortfolioRow; issues: PortfolioIssue[] } {
  const issues: PortfolioIssue[] = [];
  const add = (localId: string, i: Pick<PortfolioIssue, 'level' | 'category' | 'type' | 'title' | 'detail'>) =>
    issues.push({ id: `${p.id}:${localId}`, plantId: p.id, plantName: p.name, plantCode: p.code, ...i });

  if (p.setupStatus === 'live') {
    const acc = accountIssue(p.accountState);
    if (acc) add('account', { ...acc, category: 'account', type: 'ACCOUNT_RESTRICTED' });
  }

  const base = {
    plantId: p.id, code: p.code, name: p.name, type: p.type, capacityMld: p.capacityMld, city: p.city,
    accountState: p.accountState, setupStatus: p.setupStatus,
  };
  const empty: Omit<PortfolioRow, keyof typeof base | 'logsheetStatus' | 'health' | 'issues'> = {
    hasData: false, key: null, revenue: null,
    chemicals: { tracked: 0, aboveStdMtd: 0, belowMin: 0 },
    compliance: { outletToday: 'no_data', outletFailingToday: 0, outletEventsMtd: 0, worstRegister: 'not_available' },
    administrative: { staffAbsentToday: null, safetyDeficit: 0, cashInHand: null, cashAlertLimit: null },
    maintenance: { enabled: false, openBreakdowns: 0, criticalOpen: 0, longestOpenDays: null, availabilityMtd: null },
  };

  if (input.kind !== 'mis') {
    if (input.kind === 'unavailable') {
      add('data', {
        level: 'critical', category: 'data', type: 'DATA_UNAVAILABLE', title: 'MIS could not be calculated',
        detail: 'Open the plant to check its settings and data.',
      });
    }
    const logsheetStatus: PortfolioLogsheetStatus = input.kind;
    return { row: { ...base, ...empty, logsheetStatus, health: health(p, issues, true), issues: count(issues) }, issues };
  }

  const { mis } = input;
  const d = mis.header.reportDate;
  const kind: StandardKind = opts.standard === 'primary' ? mis.header.primaryStandard : opts.standard;

  // --- logsheet ---
  const ls = mis.header.logsheet;
  if (!ls) {
    const overdue = d < opts.today;
    add('logsheet', {
      level: overdue ? 'critical' : 'warning', category: 'logsheet', type: 'MISSING_LOGSHEET',
      title: overdue ? 'Logsheet missing' : 'Logsheet not submitted yet',
      detail: `No logsheet for ${fmtIsoDate(d)}.`,
    });
  } else if (ls.status === 'draft') {
    add('logsheet', {
      level: 'warning', category: 'logsheet', type: 'LOGSHEET_DRAFT', title: 'Logsheet saved as draft',
      detail: `The ${fmtIsoDate(d)} logsheet is saved but not submitted.`,
    });
  } else if (ls.status === 'returned') {
    add('logsheet', {
      level: 'warning', category: 'logsheet', type: 'LOGSHEET_RETURNED', title: 'Logsheet returned for correction',
      detail: `The ${fmtIsoDate(d)} logsheet was sent back and needs resubmitting.`,
    });
  }

  // --- MIS flags (same rules as the plant dashboard) ---
  for (const a of buildAlerts(mis)) {
    const i = fromAlert(a);
    if (i) add(a.id, i);
  }

  // --- maintenance ---
  const maint = mis.tabs.maintenance;
  if (maint) {
    const critical = maint.openBreakdowns.filter((b) => b.criticality === 'critical');
    if (critical.length > 0) {
      add('breakdown:critical', {
        level: 'critical', category: 'maintenance', type: 'CRITICAL_BREAKDOWN',
        title: `${plural(critical.length, 'critical breakdown')} open`,
        detail: critical.map((b) => `${b.equipmentName} (${plural(daysOpen(b.startedAt, d), 'day')})`).join(', '),
      });
    }
    const limit = input.longOpenAlertDays;
    const long = maint.openBreakdowns.filter((b) => b.criticality !== 'critical' && daysOpen(b.startedAt, d) > limit);
    if (long.length > 0) {
      add('breakdown:long', {
        level: 'warning', category: 'maintenance', type: 'BREAKDOWN_LONG_OPEN',
        title: `${plural(long.length, 'breakdown')} open over ${plural(limit, 'day')}`,
        detail: long.map((b) => `${b.equipmentName} (${plural(daysOpen(b.startedAt, d), 'day')})`).join(', '),
      });
    }
  }

  // --- row figures ---
  const first = mis.keyParameters.find((r) => r.code !== 'REVENUE') ?? null;
  const rev = mis.keyParameters.find((r) => r.code === 'REVENUE') ?? null;
  const fk = first?.standards[kind];
  const rk = rev?.standards[kind];
  const outletWithData = mis.lab.outlet.filter((l) => l.act !== null);
  const outletFailingToday = outletWithData.filter((l) => l.resultFlag === 'bad').length;
  const registerStatuses = [...mis.registers.bankGuarantees, ...mis.registers.insurance].map((r) => r.status);
  const worstRegister = registerStatuses.includes('EXPIRED') ? 'expired' as const
    : registerStatuses.includes('EXPIRING') ? 'expiring' as const
    : registerStatuses.every((s) => s === 'NOT_AVAILABLE') ? 'not_available' as const : 'ok' as const;
  const revAct = rk?.mtd.act ?? null;
  const revStd = rk?.mtd.std ?? null;

  const row: PortfolioRow = {
    ...base,
    logsheetStatus: ls ? ls.status as LogsheetStatus : 'missing',
    hasData: true,
    health: 'ok',
    key: first && fk ? {
      code: first.code, name: first.name, unit: first.unit, decimals: first.decimals,
      today: { act: fk.today.act, std: fk.today.std, flag: fk.today.varFlag },
      mtd: { act: fk.mtd.act, std: fk.mtd.std, flag: fk.mtd.varFlag },
      resultPct: fk.results.mtd.pct, resultText: fk.results.mtd.text,
    } : null,
    revenue: rk ? {
      mtdAct: revAct, mtdStd: revStd,
      achievementPct: revAct !== null && revStd !== null && revStd !== 0 ? (revAct / revStd) * 100 : null,
    } : null,
    chemicals: {
      tracked: mis.chemicals.length,
      aboveStdMtd: mis.chemicals.filter((c) => c.events.mtd > 0).length,
      belowMin: mis.chemicals.filter((c) => c.balanceFlag === 'bad').length,
    },
    compliance: {
      outletToday: outletWithData.length === 0 ? 'no_data' : outletFailingToday > 0 ? 'exceeded' : 'within',
      outletFailingToday,
      outletEventsMtd: mis.lab.outlet.reduce((a, l) => a + l.events.mtd, 0),
      worstRegister,
    },
    administrative: {
      staffAbsentToday: ls ? Number(mis.staff.total.absent) || 0 : null,
      safetyDeficit: mis.safety.rows.reduce((a, r) => a + Math.max(0, r.deficit ?? 0), 0),
      cashInHand: mis.cash.inHand,
      cashAlertLimit: mis.cash.alertLimit,
    },
    maintenance: maint ? {
      enabled: true, openBreakdowns: maint.openBreakdowns.length, criticalOpen: maint.summary.criticalOpen,
      longestOpenDays: maint.metrics.utd.longestOpenDays, availabilityMtd: maint.summary.availabilityMtd,
    } : empty.maintenance,
    issues: count(issues),
  };
  row.health = health(p, issues, false);
  return { row, issues };
}

function count(issues: PortfolioIssue[]) {
  return {
    critical: issues.filter((i) => i.level === 'critical').length,
    warning: issues.filter((i) => i.level === 'warning').length,
  };
}

function health(p: PortfolioPlant, issues: PortfolioIssue[], notLive: boolean): PlantHealth {
  if (issues.some((i) => i.level === 'critical')) return 'critical';
  if (notLive || p.setupStatus !== 'live') return 'inactive';
  if (issues.length > 0) return 'warning';
  return 'ok';
}

/** Critical first, then by plant name, keeping each plant's own order. */
export function sortIssues(issues: PortfolioIssue[]): PortfolioIssue[] {
  return issues
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => LEVEL_ORDER[a.i.level] - LEVEL_ORDER[b.i.level]
      || a.i.plantName.localeCompare(b.i.plantName) || a.idx - b.idx)
    .map((x) => x.i);
}

export function summarize(rows: PortfolioRow[], issues: PortfolioIssue[]): PortfolioSummary {
  const expected = rows.filter((r) => !['not_due', 'not_live', 'unavailable'].includes(r.logsheetStatus));
  const revRows = rows.filter((r) => r.revenue?.mtdAct != null && r.revenue.mtdStd != null);
  return {
    plants: rows.length,
    live: rows.filter((r) => r.setupStatus === 'live').length,
    logsheets: {
      expected: expected.length,
      submitted: expected.filter((r) => SUBMITTED_STATES.includes(r.logsheetStatus)).length,
      draft: expected.filter((r) => r.logsheetStatus === 'draft').length,
      returned: expected.filter((r) => r.logsheetStatus === 'returned').length,
      missing: expected.filter((r) => r.logsheetStatus === 'missing').length,
    },
    issues: {
      critical: issues.filter((i) => i.level === 'critical').length,
      warning: issues.filter((i) => i.level === 'warning').length,
      plantsAffected: new Set(issues.map((i) => i.plantId)).size,
    },
    outletExceededPlants: rows.filter((r) => r.compliance.outletToday === 'exceeded').length,
    breakdowns: {
      open: rows.reduce((a, r) => a + r.maintenance.openBreakdowns, 0),
      critical: rows.reduce((a, r) => a + r.maintenance.criticalOpen, 0),
    },
    revenueMtd: revRows.length === 0 ? null : {
      act: revRows.reduce((a, r) => a + (r.revenue!.mtdAct as number), 0),
      std: revRows.reduce((a, r) => a + (r.revenue!.mtdStd as number), 0),
      plants: revRows.length,
    },
  };
}
