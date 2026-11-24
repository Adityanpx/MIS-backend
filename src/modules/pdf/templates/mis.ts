import type { MisReport, ParamRowOut } from '../../engine/core/mis';
import type { StandardKind } from '../../../shared/enums';
import { BASE_CSS, cls, dt, esc, footer, n } from './html';

const PERIODS = [['today', 'DAILY'], ['mtd', 'MONTHLY'], ['utd', 'UTD']] as const;
const KIND_LABEL: Record<StandardKind, string> = { actual: 'ACTUAL STANDARD', bidding: 'BIDDING STANDARD' };

/** Daily / Monthly / UTD, each with Standard · Actual · Variance, for one standard. */
const periodCells = (r: ParamRowOut, kind: StandardKind, dp: number) =>
  PERIODS.map(([k]) => {
    const t = r.standards[kind][k];
    return `<td class="num">${n(t.std, dp)}</td><td class="num">${n(t.act, dp)}</td><td class="num ${cls(t.varFlag)}">${n(t.var, dp)}</td>`;
  }).join('');

const periodHead = (first: string, extra = '') =>
  `<tr><th rowspan="2">${first}</th><th rowspan="2">UNIT</th>${PERIODS.map(([, l]) => `<th colspan="3">${l}</th>`).join('')}${extra ? `<th rowspan="2">${extra}</th>` : ''}</tr>
   <tr>${PERIODS.map(() => '<th>STD</th><th>ACTUAL</th><th>VAR</th>').join('')}</tr>`;

/**
 * Simple MIS report. One page per standard shown (Actual / Bidding, per the plant's "standards shown" setting) with the
 * key-parameter and chemical tables, then one page for quality, guarantees, cash and staff.
 * The page count is not fixed: long tables flow onto the next page, so the footer carries no "page N of M".
 */
