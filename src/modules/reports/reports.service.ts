import { many } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { addDays, daysInclusive, monthEnd, maxDate, minDate } from '../../lib/dates';
import { badRequest, notFound, unprocessable } from '../../lib/errors';
import type { ClientCtx, PlantCtx } from '../../types/express';
import { standardAt } from '../engine/core/effective';
import { dayValue } from '../engine/core/derive';
import { eachDay } from '../engine/core/periods';
import { dailyStd, eventOn } from '../engine/core/stats';
import type { Bundle } from '../engine/core/mis';
import type { ParamDef } from '../engine/core/types';
import { NUM0, NUM2, type ReportTable } from './table';

function range(b: Bundle, from?: string, to?: string) {
  const s = b.settings.plant;
  const f = maxDate(from ?? s.misStart, s.misStart);
  const t = minDate(to ?? addDays(new Date().toISOString().slice(0, 10), -1), s.omEnd);
  if (f > t) throw badRequest('INVALID_RANGE', 'From date must be on or before the to date (within the contract).');
  return { from: f, to: t, days: daysInclusive(f, t) };
}
function param(b: Bundle, code: string): ParamDef {
  const p = b.settings.params.find((x) => x.code === code);
  if (!p) throw notFound(`Parameter ${code}`);
  return p;
}

/** RPT-01…03: 1–4 SUM parameters, daily value + running total; footer over days with data only (fix D16). */
export function monthly(b: Bundle, month: string, codes: string[]): ReportTable {
  if (codes.length < 1 || codes.length > 4) throw badRequest('INVALID_PARAMS', 'Choose 1 to 4 parameters.');
  const ps = codes.map((c) => param(b, c));
  if (ps.some((p) => p.aggregation !== 'sum')) throw unprocessable('INVALID_PARAMS', 'Monthly report supports SUM-type parameters only.');
  const r = range(b, `${month}-01`, monthEnd(`${month}-01`));
  const cum = new Map(ps.map((p) => [p.code, 0]));
  const stats = new Map(ps.map((p) => [p.code, [] as number[]]));
  const rows = [...eachDay(r)].map((d) => {
    const row: Record<string, string | number | null> = { date: d };
    for (const p of ps) {
      const v = dayValue(b.data, b.derived, p.code, d);
      if (v !== null) {
        cum.set(p.code, cum.get(p.code)! + v);
        stats.get(p.code)!.push(v);
      }
      row[p.code] = v;
      row[`${p.code}_cum`] = cum.get(p.code)!;
    }
    return row;
  });
  const agg = (fn: (x: number[]) => number | null) =>
    Object.fromEntries(ps.map((p) => [p.code, fn(stats.get(p.code)!)]));
  const footer = [
    { date: 'Total', ...agg((x) => x.reduce((a, v) => a + v, 0)) },
    { date: 'Average', ...agg((x) => (x.length ? x.reduce((a, v) => a + v, 0) / x.length : null)) },
    { date: 'Maximum', ...agg((x) => (x.length ? Math.max(...x) : null)) },
    { date: 'Minimum', ...agg((x) => (x.length ? Math.min(...x) : null)) },
    { date: 'Days with data', ...agg((x) => x.length) },
  ];
  return {
    title: `Monthly report ${month}`, subtitle: b.settings.plant.name,
    columns: [{ key: 'date', header: 'Date' }, ...ps.flatMap((p) => [
      { key: p.code, header: `${p.shortName ?? p.name} (${p.unit})`, numFmt: NUM2 },
      { key: `${p.code}_cum`, header: `${p.shortName ?? p.name} cumulative`, numFmt: NUM2 },
    ])],
    rows, footer,
  };
}

