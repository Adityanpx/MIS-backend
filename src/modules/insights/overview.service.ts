import { many } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { tenantTx } from '../../lib/context';
import { addDays, daysInclusive, maxDate, minDate, todayIST } from '../../lib/dates';
import type { ClientCtx } from '../../types/express';
import { badge } from '../engine/core/dashboard';
import { dayValue } from '../engine/core/derive';
import { buildMis } from '../engine/core/mis';
import { getBundle, latestDate } from '../engine/engine.service';
import { listPlants } from '../plants/plants.service';
import { buildAlerts, buildSummary, type PlantAlert } from './insights';

/** Upper bound of plants evaluated per request (each one runs the engine; results are cached per data version). */
const MAX_PLANTS = 50;
const CONCURRENCY = 4;
const SPARK_DAYS = 14;

type ExpectedStatus = 'submitted' | 'corrected' | 'checked' | 'verified' | 'returned' | 'draft' | 'missing' | 'not_due';

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

/**
 * GET /api/v1/overview — the company home (PRD CA-01): one entry per plant the user can access, with
 * yesterday's logsheet status, the latest MIS figures, a 14-day sparkline, outlet compliance and alerts.
 * Tenant and plant list come from the verified ctx (listPlants), never from the request.
 */
export async function overview(ctx: ClientCtx) {
  const plants = (await listPlants(ctx)).slice(0, MAX_PLANTS);
  const today = todayIST();
  const expected = addDays(today, -1);
  const ids = plants.map((p) => p.id);

  const statusRows = ids.length === 0 ? [] : await withTenant(tenantTx(ctx), (tx) =>
    many<{ plant_id: string; last_date: string | null; exp_status: string | null; sub30: number }>(
      tx,
      `SELECT p.id AS plant_id,
              (SELECT max(l.log_date)::text FROM app.logsheets l
                WHERE l.tenant_id = p.tenant_id AND l.plant_id = p.id AND l.status <> 'draft') AS last_date,
              (SELECT l.status FROM app.logsheets l
                WHERE l.tenant_id = p.tenant_id AND l.plant_id = p.id AND l.log_date = $2::date) AS exp_status,
              (SELECT count(*)::int FROM app.logsheets l
                WHERE l.tenant_id = p.tenant_id AND l.plant_id = p.id AND l.status <> 'draft'
                  AND l.log_date BETWEEN $2::date - 29 AND $2::date) AS sub30
         FROM app.plants p
        WHERE p.tenant_id = $1 AND p.id = ANY($3::uuid[])`,
      [ctx.tenantId, expected, ids],
    ));
  const byPlant = new Map(statusRows.map((r) => [r.plant_id, r]));

  const items = await mapLimit(plants, CONCURRENCY, async (p) => {
    const st = byPlant.get(p.id);
    const live = p.setupStatus === 'live';
    const due = live && expected >= p.misStart && expected <= p.omEnd;
    const expStatus: ExpectedStatus = !due ? 'not_due' : ((st?.exp_status as ExpectedStatus | null) ?? 'missing');
    const winFrom = maxDate(p.misStart, addDays(expected, -29));
    const winTo = minDate(expected, p.omEnd);
    const windowDays = live && winFrom <= winTo ? daysInclusive(winFrom, winTo) : 0;

    let reportDate: string | null = null;
    let primary = null;
    let revenue = null;
    let compliance = null;
    let spark: Array<{ date: string; value: number | null }> = [];
    let alerts: PlantAlert[] = [];
    if (live) {
      try {
        const b = await getBundle(ctx.tenantId, p.id);
        reportDate = latestDate(b);
        if (reportDate) {
          const mis = buildMis(b, reportDate);
          const first = mis.keyParameters.find((r) => r.code !== 'REVENUE');
          const rev = mis.keyParameters.find((r) => r.code === 'REVENUE');
          if (first) {
            primary = {
              code: first.code, name: first.name, unit: first.unit, decimals: first.decimals,
              today: first.today.act, mtdAvg: first.avgPerDay.mtd, mtd: first.mtd.act,
              badge: badge(first.mtdPct, first.direction),
            };
            for (let i = SPARK_DAYS - 1; i >= 0; i--) {
              const d = addDays(reportDate, -i);
              spark.push({ date: d, value: d < p.misStart ? null : dayValue(b.data, b.derived, first.code, d) });
            }
          }
          if (rev) revenue = { mtdAct: rev.mtd.act, mtdStd: rev.mtd.std, badge: badge(rev.mtdPct, rev.direction) };
          compliance = buildSummary(mis).compliance;
          alerts = buildAlerts(mis);
        }
      } catch {
        // a plant whose engine fails must not break the whole overview; it shows "no data"
        spark = [];
      }
    }
    if (expStatus === 'missing' || expStatus === 'draft' || expStatus === 'returned') {
      alerts.unshift({
        id: 'logsheet:expected', level: 'warning', kind: 'logsheet', code: null,
        title: expStatus === 'missing' ? 'Logsheet not submitted' : `Logsheet ${expStatus}`,
        detail: `No submitted logsheet for ${expected} yet.`,
      });
    }
    const count = { critical: 0, warning: 0, info: 0 };
    for (const a of alerts) count[a.level]++;
    return {
      plantId: p.id, code: p.code, name: p.name, type: p.type, capacityMld: p.capacityMld, city: p.city,
      setupStatus: p.setupStatus, accountState: p.accountState, myRole: p.myRole, misStart: p.misStart, omEnd: p.omEnd,
      reportDate, lastLogsheetDate: st?.last_date ?? null,
      expected: { date: expected, status: expStatus },
      submissions30d: { submitted: Math.min(st?.sub30 ?? 0, windowDays), days: windowDays },
      primary, revenue, compliance, spark,
      alerts: alerts.slice(0, 6), alertCount: count,
    };
  });

  const due = items.filter((i) => i.expected.status !== 'not_due');
  const done = due.filter((i) => ['submitted', 'corrected', 'checked', 'verified'].includes(i.expected.status));
  const sum = (k: 'critical' | 'warning' | 'info') => items.reduce((s, i) => s + i.alertCount[k], 0);
  const revAct = items.reduce((s, i) => s + (i.revenue?.mtdAct ?? 0), 0);
  const revStd = items.reduce((s, i) => s + (i.revenue?.mtdStd ?? 0), 0);
  return {
    generatedAt: new Date().toISOString(),
    expectedDate: expected,
    plants: items,
    totals: {
      plants: items.length,
      live: items.filter((i) => i.setupStatus === 'live').length,
      settingsPending: items.filter((i) => i.setupStatus === 'settings_pending').length,
      expected: due.length,
      submitted: done.length,
      alerts: { critical: sum('critical'), warning: sum('warning'), info: sum('info') },
      revenueMtd: { act: revAct, std: revStd, badge: badge(revStd > 0 ? (revAct - revStd) / revStd : null, 'higher_better') },
    },
  };
}
