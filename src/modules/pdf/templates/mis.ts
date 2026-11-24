import type { MisReport, ParamRowOut } from '../../engine/core/mis';
import type { StandardKind } from '../../../shared/enums';
import { BASE_CSS, cls, dt, esc, footer, n } from './html';

export type MisPeriod = 'today' | 'mtd' | 'utd';
/** What the user picked on the MIS page. The PDF prints exactly this and nothing else. */
export interface MisFilter { period: MisPeriod; kind: StandardKind }

const PERIOD_LABEL: Record<MisPeriod, string> = { today: 'DAILY', mtd: 'MONTHLY', utd: 'UP TO DATE (UTD)' };
const KIND_LABEL: Record<StandardKind, string> = { actual: 'ACTUAL STANDARD', bidding: 'BIDDING STANDARD' };

/**
 * Simple MIS report for ONE period (Daily / Monthly / UTD) against ONE standard (Actual / Bidding).
 * Key parameters and chemicals: Standard · Actual · Variance · Average per day · Days the limit was exceeded.
 * Every number comes from the engine for the chosen filter; nothing is fixed in the template.
 */
export function misHtml(
  m: MisReport,
  meta: { version: number; platform: string; logoUrl?: string | null },
  filter: MisFilter,
): string {
  const h = m.header;
  const { period, kind } = filter;

  const cells = (r: ParamRowOut, dp: number) => {
    const k = r.standards[kind];
    const t = k[period];
    const ex = k.exceed[period];
    return `<td class="num">${n(t.std, dp)}</td><td class="num">${n(t.act, dp)}</td><td class="num ${cls(t.varFlag)}">${n(t.var, dp)}</td>
      <td class="num">${n(k.avg[period], dp)}</td><td class="num ${ex > 0 ? 'bad' : ''}">${ex}</td>`;
  };
  const head = (first: string, extra = '') =>
    `<tr><th>${first}</th><th>UNIT</th><th>STANDARD</th><th>ACTUAL</th><th>VARIANCE</th><th>AVERAGE / DAY</th><th>LIMIT EXCEEDED (DAYS)</th>${extra ? `<th>${extra}</th>` : ''}</tr>`;

  const keyRows = m.keyParameters.map((r) =>
    `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${cells(r, r.code === 'REVENUE' ? 2 : Math.min(r.decimals, 2))}</tr>`).join('');
  const chemRows = m.chemicals.map((r) =>
    `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${cells(r, Math.min(r.decimals, 2))}
      <td class="num ${cls(r.balanceFlag)}">${n(r.balance, 2)}</td></tr>`).join('');

  const days = period === 'today'
    ? `Report date <b>${dt(h.reportDate)}</b>`
    : period === 'mtd'
      ? `Month to date · <b>${h.mtdDays}</b> days (${h.mtdDataDays} with a submitted logsheet)`
      : `Up to date · <b>${h.utdDays}</b> days (${h.utdDataDays} with a submitted logsheet)`;

  const footerMeta = { generatedAt: m.meta.generatedAt, version: meta.version,
    status: h.logsheet ? `${h.logsheet.status} v${h.logsheet.version}` : 'No logsheet', platform: meta.platform };

  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    @page { size: A4 landscape; margin: 8mm; }
    body { font-size: 9px; }
    section, table { break-inside: avoid; }
    .hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid #999; padding-bottom: 4px; }
    .filter { margin: 0 0 8px; font-size: 11px; font-weight: 700; }
    section { margin-bottom: 10px; }
    h3 { font-size: 11px; background: #d9e1f2; padding: 3px 4px; margin-bottom: 2px; }
    td, th { padding: 3px 5px; }
  </style></head><body>
    <div class="hdr">
      <div>${meta.logoUrl ? `<img src="${esc(meta.logoUrl)}" style="height:28px">` : ''}</div>
      <div style="text-align:center">
        <h1 style="font-size:15px">${esc(h.companyName)}</h1>
        <div>MIS for site: <b>${esc(h.plantName)}</b> · Client: <b>${esc(h.clientName)}</b></div>
      </div>
      <div style="text-align:right">Report date <b>${dt(h.reportDate)}</b></div>
    </div>
    <p class="filter">${PERIOD_LABEL[period]} · ${KIND_LABEL[kind]} <span class="muted" style="font-weight:400">— ${days}</span></p>
    <section><h3>KEY PARAMETERS</h3><table>${head('PARAMETER')}${keyRows}</table></section>
    ${m.chemicals.length ? `<section><h3>CHEMICALS &amp; CONSUMABLES</h3><table>${head('ITEM', 'BALANCE')}${chemRows}</table></section>` : ''}
    ${footer(footerMeta, 1, 0)}
  </body></html>`;
}
