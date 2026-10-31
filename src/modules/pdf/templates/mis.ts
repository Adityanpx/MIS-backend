import type { MisReport, ParamRowOut } from '../../engine/core/mis';
import { BASE_CSS, cls, dt, esc, footer, n, pctText } from './html';

const tripleCells = (r: ParamRowOut, dp: number) =>
  ['today', 'mtd', 'utd'].map((k) => {
    const t = r[k as 'today' | 'mtd' | 'utd'];
    return `<td class="num">${n(t.std, dp)}</td><td class="num">${n(t.act, dp)}</td><td class="num ${cls(t.varFlag)}">${n(t.var, dp)}</td>`;
  }).join('');

const head = '<th>STD</th><th>ACT</th><th>VAR</th>';

/**
 * Five-page MIS report per Schedule A Part 4(d).
 *
 * Each tab in `MisReport.tabs` renders on its own A4 landscape page, with a repeating header
 * on every page and a "Page N of 5" footer. Page 5 (Maintenance) always renders — a plant with
 * maintenance off shows a placeholder so the page count stays at 5 regardless of configuration.
 *
 * NOTE: the last `.page` section must NOT carry `break-after: page;` — Chromium would then emit
 * a trailing blank sixth page. The `:last-child` CSS rule cancels the break on the final page.
 */
