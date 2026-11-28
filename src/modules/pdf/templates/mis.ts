import type { MisReport, ParamRowOut } from '../../engine/core/mis';
import type { StandardKind } from '../../../shared/enums';
import { BASE_CSS, cls, dt, esc, footer, n } from './html';

export type MisPeriod = 'today' | 'mtd' | 'utd' | 'range' | 'all';
type OnePeriod = 'today' | 'mtd' | 'utd' | 'range';
export type MisKind = StandardKind | 'both';
/** What the user picked on the MIS page. The PDF prints exactly this and nothing else. `from` = start of a date range. */
export interface MisFilter { period: MisPeriod; kind: MisKind; from?: string | null }

const PERIOD_LABEL: Record<OnePeriod, string> = { today: 'DAILY', mtd: 'MONTHLY', utd: 'UP TO DATE (UTD)', range: 'DATE RANGE' };
const PERIOD_TITLE: Record<MisPeriod, string> = { ...PERIOD_LABEL, all: 'DAILY · MONTHLY · UTD' };
const KIND_LABEL: Record<MisKind, string> = { actual: 'ACTUAL STANDARD', bidding: 'BIDDING STANDARD', both: 'ACTUAL & BIDDING STANDARDS' };

type Lab = MisReport['lab']['inlet'][number];
type Staff = MisReport['staff'];
type Safety = MisReport['safety'];

/**
 * MIS report for the chosen period(s) (Daily / Monthly / UTD / Date range / All) against the chosen standard(s)
 * (Actual / Bidding / Both). Every section follows the filter; every number comes from the engine.
 * Single standard → Standard · Actual · Variance · Average · Limit exceeded (days)   (no Average for Daily).
 * Both standards  → Actual · Average · Bidding std · Bidding var · Actual std · Actual var.
 * Staff and safety are daily snapshots: for Monthly / UTD / Range they print the average of the logged days.
 */