const DEFAULT_CUSTOM = ['INFLOW', 'EB_KWH', 'BGE_HRS', 'BGE_KWH', 'DG_HRS', 'DG_KWH', 'OUT_PH', 'OUT_BOD', 'OUT_COD', 'OUT_TSS', 'OUT_FC'];
/** RPT-04…06: totals (SUM), averages (AVG), stock movement, revenue STD vs ACT, data days. */
export function custom(b: Bundle, from?: string, to?: string, codes?: string[]): ReportTable {
  const r = range(b, from, to);
  const ps = (codes?.length ? codes : DEFAULT_CUSTOM).map((c) => b.settings.params.find((p) => p.code === c)).filter((p): p is ParamDef => !!p);
  const rows: Array<Record<string, string | number | null>> = [];
  for (const p of ps) {
    const vals: number[] = [];
    for (const d of eachDay(r)) {
      const v = dayValue(b.data, b.derived, p.code, d);
      if (v !== null) vals.push(v);
    }
    const sum = vals.reduce((a, v) => a + v, 0);
    rows.push({ item: p.shortName ?? p.name, unit: p.unit, kind: p.aggregation === 'avg' ? 'Average' : 'Total',
      value: p.aggregation === 'avg' ? (vals.length ? sum / vals.length : null) : sum, daysWithData: vals.length });
  }
  for (const i of b.settings.stock) {
    const opening = i.openingDate >= addDays(r.from, -1) ? i.opening : b.derived.get(addDays(r.from, -1))?.stock[i.code] ?? i.opening;
    let consumed = 0;
    let received = 0;
    for (const d of eachDay(r)) {
      consumed += dayValue(b.data, b.derived, i.consumedCode, d) ?? 0;
      received += dayValue(b.data, b.derived, i.receivedCode, d) ?? 0;
    }
    rows.push({ item: `${i.name} – opening / received / consumed / closing`, unit: i.unit, kind: 'Stock',
      value: b.derived.get(r.to)?.stock[i.code] ?? null, opening, received, consumed });
  }
  let revStd = 0;
  let revAct = 0;
  let dataDays = 0;
  for (const d of eachDay(r)) {
    const dd = b.derived.get(d);
    revStd += dd?.revStd ?? 0;
    revAct += dd?.revAct ?? 0;
    if (b.data.days.has(d)) dataDays++;
  }
  rows.push({ item: 'Revenue STD (₹ million)', unit: '₹ M', kind: 'Total', value: revStd / 1e6 });
  rows.push({ item: 'Revenue ACT (₹ million)', unit: '₹ M', kind: 'Total', value: revAct / 1e6 });
  return {
    title: `Custom report ${r.from} to ${r.to}`, subtitle: b.settings.plant.name,
    columns: [{ key: 'item', header: 'Item', width: 40 }, { key: 'unit', header: 'UOM' }, { key: 'kind', header: 'Type' },
      { key: 'value', header: 'Value', numFmt: NUM2 }, { key: 'opening', header: 'Opening', numFmt: NUM2 },
      { key: 'received', header: 'Received', numFmt: NUM2 }, { key: 'consumed', header: 'Consumed', numFmt: NUM2 },
      { key: 'daysWithData', header: 'Days with data', numFmt: NUM0 }],
    rows, meta: { calendarDays: r.days, dataDays },
  };
}

/** RPT-07: daily values with the standard / band and event days marked. */
export function trend(b: Bundle, code: string, from?: string, to?: string): ReportTable {
  const p = param(b, code);
  const r = range(b, from, to);
  const rows = [...eachDay(r)].map((d) => {
    const v = dayValue(b.data, b.derived, p.code, d);
    const st = standardAt(p, d);
    return { date: d, value: v, std: dailyStd(b.settings, p, d), min: st?.min ?? null, max: st?.max ?? null,
      event: v !== null && eventOn(b.settings, p, d, v) ? 'YES' : '' };
  });
  return { title: `Trend: ${p.name}`, subtitle: `${r.from} to ${r.to}`,
    columns: [{ key: 'date', header: 'Date' }, { key: 'value', header: `${p.name} (${p.unit})`, numFmt: NUM2 },
      { key: 'std', header: 'Standard', numFmt: NUM2 }, { key: 'min', header: 'Min' }, { key: 'max', header: 'Max' }, { key: 'event', header: 'Event' }],
    rows };
}

/** RPT-08/09: stock ledger + days of stock left. */
export function stockLedger(b: Bundle, itemCode: string, from?: string, to?: string): ReportTable {
  const i = b.settings.stock.find((x) => x.code === itemCode);
  if (!i) throw notFound('Stock item');
  const r = range(b, from, to);
  const rows = [...eachDay(r)].map((d) => {
    const prev = d === addDays(i.openingDate, 1) ? i.opening : b.derived.get(addDays(d, -1))?.stock[i.code] ?? null;
    const adj = i.adjustments.filter((a) => a.date === d).reduce((a, x) => a + x.qty, 0);
    return { date: d, opening: prev, received: dayValue(b.data, b.derived, i.receivedCode, d) ?? 0,
      consumed: dayValue(b.data, b.derived, i.consumedCode, d) ?? 0, adjustment: adj, closing: b.derived.get(d)?.stock[i.code] ?? null };
  });
  const recent: number[] = [];
  for (let d = r.to; recent.length < 30 && d >= b.settings.plant.misStart; d = addDays(d, -1)) {
    const v = b.data.days.has(d) ? dayValue(b.data, b.derived, i.consumedCode, d) : null;
    if (v !== null) recent.push(v);
  }
  const avg = recent.length ? recent.reduce((a, v) => a + v, 0) / recent.length : 0;
  const closing = b.derived.get(r.to)?.stock[i.code] ?? null;
  return { title: `Stock ledger: ${i.name}`, subtitle: `${r.from} to ${r.to}`,
    columns: ['date', 'opening', 'received', 'consumed', 'adjustment', 'closing'].map((k) => ({
      key: k, header: k[0]!.toUpperCase() + k.slice(1), numFmt: k === 'date' ? undefined : NUM2 })),
    rows, meta: { daysOfStockLeft: closing !== null && avg > 0 ? closing / avg : null, avgDailyConsumption: avg } };
}