export function misHtml(m: MisReport, meta: { version: number; platform: string; logoUrl?: string | null }): string {
  const h = m.header;
  const kinds: StandardKind[] = h.standardsShown === 'both' ? ['actual', 'bidding'] : [h.standardsShown];

  const keyRows = (kind: StandardKind) => m.keyParameters.map((r) => {
    const dp = r.code === 'REVENUE' ? 2 : Math.min(r.decimals, 2);
    return `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${periodCells(r, kind, dp)}</tr>`;
  }).join('');
  const chemRows = (kind: StandardKind) => m.chemicals.map((r) =>
    `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${periodCells(r, kind, Math.min(r.decimals, 2))}
      <td class="num ${cls(r.balanceFlag)}">${n(r.balance, 2)}</td></tr>`).join('');

  const lab = (rows: MisReport['lab']['inlet']) => rows.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.unit)}</td>
      <td>${l.min !== null && l.max !== null ? `${n(l.min, 1)} – ${n(l.max, 1)}` : l.max !== null ? `≤ ${n(l.max)}` : '–'}</td>
      <td class="num ${cls(l.resultFlag)}">${n(l.act, l.decimals)}</td><td class="${cls(l.resultFlag)}">${esc(l.result ?? '–')}</td>
      <td class="num">${n(l.avg.mtd, l.decimals + 1)}</td><td class="num">${n(l.avg.utd, l.decimals + 1)}</td>
      <td class="num ${l.events.mtd ? 'bad' : ''}">${l.events.mtd}</td><td class="num ${l.events.utd ? 'bad' : ''}">${l.events.utd}</td></tr>`).join('');

  const reg = (rows: MisReport['registers']['bankGuarantees'], bg: boolean) => rows.map((r) => {
    const x = r as typeof r & { number?: string; party?: string; start?: string; end?: string; amount?: number | null; premium?: number | null; sumAssured?: number | null };
    return x.status === 'NOT_AVAILABLE' && !x.number
      ? `<tr><td>${esc(r.label)}</td><td colspan="${bg ? 6 : 6}" class="muted">Not available</td><td class="bad">NOT AVAILABLE</td></tr>`
      : `<tr><td>${esc(r.label)}</td><td>${esc(x.party)}</td><td>${esc(x.number)}</td><td>${dt(x.start)}</td><td>${dt(x.end)}</td>
         <td>${bg ? dt(r.claimUpTo) : n(x.premium)}</td><td class="num">${bg ? n(x.amount) : n(x.sumAssured)}</td>
         <td class="${r.status === 'VALID' ? 'ok' : 'bad'}">${r.status}</td></tr>`;
  }).join('');

  const staff = m.staff.rows.map((s) => `<tr><td>${esc(s.category)}</td><td class="num">${s.contract}</td><td class="num">${n(s.vacant)}</td>
      <td class="num">${n(s.present)}</td><td class="num">${n(s.leave)}</td><td class="num ${cls(s.absentFlag)}">${n(s.absent)}</td></tr>`).join('');
  const safety = m.safety.rows.map((s) => `<tr><td>${esc(s.item)}</td><td class="num">${s.required}</td><td class="num">${n(s.actual)}</td>
      <td class="num ${cls(s.deficitFlag)}">${n(s.deficit)}</td></tr>`).join('');

  const pageHeader = `<div class="hdr">
    <div>${meta.logoUrl ? `<img src="${esc(meta.logoUrl)}" style="height:28px">` : ''}</div>
    <div style="text-align:center">
      <h1 style="font-size:14px">${esc(h.companyName)}</h1>
      <div>MIS for site: <b>${esc(h.plantName)}</b> · Client: <b>${esc(h.clientName)}</b></div>
      <div>MIS data from ${dt(h.misStart)} · O&amp;M ${dt(h.omStart)} – ${dt(h.omEnd)} (${h.tenureMonths} MONTHS) · O&amp;M month ${h.omMonthNo} · Year ${esc(h.omYearNo)}</div>
    </div>
    <div style="text-align:right">
      Report date <b>${dt(h.reportDate)}</b><br>MTD days ${h.mtdDays} · UTD days ${h.utdDays}<br>
      <span class="muted">MTD: ${h.mtdDataDays} of ${h.mtdDays} days submitted · UTD: ${h.utdDataDays} of ${h.utdDays}${h.lastCorrectedAt ? ` · Last corrected ${esc(h.lastCorrectedAt.slice(0, 10))}` : ''}</span>
    </div>
  </div>`;

  const footerMeta = { generatedAt: m.meta.generatedAt, version: meta.version,
    status: h.logsheet ? `${h.logsheet.status} v${h.logsheet.version}` : 'No logsheet', platform: meta.platform };

  const standardPages = kinds.map((kind) => `
    <section class="page">${pageHeader}
      <section><h3>KEY PARAMETERS — ${KIND_LABEL[kind]}</h3><table>${periodHead('PARAMETER')}${keyRows(kind)}</table></section>
      ${m.chemicals.length ? `<section><h3>CHEMICALS &amp; CONSUMABLES — ${KIND_LABEL[kind]}</h3><table>${periodHead('ITEM', 'BALANCE')}${chemRows(kind)}</table></section>` : ''}
      ${footer(footerMeta, 1, 0)}
    </section>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    @page { size: A4 landscape; margin: 8mm; }
    body { font-size: 8px; }
    .page { break-after: page; }
    .page:last-child { break-after: auto; }
    section, table { break-inside: avoid; }
    .hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; border-bottom: 1px solid #999; padding-bottom: 4px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
    section { margin-bottom: 6px; }
    h3 { font-size: 11px; background: #d9e1f2; padding: 2px 4px; margin-bottom: 2px; }
  </style></head><body>
    ${standardPages}

    <section class="page">${pageHeader}
      <div class="grid2">
        <section><h3>QUALITY – AT PLANT INLET</h3><table><tr><th>Parameter</th><th>UOM</th><th>STD</th><th>ACT</th><th>RESULT</th><th>Avg MTD</th><th>Avg UTD</th><th>Ev MTD</th><th>Ev UTD</th></tr>${lab(m.lab.inlet)}</table></section>
        <section><h3>QUALITY – AT PLANT OUTLET</h3><table><tr><th>Parameter</th><th>UOM</th><th>STD</th><th>ACT</th><th>RESULT</th><th>Avg MTD</th><th>Avg UTD</th><th>Ev MTD</th><th>Ev UTD</th></tr>${lab(m.lab.outlet)}</table></section>
      </div>
      <div class="grid2">
        <section><h3>BANK GUARANTEES</h3><table><tr><th>BG</th><th>Bank</th><th>BG no.</th><th>Start</th><th>End</th><th>Claim up to</th><th>Value</th><th>Status</th></tr>${reg(m.registers.bankGuarantees, true)}</table></section>
        <section><h3>SITE INSURANCE</h3><table><tr><th>Type</th><th>Insurer</th><th>Policy no.</th><th>Start</th><th>End</th><th>Premium</th><th>Sum assured</th><th>Status</th></tr>${reg(m.registers.insurance, false)}</table></section>
      </div>
      <div class="grid3" style="grid-template-columns: 1.2fr 1fr 1fr">
        <section><h3>SITE CASH &amp; LOCAL EXPENSES (INR)</h3><table><tr><th>Today</th><th>MTD</th><th>UTD</th><th>Received</th><th>In hand</th></tr>
          <tr><td class="num">${n(m.cash.today)}</td><td class="num">${n(m.cash.mtd)}</td><td class="num">${n(m.cash.utd)}</td><td class="num">${n(m.cash.received)}</td><td class="num">${n(m.cash.inHand)}</td></tr>
          <tr><td colspan="5">${esc(m.cash.description ?? '')}</td></tr>
        </table></section>
        <section><h3>STAFF ATTENDANCE</h3><table><tr><th>Category</th><th>Contract</th><th>Vacant</th><th>Present</th><th>Leave</th><th>Absent</th></tr>${staff}
          <tr><th>Total</th><th>${n(m.staff.total.contract)}</th><th>${n(m.staff.total.vacant)}</th><th>${n(m.staff.total.present)}</th><th>${n(m.staff.total.leave)}</th><th>${n(m.staff.total.absent)}</th></tr>
        </table></section>
        <section><h3>SAFETY ITEMS</h3><table><tr><th>Item</th><th>Required</th><th>Actual</th><th>Deficit</th></tr>${safety}
          <tr><th>Total</th><th>${n(m.safety.total.required)}</th><th>${n(m.safety.total.actual)}</th><th>${n(m.safety.total.deficit)}</th></tr>
        </table></section>
      </div>
      ${footer(footerMeta, 1, 0)}
    </section>

  </body></html>`;
}
