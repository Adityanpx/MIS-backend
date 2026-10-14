import { todayIST } from '../../lib/dates';
import type { ClientCtx } from '../../types/express';
import type { StandardKind } from '../../shared/enums';
import type { MisReport } from '../engine/core/mis';
import { getBundle, type VersionedBundle } from '../engine/engine.service';
import { buildMis } from '../engine/core/mis';
import { listPlants } from '../plants/plants.service';

const CONCURRENCY = 10;

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface PortfolioException { plantId: string; plantName: string; type: string; detail: string }
export interface PortfolioRow {
  plantId: string; name: string; type: string; capacityMld: number; accountState: string; setupStatus: string;
  logsheetStatus: 'submitted' | 'corrected' | 'checked' | 'verified' | 'draft' | 'returned' | 'missing' | 'not_due' | 'not_live';
  key: { code: string | null; name: string | null; unit: string | null; today: number | null; mtd: number | null;
    resultPct: number | null; revenueMtdAct: number | null; revenueMtdStd: number | null } | null;
  chemicals: { aboveStdMtd: number; belowMin: number };
  compliance: { outletToday: 'within' | 'exceeded' | 'no_data'; outletEventsMtd: number; worstRegister: 'ok' | 'expiring' | 'expired' | 'not_available' };
  administrative: { staffAbsentToday: number | null; safetyDeficit: number; cashInHand: number | null };
  maintenance: { enabled: boolean; openBreakdowns: number; criticalOpen: number; longestOpenDays: number | null; availabilityMtd: number | null } | null;
  exceptionCount: number;
}