/** RPT-10: cash book. */
export function cashBook(b: Bundle, from?: string, to?: string): ReportTable {
  const r = range(b, from, to);
  const exp = b.settings.params.find((p) => p.linkRole === 'expense');
  const rec = b.settings.params.find((p) => p.linkRole === 'cash_received');
  const desc = b.settings.params.find((p) => p.linkRole === 'description');
  let te = 0;
  let tr = 0;
  const rows = [...eachDay(r)].map((d) => {
    const e = exp ? dayValue(b.data, b.derived, exp.code, d) ?? 0 : 0;
    const rc = rec ? dayValue(b.data, b.derived, rec.code, d) ?? 0 : 0;
    te += e;
    tr += rc;
    return { date: d, opening: d === addDays(b.settings.cash.openingDate, 1) ? b.settings.cash.opening : b.derived.get(addDays(d, -1))?.cash ?? null,
      received: rc, expense: e, description: desc ? ((b.data.days.get(d)?.values[desc.code] as string | null) ?? '') : '',
      closing: b.derived.get(d)?.cash ?? null };
  });
  return { title: 'Cash book', subtitle: `${r.from} to ${r.to}`,
    columns: [{ key: 'date', header: 'Date' }, { key: 'opening', header: 'Opening', numFmt: NUM0 }, { key: 'received', header: 'Received', numFmt: NUM0 },
      { key: 'expense', header: 'Expense', numFmt: NUM0 }, { key: 'description', header: 'Description', width: 40 }, { key: 'closing', header: 'Closing', numFmt: NUM0 }],
    rows, footer: [{ date: 'Total', received: tr, expense: te }] };
}

/** RPT-11: every lab exceedance in the range. */
export function labCompliance(b: Bundle, from?: string, to?: string, side: 'outlet' | 'inlet' | 'both' = 'outlet'): ReportTable {
  const r = range(b, from, to);
  const groups = side === 'both' ? ['lab_inlet', 'lab_outlet'] : [`lab_${side}`];
  const ps = b.settings.params.filter((p) => groups.includes(p.group));
  const rows: Array<Record<string, string | number | null>> = [];
  const summary: Record<string, number> = {};
  for (const d of eachDay(r)) {
    for (const p of ps) {
      const v = b.data.days.has(d) ? dayValue(b.data, b.derived, p.code, d) : null;
      if (v === null || !eventOn(b.settings, p, d, v)) continue;
      const st = standardAt(p, d);
      rows.push({ date: d, parameter: p.name, value: v, limit: `${st?.min ?? ''}${st?.min != null && st?.max != null ? ' – ' : ''}${st?.max != null ? `≤ ${st.max}` : ''}`,
        remarks: (b.data.days.get(d)?.values.REMARKS as string | null) ?? '' });
      summary[p.name] = (summary[p.name] ?? 0) + 1;
    }
  }
  return { title: 'Lab compliance', subtitle: `${r.from} to ${r.to}`,
    columns: [{ key: 'date', header: 'Date' }, { key: 'parameter', header: 'Parameter' }, { key: 'value', header: 'Value', numFmt: NUM2 },
      { key: 'limit', header: 'Limit' }, { key: 'remarks', header: 'Remarks', width: 40 }],
    rows, meta: { summary } };
}

/** RPT-12: submission status per date (from the logsheets table, includes drafts and missing days). */
export async function submissions(ctx: ClientCtx, plant: PlantCtx, from: string, to: string): Promise<ReportTable> {
  const f = maxDate(from, plant.misStart);
  const t = minDate(to, plant.omEnd);
  const rows = await withTenant({ tenantId: ctx.tenantId, actorId: ctx.userId }, (tx) =>
    many<{ log_date: string; status: string; version: number; submitted_name: string | null; submitted_at: string | null; source: string }>(tx,
      `SELECT l.log_date, l.status, l.version, u.name AS submitted_name, l.submitted_at, l.source FROM app.logsheets l
         LEFT JOIN app.users u ON u.tenant_id = l.tenant_id AND u.id = l.submitted_by
        WHERE l.tenant_id = $1 AND l.plant_id = $2 AND l.log_date BETWEEN $3 AND $4`, [ctx.tenantId, plant.id, f, t]));
  const by = new Map(rows.map((r) => [r.log_date, r]));
  const out = [];
  for (let d = f; d <= t; d = addDays(d, 1)) {
    const r = by.get(d);
    out.push({ date: d, status: r ? (r.status === 'corrected' ? `corrected v${r.version}` : r.status) : 'missing',
      submittedBy: r?.submitted_name ?? '', submittedAt: r?.submitted_at ?? '', source: r?.source ?? '' });
  }
  return { title: 'Logsheet submission status', subtitle: `${f} to ${t}`,
    columns: [{ key: 'date', header: 'Date' }, { key: 'status', header: 'Status' }, { key: 'submittedBy', header: 'Submitted by' },
      { key: 'submittedAt', header: 'Submitted at', width: 24 }, { key: 'source', header: 'Source' }],
    rows: out, meta: { missing: out.filter((r) => r.status === 'missing').length } };
}