export function misHtml(
  m: MisReport,
  meta: { version: number; platform: string; logoUrl?: string | null },
  filter: MisFilter,
): string {
  const h = m.header;
  const { period, kind } = filter;
  const hasRange = h.rangeDays > 1;
  const effPeriod: MisPeriod = period === 'range' && !hasRange ? 'today' : period;
  const periods: OnePeriod[] =
    effPeriod === 'all' ? (hasRange ? ['today', 'range', 'mtd', 'utd'] : ['today', 'mtd', 'utd']) : [effPeriod];
  const both = kind === 'both';
  const single: StandardKind = both ? 'actual' : kind;
  const wide = periods.length > 1 || both;
  /** The snapshot sections (staff, safety) show one period: the picked one, or the report day for "All". */
  const snapPeriod: OnePeriod = effPeriod === 'all' ? 'today' : effPeriod;

  // ---------------------------------------------------------------- key parameters & chemicals
  const subHeads = (per: OnePeriod) => {
    const avg = per === 'today' ? [] : ['AVERAGE'];
    return both
      ? ['ACTUAL', ...avg, 'BID STD', 'BID VAR', 'ACT STD', 'ACT VAR']
      : ['STANDARD', 'ACTUAL', 'VARIANCE', ...avg, 'LIMIT EXCEEDED (DAYS)'];
  };
  const groupCells = (r: ParamRowOut, dp: number, per: OnePeriod) => {
    const avgCell = (v: number | null) => (per === 'today' ? '' : `<td class="num">${n(v, dp)}</td>`);
    if (both) {
      const b = r.standards.bidding[per];
      const a = r.standards.actual[per];
      return `<td class="num">${n(a.act, dp)}</td>${avgCell(r.standards.actual.avg[per])}
        <td class="num">${n(b.std, dp)}</td><td class="num ${cls(b.varFlag)}">${n(b.var, dp)}</td>
        <td class="num">${n(a.std, dp)}</td><td class="num ${cls(a.varFlag)}">${n(a.var, dp)}</td>`;
    }
    const k = r.standards[single];
    const t = k[per];
    const ex = k.exceed[per];
    return `<td class="num">${n(t.std, dp)}</td><td class="num">${n(t.act, dp)}</td><td class="num ${cls(t.varFlag)}">${n(t.var, dp)}</td>
      ${avgCell(k.avg[per])}<td class="num ${ex > 0 ? 'bad' : ''}">${ex}</td>`;
  };
  const groupTitle = (per: OnePeriod) =>
    per === 'range' ? `${PERIOD_LABEL[per]} · ${dt(h.rangeFrom)} – ${dt(h.rangeTo)}` : PERIOD_LABEL[per];
  const head = (first: string, extra = '') =>
    `<tr><th rowspan="2">${first}</th><th rowspan="2">UNIT</th>${periods.map((per) => `<th colspan="${subHeads(per).length}">${groupTitle(per)}</th>`).join('')}${extra ? `<th rowspan="2">${extra}</th>` : ''}</tr>
     <tr>${periods.map((per) => subHeads(per).map((x) => `<th>${x}</th>`).join('')).join('')}</tr>`;

  const keyRows = m.keyParameters.map((r) => {
    const dp = r.code === 'REVENUE' ? 2 : Math.min(r.decimals, 2);
    return `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${periods.map((per) => groupCells(r, dp, per)).join('')}</tr>`;
  }).join('');
  const chemRows = m.chemicals.map((r) => {
    const dp = Math.min(r.decimals, 2);
    return `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${periods.map((per) => groupCells(r, dp, per)).join('')}
      <td class="num ${cls(r.balanceFlag)}">${n(r.balance, 2)}</td></tr>`;
  }).join('');

  // ---------------------------------------------------------------- quality control (lab)
  const kinds: StandardKind[] = both ? ['actual', 'bidding'] : [single];
  const KSHORT: Record<StandardKind, string> = { actual: 'ACT', bidding: 'BID' };
  const limitText = (min: number | null, max: number | null, dp: number) =>
    [min !== null ? `≥ ${n(min, dp)}` : null, max !== null ? `≤ ${n(max, dp)}` : null].filter(Boolean).join(' · ') || '–';
  const labHeads = (per: OnePeriod) => [
    per === 'today' ? 'RESULT' : 'AVERAGE',
    ...kinds.map((k) => (both ? `${KSHORT[k]} STATUS` : 'STATUS')),
    ...(per === 'today' ? [] : kinds.map((k) => (both ? `${KSHORT[k]} EXCEEDED (DAYS)` : 'EXCEEDED (DAYS)'))),
  ];
  const labHead = () => {
    const limits = kinds.map((k) => `<th rowspan="2">${both ? `${KSHORT[k]} LIMIT` : 'LIMIT'}</th>`).join('');
    return `<tr><th rowspan="2">PARAMETER</th><th rowspan="2">UNIT</th>${limits}${periods.map((per) => `<th colspan="${labHeads(per).length}">${groupTitle(per)}</th>`).join('')}</tr>
      <tr>${periods.map((per) => labHeads(per).map((x) => `<th>${x}</th>`).join('')).join('')}</tr>`;
  };
  const labRows = (rows: Lab[]) => rows.map((r) => {
    const dp = Math.min(r.decimals, 2);
    const limits = kinds.map((k) => `<td>${limitText(r.standards[k].min, r.standards[k].max, dp)}</td>`).join('');
    const cells = periods.map((per) => {
      const v = r.values[per];
      const status = kinds.map((k) => {
        const res = r.standards[k].results[per];
        return `<td class="${cls(res.flag)}">${res.result === null ? '–' : res.result === 'EXCEEDED LIMIT' ? 'EXCEEDED' : 'WITHIN'}</td>`;
      }).join('');
      const ev = per === 'today' ? '' : kinds.map((k) => {
        const e = r.standards[k].events[per];
        return `<td class="num ${e > 0 ? 'bad' : ''}">${e}</td>`;
      }).join('');
      const worst = kinds.some((k) => r.standards[k].results[per].flag === 'bad');
      return `<td class="num ${worst ? 'bad' : ''}">${n(v, dp)}</td>${status}${ev}`;
    }).join('');
    return `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${limits}${cells}</tr>`;
  }).join('');
  const labSection = (title: string, rows: Lab[]) =>
    rows.length ? `<section><h3>${title}</h3><table>${labHead()}${labRows(rows)}</table></section>` : '';

  // ---------------------------------------------------------------- cash
  const cashP = m.cash.periods;
  const cashSection = `<section><h3>SITE CASH</h3><table>
    <tr><th>PERIOD</th><th>SPENT</th><th>RECEIVED</th></tr>
    ${periods.map((per) => `<tr><td>${groupTitle(per)}</td><td class="num">${n(cashP[per].spent, 0)}</td><td class="num">${n(cashP[per].received, 0)}</td></tr>`).join('')}
    <tr><td><b>Cash in hand on ${dt(h.reportDate)}</b></td><td class="num" colspan="2"><b>${n(m.cash.inHand, 0)}</b></td></tr>
  </table></section>`;

  // ---------------------------------------------------------------- staff & safety (averaged for longer periods)
  const avgNote = (p: { dataDays: number; averaged: boolean }) =>
    p.averaged ? ` <span class="note">— ${PERIOD_LABEL[snapPeriod]}: average of ${p.dataDays} logged day${p.dataDays === 1 ? '' : 's'}</span>` : ` <span class="note">— ${dt(h.reportDate)}</span>`;
  const st: Staff['periods'][OnePeriod] = m.staff.periods[snapPeriod];
  const staffDp = st.averaged ? 1 : 0;
  const staffSection = st.rows.length ? `<section><h3>STAFF${avgNote(st)}</h3><table>
    <tr><th>CATEGORY</th><th>ON CONTRACT</th><th>VACANT</th><th>PRESENT</th><th>LEAVE</th><th>ABSENT</th></tr>
    ${st.rows.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${n(r.contract, staffDp)}</td><td class="num">${n(r.vacant, staffDp)}</td>
      <td class="num">${n(r.present, staffDp)}</td><td class="num">${n(r.leave, staffDp)}</td><td class="num ${cls(r.absentFlag)}">${n(r.absent, staffDp)}</td></tr>`).join('')}
    <tr><td><b>Total</b></td>${(['contract', 'vacant', 'present', 'leave', 'absent'] as const).map((k) => `<td class="num"><b>${n(st.total[k] ?? null, staffDp)}</b></td>`).join('')}</tr>
  </table></section>` : '';
  const sf: Safety['periods'][OnePeriod] = m.safety.periods[snapPeriod];
  const sfDp = sf.averaged ? 1 : 0;
  const safetySection = sf.rows.length ? `<section><h3>SAFETY${avgNote(sf)}</h3><table>
    <tr><th>ITEM</th><th>REQUIRED</th><th>AVAILABLE</th><th>DEFICIT</th></tr>
    ${sf.rows.map((r) => `<tr><td>${esc(r.item)}</td><td class="num">${n(r.required, sfDp)}</td><td class="num">${n(r.actual, sfDp)}</td><td class="num ${cls(r.deficitFlag)}">${n(r.deficit, sfDp)}</td></tr>`).join('')}
    <tr><td><b>Total</b></td>${(['required', 'actual', 'deficit'] as const).map((k) => `<td class="num"><b>${n(sf.total[k] ?? null, sfDp)}</b></td>`).join('')}</tr>
  </table></section>` : '';

  const daysText: Record<OnePeriod, string> = {
    today: `Report date <b>${dt(h.reportDate)}</b>`,
    mtd: `Month to date · <b>${h.mtdDays}</b> days (${h.mtdDataDays} with a submitted logsheet)`,
    utd: `Up to date · <b>${h.utdDays}</b> days (${h.utdDataDays} with a submitted logsheet)`,
    range: `<b>${dt(h.rangeFrom)}</b> to <b>${dt(h.rangeTo)}</b> · <b>${h.rangeDays}</b> days (${h.rangeDataDays} with a submitted logsheet)`,
  };
  const days = effPeriod === 'all' ? `Report date <b>${dt(h.reportDate)}</b>` : daysText[effPeriod];
  const dateLabel = hasRange && (effPeriod === 'range' || effPeriod === 'all')
    ? `Dates <b>${dt(h.rangeFrom)} – ${dt(h.rangeTo)}</b>`
    : `Report date <b>${dt(h.reportDate)}</b>`;

  const footerMeta = { generatedAt: m.meta.generatedAt, version: meta.version,
    status: h.logsheet ? `${h.logsheet.status} v${h.logsheet.version}` : 'No logsheet', platform: meta.platform };

  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    @page { size: A4 landscape; margin: 8mm; }
    body { font-size: ${wide ? 7.5 : 9}px; }
    section, table { break-inside: avoid; }
    .hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid #999; padding-bottom: 4px; }
    .filter { margin: 0 0 8px; font-size: 11px; font-weight: 700; }
    section { margin-bottom: 10px; }
    h3 { font-size: 11px; background: #d9e1f2; padding: 3px 4px; margin-bottom: 2px; }
    h3 .note { font-weight: 400; font-size: 9px; color: #444; }
    td, th { padding: 3px ${wide ? 3 : 5}px; }
    th { text-align: center; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  </style></head><body>
    <div class="hdr">
      <div>${meta.logoUrl ? `<img src="${esc(meta.logoUrl)}" style="height:28px">` : ''}</div>
      <div style="text-align:center">
        <h1 style="font-size:15px">${esc(h.companyName)}</h1>
        <div>MIS for site: <b>${esc(h.plantName)}</b> · Client: <b>${esc(h.clientName)}</b></div>
      </div>
      <div style="text-align:right">${dateLabel}</div>
    </div>
    <p class="filter">${PERIOD_TITLE[effPeriod]} · ${KIND_LABEL[kind]} <span class="muted" style="font-weight:400">— ${days}</span></p>
    <section><h3>KEY PARAMETERS</h3><table>${head('PARAMETER')}${keyRows}</table></section>
    ${m.chemicals.length ? `<section><h3>CHEMICALS &amp; CONSUMABLES</h3><table>${head('ITEM', 'BALANCE')}${chemRows}</table></section>` : ''}
    ${labSection('QUALITY CONTROL · INLET', m.lab.inlet)}
    ${labSection('QUALITY CONTROL · OUTLET', m.lab.outlet)}
    ${cashSection}
    <div class="pair">${staffSection}${safetySection}</div>
    ${footer(footerMeta, 1, 0)}
  </body></html>`;
}