function buildRow(p: { id: string; name: string; type: string; capacityMld: number; accountState: string; setupStatus: string },
  mis: MisReport | null, exceptions: PortfolioException[], standard: StandardKind | 'primary'): PortfolioRow {
  const pushEx = (type: string, detail: string) => exceptions.push({ plantId: p.id, plantName: p.name, type, detail });
  if (!mis) {
    return {
      plantId: p.id, name: p.name, type: p.type, capacityMld: p.capacityMld, accountState: p.accountState, setupStatus: p.setupStatus,
      logsheetStatus: p.setupStatus === 'live' ? 'missing' : 'not_live',
      key: null, chemicals: { aboveStdMtd: 0, belowMin: 0 },
      compliance: { outletToday: 'no_data', outletEventsMtd: 0, worstRegister: 'not_available' },
      administrative: { staffAbsentToday: null, safetyDeficit: 0, cashInHand: null },
      maintenance: null, exceptionCount: 0,
    };
  }
  const first = mis.keyParameters.find((r) => r.code !== 'REVENUE') ?? null;
  const rev = mis.keyParameters.find((r) => r.code === 'REVENUE') ?? null;
  const kind: StandardKind = standard === 'primary' ? mis.header.primaryStandard : standard;
  const firstK = first?.standards[kind];
  const revK = rev?.standards[kind];
  const aboveStdMtd = mis.chemicals.filter((c) => c.events.mtd > 0).length;
  const belowMin = mis.chemicals.filter((c) => c.balanceFlag === 'bad').length;
  const outletExceededToday = mis.lab.outlet.some((l) => l.act !== null && l.resultFlag === 'bad');
  const outletHasData = mis.lab.outlet.some((l) => l.act !== null);
  const outletEventsMtd = mis.lab.outlet.reduce((a, l) => a + l.events.mtd, 0);
  const registerStatuses = [...mis.registers.bankGuarantees, ...mis.registers.insurance].map((r) => r.status);
  const worstRegister = registerStatuses.includes('EXPIRED') ? 'expired' as const
    : registerStatuses.includes('EXPIRING') ? 'expiring' as const
    : registerStatuses.every((s) => s === 'NOT_AVAILABLE') ? 'not_available' as const : 'ok' as const;
  const safetyDeficit = mis.safety.rows.reduce((a, r) => a + (r.deficit ?? 0), 0);
  const maint = mis.tabs.maintenance;

  if (!mis.header.logsheet) pushEx('MISSING_LOGSHEET', `No logsheet on ${mis.header.reportDate}`);
  if (outletExceededToday) pushEx('OUTLET_EXCEEDED', 'Outlet quality exceeded the limit today');
  if (worstRegister === 'expired') pushEx('REGISTER_EXPIRED', 'A bank guarantee or insurance policy has expired');
  else if (worstRegister === 'expiring') pushEx('REGISTER_EXPIRING', 'A bank guarantee or insurance policy expires soon');
  if (belowMin > 0) pushEx('STOCK_LOW', `${belowMin} chemical(s) below minimum stock`);
  if (mis.cash.inHand !== null && mis.cash.inHand < 0) pushEx('CASH_NEGATIVE', 'Site cash is negative');
  if (maint && maint.summary.criticalOpen > 0) pushEx('CRITICAL_BREAKDOWN', `${maint.summary.criticalOpen} critical breakdown(s) open`);

  const before = exceptions.length;
  return {
    plantId: p.id, name: p.name, type: p.type, capacityMld: p.capacityMld, accountState: p.accountState, setupStatus: p.setupStatus,
    logsheetStatus: (mis.header.logsheet?.status ?? 'missing') as PortfolioRow['logsheetStatus'],
    key: first && firstK ? {
      code: first.code, name: first.name, unit: first.unit, today: firstK.today.act, mtd: firstK.mtd.act, resultPct: firstK.results.utd.pct,
      revenueMtdAct: revK?.mtd.act ?? null, revenueMtdStd: revK?.mtd.std ?? null,
    } : null,
    chemicals: { aboveStdMtd, belowMin },
    compliance: { outletToday: !outletHasData ? 'no_data' : outletExceededToday ? 'exceeded' : 'within', outletEventsMtd, worstRegister },
    administrative: {
      staffAbsentToday: mis.header.logsheet ? mis.staff.total.absent as number : null, safetyDeficit, cashInHand: mis.cash.inHand,
    },
    maintenance: maint ? {
      enabled: true, openBreakdowns: maint.openBreakdowns.length, criticalOpen: maint.summary.criticalOpen,
      longestOpenDays: maint.metrics.utd.longestOpenDays, availabilityMtd: maint.summary.availabilityMtd,
    } : { enabled: false, openBreakdowns: 0, criticalOpen: 0, longestOpenDays: null, availabilityMtd: null },
    exceptionCount: exceptions.length - before,
  };
}

/**
 * GET /api/v1/company/portfolio (MGT-11, §16A/C3): one row per active plant, built the same way the per-plant
 * MIS is (getBundle + buildMis) — never from a separate data path — so the two views can never disagree.
 */
export async function portfolio(
  ctx: ClientCtx, date: string, standard: StandardKind | 'primary',
): Promise<{ reportDate: string; standard: StandardKind | 'primary'; rows: PortfolioRow[]; exceptions: PortfolioException[] }> {
  const plants = await listPlants(ctx);
  const exceptions: PortfolioException[] = [];
  const rows = await mapLimit(plants, CONCURRENCY, async (p) => {
    if (p.setupStatus !== 'live' || !['active', 'grace', 'read_only'].includes(p.accountState)) {
      return buildRow(p, null, exceptions, standard);
    }
    try {
      const b: VersionedBundle = await getBundle(ctx.tenantId, p.id);
      if (date < b.settings.plant.misStart) return buildRow(p, null, exceptions, standard);
      const mis = buildMis(b, date);
      return buildRow(p, mis, exceptions, standard);
    } catch {
      return buildRow(p, null, exceptions, standard);
    }
  });
  return { reportDate: date, standard, rows, exceptions };
}

/** Lets the route default to "today" without importing lib/dates itself. */
export const portfolioDefaultDate = (): string => todayIST();
