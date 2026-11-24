import type { MisReport, ParamRowOut } from '../../engine/core/mis';
import type { StandardKind } from '../../../shared/enums';
import { BASE_CSS, cls, dt, esc, footer, n } from './html';

export type MisPeriod = 'today' | 'mtd' | 'utd' | 'range' | 'all';
type OnePeriod = 'today' | 'mtd' | 'utd' | 'range';
export type MisKind = StandardKind | 'both';
/** What the user picked on the MIS page. The PDF prints exactly this and nothing else. `from` = start of a date range. */
export interface MisFilter { period: MisPeriod; kind: MisKind; from?: string | null }

const PERIOD_LABEL: Record<OnePeriod, string> = { today: 'DAILY', mtd: 'MONTHLY', utd: 'UTD', range: 'DATE RANGE' };
const PERIOD_TITLE: Record<MisPeriod, string> = { ...PERIOD_LABEL, all: 'DAILY · MONTHLY · UTD' };
const KIND_LABEL: Record<MisKind, string> = { actual: 'ACTUAL STANDARD', bidding: 'BIDDING STANDARD', both: 'ACTUAL & BIDDING STANDARDS' };

/**
 * MIS report for the chosen period(s) (Daily / Monthly / UTD / Date range / All) against the chosen standard(s)
 * (Actual / Bidding / Both). One column group per period; every number comes from the engine, nothing is fixed here.
 * Single standard → Standard · Actual · Variance · Average/day · Limit exceeded (days).
 * Both standards  → Actual · Average/day · Bidding std · Bidding var · Actual std · Actual var.
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

  const groupCells = (r: ParamRowOut, dp: number, per: OnePeriod) => {
    if (both) {
      const b = r.standards.bidding[per];
      const a = r.standards.actual[per];
      return `<td class="num">${n(a.act, dp)}</td><td class="num">${n(r.standards.actual.avg[per], dp)}</td>
        <td class="num">${n(b.std, dp)}</td><td class="num ${cls(b.varFlag)}">${n(b.var, dp)}</td>
        <td class="num">${n(a.std, dp)}</td><td class="num ${cls(a.varFlag)}">${n(a.var, dp)}</td>`;
    }
    const k = r.standards[single];
    const t = k[per];
    const ex = k.exceed[per];
    return `<td class="num">${n(t.std, dp)}</td><td class="num">${n(t.act, dp)}</td><td class="num ${cls(t.varFlag)}">${n(t.var, dp)}</td>
      <td class="num">${n(k.avg[per], dp)}</td><td class="num ${ex > 0 ? 'bad' : ''}">${ex}</td>`;
  };
  const subHead = both
    ? '<th>ACTUAL</th><th>AVG / DAY</th><th>BID STD</th><th>BID VAR</th><th>ACT STD</th><th>ACT VAR</th>'
    : '<th>STANDARD</th><th>ACTUAL</th><th>VARIANCE</th><th>AVG / DAY</th><th>EXCEEDED (DAYS)</th>';
  const span = both ? 6 : 5;
  const groupTitle = (per: OnePeriod) =>
    per === 'range' ? `${PERIOD_LABEL[per]} · ${dt(h.rangeFrom)} – ${dt(h.rangeTo)}` : PERIOD_LABEL[per];
  const head = (first: string, extra = '') =>
    `<tr><th rowspan="2">${first}</th><th rowspan="2">UNIT</th>${periods.map((per) => `<th colspan="${span}">${groupTitle(per)}</th>`).join('')}${extra ? `<th rowspan="2">${extra}</th>` : ''}</tr>
     <tr>${periods.map(() => subHead).join('')}</tr>`;

  const keyRows = m.keyParameters.map((r) => {
    const dp = r.code === 'REVENUE' ? 2 : Math.min(r.decimals, 2);
    return `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${periods.map((per) => groupCells(r, dp, per)).join('')}</tr>`;
  }).join('');
  const chemRows = m.chemicals.map((r) => {
    const dp = Math.min(r.decimals, 2);
    return `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${periods.map((per) => groupCells(r, dp, per)).join('')}
      <td class="num ${cls(r.balanceFlag)}">${n(r.balance, 2)}</td></tr>`;
  }).join('');

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
    td, th { padding: 3px ${wide ? 3 : 5}px; }
    th { text-align: center; }
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
    ${footer(footerMeta, 1, 0)}
  </body></html>`;
}