export function misHtml(m: MisReport, meta: { version: number; platform: string; logoUrl?: string | null }): string {
  const h = m.header;

  const key = m.keyParameters.map((r) => {
    const dp = r.code === 'REVENUE' ? 2 : Math.min(r.decimals, 2);
    return `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${tripleCells(r, dp)}
      <td class="num">${n(r.avgPerDay.mtd, 2)}</td><td class="num">${n(r.avgPerDay.utd, 2)}</td>
      <td class="num ${r.events.mtd > 0 ? 'bad' : ''}">${r.events.mtd}</td><td class="num ${r.events.utd > 0 ? 'bad' : ''}">${r.events.utd}</td>
      <td class="num ${cls(r.utdResult.flag)}">${pctText(r.utdResult.pct)}</td><td class="${cls(r.utdResult.flag)}">${esc(r.utdResult.text ?? '–')}</td></tr>`;
  }).join('');

  const chem = m.chemicals.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>${tripleCells(r, 0)}
      <td class="num">${n(r.avgPerDay.mtd, 2)}</td><td class="num">${n(r.avgPerDay.utd, 2)}</td>
      <td class="num">${n(r.received)}</td><td class="num ${cls(r.balanceFlag)}">${n(r.balance, 2)}</td>
      <td class="num ${cls(r.utdResult.flag)}">${pctText(r.utdResult.pct)}</td><td class="${cls(r.utdResult.flag)}">${esc(r.utdResult.text ?? '–')}</td></tr>`).join('');

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

  // The .hdr block is rendered as the first child of every .page section. position: running() is
  // unreliable in Chromium's print pipeline, so repeating the block directly is both cheaper and
  // deterministic — no risk of a missing header on an edge-case page break.
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

  // Page 5 — Maintenance tab, or a placeholder when the plant has maintenance monitoring off.
  // The placeholder is critical: without it the PDF would be 4 pages, failing acceptance clause (d).
  const maint = m.tabs.maintenance;
  const page5Body = maint
    ? `<div class="grid3">
        <section><h3>F1. MACHINERY BREAKDOWN – OPEN NOW</h3><table><tr><th>Equipment</th><th>Criticality</th><th>Since</th><th>Status</th><th>Fault</th></tr>
          ${maint.openBreakdowns.map((b) => `<tr><td>${esc(b.equipmentName)}</td><td class="${b.criticality === 'critical' ? 'bad' : ''}">${esc(b.criticality)}</td><td>${dt(b.startedAt.slice(0, 10))}</td><td>${esc(b.status)}</td><td>${esc(b.fault)}</td></tr>`).join('')
            || '<tr><td colspan="5" class="muted">No open breakdowns</td></tr>'}</table></section>
        <section><h3>F2. MAINTENANCE – SUMMARY</h3><table><tr><th>Metric</th><th>MTD</th><th>UTD</th></tr>
          <tr><td>Breakdowns reported</td><td class="num">${n(maint.metrics.mtd.reported, 0)}</td><td class="num">${n(maint.metrics.utd.reported, 0)}</td></tr>
          <tr><td>Breakdowns restored</td><td class="num">${n(maint.metrics.mtd.restored, 0)}</td><td class="num">${n(maint.metrics.utd.restored, 0)}</td></tr>
          <tr><td>Downtime (hrs)</td><td class="num">${n(maint.metrics.mtd.downtimeHrs, 1)}</td><td class="num">${n(maint.metrics.utd.downtimeHrs, 1)}</td></tr>
          <tr><td>MTTR (hrs)</td><td class="num">${n(maint.metrics.mtd.mttrHrs, 1)}</td><td class="num">${n(maint.metrics.utd.mttrHrs, 1)}</td></tr>
          <tr><td>Availability</td><td class="num">${pctText(maint.metrics.mtd.availabilityPct)}</td><td class="num">${pctText(maint.metrics.utd.availabilityPct)}</td></tr>
          <tr><td>Critical open</td><td class="num ${maint.summary.criticalOpen > 0 ? 'bad' : ''}" colspan="2">${n(maint.summary.criticalOpen, 0)}</td></tr></table></section>
        <section><h3>F3. TOP DOWNTIME (MTD)</h3><table><tr><th>Equipment</th><th>Hours</th></tr>
          ${maint.topByDowntimeMtd.map((t) => `<tr><td>${esc(t.equipmentName)}</td><td class="num">${n(t.hours, 1)}</td></tr>`).join('')
            || '<tr><td colspan="2" class="muted">No downtime this month</td></tr>'}</table></section>
      </div>`
    : `<section><h3>F. MAINTENANCE MONITORING</h3>
         <p class="muted" style="padding:8px">Maintenance monitoring is not enabled for this plant. See Settings → Maintenance to enable the equipment register, breakdown log and alerts.</p>
       </section>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    @page { size: A4 landscape; margin: 10mm; }
    body { font-size: 8.5px; }
    .page { break-after: page; }
    .page:last-child { break-after: auto; }
    section, table { break-inside: avoid; }
    .hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; border-bottom: 1px solid #999; padding-bottom: 4px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
    section { margin-bottom: 6px; }
    h3 { font-size: 11px; background: #d9e1f2; padding: 2px 4px; margin-bottom: 2px; }
  </style></head><body>

    <section class="page">${pageHeader}
      <section><h3>A. KEY PARAMETERS MONITORING</h3><table>
        <tr><th rowspan="2">Key parameter</th><th rowspan="2">UOM</th><th colspan="3">TODAY</th><th colspan="3">MTD</th><th colspan="3">UTD</th><th colspan="2">AVG / DAY</th><th colspan="2">EVENTS</th><th colspan="2">UTD RESULT</th></tr>
        <tr>${head}${head}${head}<th>MTD</th><th>UTD</th><th>MTD</th><th>UTD</th><th>%</th><th>RESULT</th></tr>
        ${key}
      </table></section>
      ${footer(footerMeta, 1, 5)}
    </section>

    <section class="page">${pageHeader}
      <section><h3>B. CHEMICALS &amp; CONSUMABLES</h3><table>
        <tr><th rowspan="2">Item</th><th rowspan="2">UOM</th><th colspan="3">TODAY</th><th colspan="3">MTD</th><th colspan="3">UTD</th><th colspan="2">AVG / DAY</th><th colspan="2">STOCK</th><th colspan="2">UTD RESULT</th></tr>
        <tr>${head}${head}${head}<th>MTD</th><th>UTD</th><th>New received</th><th>Final balance</th><th>%</th><th>RESULT</th></tr>
        ${chem}
      </table></section>
      ${footer(footerMeta, 2, 5)}
    </section>

    <section class="page">${pageHeader}
      <div class="grid2">
        <section><h3>C1. QUALITY – AT PLANT INLET</h3><table><tr><th>Parameter</th><th>UOM</th><th>STD</th><th>ACT</th><th>RESULT</th><th>Avg MTD</th><th>Avg UTD</th><th>Ev MTD</th><th>Ev UTD</th></tr>${lab(m.lab.inlet)}</table></section>
        <section><h3>C2. QUALITY – AT PLANT OUTLET</h3><table><tr><th>Parameter</th><th>UOM</th><th>STD</th><th>ACT</th><th>RESULT</th><th>Avg MTD</th><th>Avg UTD</th><th>Ev MTD</th><th>Ev UTD</th></tr>${lab(m.lab.outlet)}</table></section>
      </div>
      <div class="grid2">
        <section><h3>D1. BANK GUARANTEES</h3><table><tr><th>BG</th><th>Bank</th><th>BG no.</th><th>Start</th><th>End</th><th>Claim up to</th><th>Value</th><th>Status</th></tr>${reg(m.registers.bankGuarantees, true)}</table></section>
        <section><h3>D2. SITE INSURANCE</h3><table><tr><th>Type</th><th>Insurer</th><th>Policy no.</th><th>Start</th><th>End</th><th>Premium</th><th>Sum assured</th><th>Status</th></tr>${reg(m.registers.insurance, false)}</table></section>
      </div>
      ${footer(footerMeta, 3, 5)}
    </section>

    <section class="page">${pageHeader}
      <div class="grid3" style="grid-template-columns: 1.2fr 1fr 1fr">
        <section><h3>E1. SITE CASH &amp; LOCAL EXPENSES (INR)</h3><table><tr><th>Today</th><th>MTD</th><th>UTD</th><th>Received</th><th>In hand</th></tr>
          <tr><td class="num">${n(m.cash.today)}</td><td class="num">${n(m.cash.mtd)}</td><td class="num">${n(m.cash.utd)}</td><td class="num">${n(m.cash.received)}</td><td class="num">${n(m.cash.inHand)}</td></tr>
          <tr><td colspan="5">${esc(m.cash.description ?? '')}</td></tr>
        </table></section>
        <section><h3>E2. STAFF ATTENDANCE</h3><table><tr><th>Category</th><th>Contract</th><th>Vacant</th><th>Present</th><th>Leave</th><th>Absent</th></tr>${staff}
          <tr><th>Total</th><th>${n(m.staff.total.contract)}</th><th>${n(m.staff.total.vacant)}</th><th>${n(m.staff.total.present)}</th><th>${n(m.staff.total.leave)}</th><th>${n(m.staff.total.absent)}</th></tr>
        </table></section>
        <section><h3>E3. SAFETY ITEMS</h3><table><tr><th>Item</th><th>Required</th><th>Actual</th><th>Deficit</th></tr>${safety}
          <tr><th>Total</th><th>${n(m.safety.total.required)}</th><th>${n(m.safety.total.actual)}</th><th>${n(m.safety.total.deficit)}</th></tr>
        </table></section>
      </div>
      ${footer(footerMeta, 4, 5)}
    </section>

    <section class="page">${pageHeader}
      ${page5Body}
      ${footer(footerMeta, 5, 5)}
    </section>

  </body></html>`;
}
