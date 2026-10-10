import type { MisReport, ParamRowOut } from '../../engine/core/mis';
import { BASE_CSS, cls, dt, esc, footer, n, pctText } from './html';

const tripleCells = (r: ParamRowOut, dp: number) =>
  ['today', 'mtd', 'utd'].map((k) => {
    const t = r[k as 'today' | 'mtd' | 'utd'];
    return `<td class="num">${n(t.std, dp)}</td><td class="num">${n(t.act, dp)}</td><td class="num ${cls(t.varFlag)}">${n(t.var, dp)}</td>`;
  }).join('');

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
  const head = '<th>STD</th><th>ACT</th><th>VAR</th>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    @page { size: A3 landscape; margin: 8mm; } body { font-size: 9.5px; }
    .hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; } .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    section { margin-bottom: 5px; } h3 { font-size: 11px; background: #d9e1f2; padding: 2px 4px; }</style></head><body>
    <div class="hdr"><div>${meta.logoUrl ? `<img src="${esc(meta.logoUrl)}" style="height:34px">` : ''}</div>
      <div style="text-align:center"><h1 style="font-size:15px">${esc(h.companyName)}</h1>
        <div>MIS for site: <b>${esc(h.plantName)}</b> · Client: <b>${esc(h.clientName)}</b></div>
        <div>MIS data from ${dt(h.misStart)} · O&amp;M ${dt(h.omStart)} – ${dt(h.omEnd)} (${h.tenureMonths} MONTHS) · O&amp;M month ${h.omMonthNo} · Year ${esc(h.omYearNo)}</div></div>
      <div style="text-align:right">Report date <b>${dt(h.reportDate)}</b><br>MTD days ${h.mtdDays} · UTD days ${h.utdDays}<br>
        <span class="muted">MTD: ${h.mtdDataDays} of ${h.mtdDays} days submitted · UTD: ${h.utdDataDays} of ${h.utdDays}${h.lastCorrectedAt ? ` · Last corrected ${esc(h.lastCorrectedAt.slice(0, 10))}` : ''}</span></div></div>
    <section><h3>A. KEY PARAMETERS MONITORING</h3><table><tr><th rowspan="2">Key parameter</th><th rowspan="2">UOM</th><th colspan="3">TODAY</th><th colspan="3">MTD</th><th colspan="3">UTD</th>
      <th colspan="2">AVG / DAY</th><th colspan="2">EVENTS</th><th colspan="2">UTD RESULT</th></tr>
      <tr>${head}${head}${head}<th>MTD</th><th>UTD</th><th>MTD</th><th>UTD</th><th>%</th><th>RESULT</th></tr>${key}</table></section>
    <section><h3>B. CHEMICALS &amp; CONSUMABLES</h3><table><tr><th rowspan="2">Item</th><th rowspan="2">UOM</th><th colspan="3">TODAY</th><th colspan="3">MTD</th><th colspan="3">UTD</th>
      <th colspan="2">AVG / DAY</th><th colspan="2">STOCK</th><th colspan="2">UTD RESULT</th></tr>
      <tr>${head}${head}${head}<th>MTD</th><th>UTD</th><th>New received</th><th>Final balance</th><th>%</th><th>RESULT</th></tr>${chem}</table></section>
    <div class="grid"><section><h3>C. QUALITY – AT PLANT INLET</h3><table><tr><th>Parameter</th><th>UOM</th><th>STD</th><th>ACT</th><th>RESULT</th><th>Avg MTD</th><th>Avg UTD</th><th>Ev MTD</th><th>Ev UTD</th></tr>${lab(m.lab.inlet)}</table></section>
      <section><h3>C. QUALITY – AT PLANT OUTLET</h3><table><tr><th>Parameter</th><th>UOM</th><th>STD</th><th>ACT</th><th>RESULT</th><th>Avg MTD</th><th>Avg UTD</th><th>Ev MTD</th><th>Ev UTD</th></tr>${lab(m.lab.outlet)}</table></section></div>
    <div class="grid"><section><h3>D. BANK GUARANTEES</h3><table><tr><th>BG</th><th>Bank</th><th>BG no.</th><th>Start</th><th>End</th><th>Claim up to</th><th>Value</th><th>Status</th></tr>${reg(m.registers.bankGuarantees, true)}</table></section>
      <section><h3>D. SITE INSURANCE</h3><table><tr><th>Type</th><th>Insurer</th><th>Policy no.</th><th>Start</th><th>End</th><th>Premium</th><th>Sum assured</th><th>Status</th></tr>${reg(m.registers.insurance, false)}</table></section></div>
    <div class="grid" style="grid-template-columns: 1.2fr 1fr 1fr"><section><h3>E. SITE CASH &amp; LOCAL EXPENSES (INR)</h3><table><tr><th>Today</th><th>MTD</th><th>UTD</th><th>Received</th><th>In hand</th></tr>
        <tr><td class="num">${n(m.cash.today)}</td><td class="num">${n(m.cash.mtd)}</td><td class="num">${n(m.cash.utd)}</td><td class="num">${n(m.cash.received)}</td><td class="num">${n(m.cash.inHand)}</td></tr>
        <tr><td colspan="5">${esc(m.cash.description ?? '')}</td></tr></table></section>
      <section><h3>E. STAFF ATTENDANCE</h3><table><tr><th>Category</th><th>Contract</th><th>Vacant</th><th>Present</th><th>Leave</th><th>Absent</th></tr>${staff}
        <tr><th>Total</th><th>${n(m.staff.total.contract)}</th><th>${n(m.staff.total.vacant)}</th><th>${n(m.staff.total.present)}</th><th>${n(m.staff.total.leave)}</th><th>${n(m.staff.total.absent)}</th></tr></table></section>
      <section><h3>E. SAFETY ITEMS</h3><table><tr><th>Item</th><th>Required</th><th>Actual</th><th>Deficit</th></tr>${safety}
        <tr><th>Total</th><th>${n(m.safety.total.required)}</th><th>${n(m.safety.total.actual)}</th><th>${n(m.safety.total.deficit)}</th></tr></table></section></div>
    ${footer({ generatedAt: m.meta.generatedAt, version: meta.version, status: h.logsheet ? `${h.logsheet.status} v${h.logsheet.version}` : 'No logsheet', platform: meta.platform })}
  </body></html>`;
}
