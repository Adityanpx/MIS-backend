import type { Dashboard } from '../../engine/core/dashboard';
import { chartSvg } from './charts';
import { BASE_CSS, cls, dt, esc, footer, n, pctText } from './html';

type Card = NonNullable<Dashboard['keyParameters'][number]>;
const badge = (b: { pct: number | null; arrow: string | null; colour: string }) =>
  `<span style="color:${b.colour === 'red' ? '#c00000' : b.colour === 'blue' ? '#1f4e9a' : '#777'}">${b.arrow === 'up' ? '▲' : b.arrow === 'down' ? '▼' : ''} ${pctText(b.pct, 1)}</span>`;
const card = (c: Card, dp: number) => `<div class="card"><div class="t">${esc(c.title)} <span class="muted">(${esc(c.unit)})</span></div>
  <div class="big">${n(c.bigNumber, dp)}</div>
  <div>MTD ${n(c.mtd.value, dp)} ${badge(c.mtd)}</div><div>UTD ${n(c.utd.value, dp)} ${badge(c.utd)}</div>
  <div>Events MTD <b class="${c.events.mtd ? 'bad' : ''}">${c.events.mtd}</b> · UTD <b class="${c.events.utd ? 'bad' : ''}">${c.events.utd}</b></div>
  ${chartSvg(c.chart)}</div>`;

export function dashboardHtml(d: Dashboard, meta: { version: number; platform: string; generatedAt: string; logoUrl?: string | null }): string {
  const lab = d.quality.map((q) => `<div class="card"><div class="t">${esc(q.title)} (${esc(q.unit)})</div><div class="big ${cls(q.resultFlag)}">${n(q.bigNumber, 1)}</div>
    <div>STD ${q.min !== null ? `${n(q.min, 1)} to ` : '≤ '}${n(q.max, 1)}</div><div class="${cls(q.resultFlag)}">${esc(q.result ?? '–')}</div>
    <div>Events MTD ${q.events.mtd} · UTD ${q.events.utd}</div>${chartSvg(q.chart)}</div>`).join('');
  const regs = [...d.registers.bankGuarantees, ...d.registers.insurance].map((r) =>
    `<div class="mini"><b>${esc(r.label)}</b><br><span class="${r.status === 'VALID' ? 'ok' : 'bad'}">${r.status}</span><br>${dt((r as { end?: string }).end)}</div>`).join('');
  const staff = d.staff.map((s) => `<div class="mini"><b>${esc(s.category)}</b><br>Present ${n(s.present)}<br>Absent <span class="${cls(s.absentFlag)}">${n(s.absent)}</span></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    @page { size: A3 portrait; margin: 8mm; } body { font-size: 10px; } .row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; margin-bottom: 6px; }
    .card { border: 1px solid #9db3d6; border-radius: 6px; padding: 4px; } .t { font-weight: 700; font-size: 10px; } .big { font-size: 20px; font-weight: 700; }
    .mini { border: 1px solid #9db3d6; border-radius: 6px; padding: 4px; text-align: center; } h2 { font-size: 12px; background: #1f3864; color: #fff; padding: 3px 6px; margin: 6px 0 4px; }
    svg { width: 100%; height: auto; }</style></head><body>
    <div style="display:flex;justify-content:space-between;align-items:center"><div>${meta.logoUrl ? `<img src="${esc(meta.logoUrl)}" style="height:36px">` : ''}</div>
      <div style="text-align:center"><h1 style="font-size:18px">${esc(d.header.title)}</h1><div>${esc(d.header.subtitle)}</div></div>
      <div style="text-align:right">Reporting date <b>${dt(d.header.reportDate)}</b><br>${esc(d.header.reportMonth)}<br><i>${esc(d.header.tagline)}</i></div></div>
    <h2>KEY PARAMETERS MONITORING</h2><div class="row">${d.keyParameters.map((c) => card(c!, c!.code === 'REVENUE' ? 2 : 0)).join('')}</div>
    <h2>CHEMICALS / CONSUMABLES</h2><div class="row">${d.chemicals.map((c) => card(c!, c!.code.startsWith('DIESEL') ? 2 : 0)).join('')}</div>
    <h2>QUALITY CONTROL &amp; COMPLIANCE (OUTLET)</h2><div class="row">${lab}</div>
    <h2>BG, INSURANCE, ATTENDANCE &amp; SITE CASH</h2><div class="row" style="grid-template-columns: repeat(8, 1fr)">${regs}${staff}
      <div class="mini"><b>Site cash</b><br>Today ${n(d.cash.today)}<br>MTD ${n(d.cash.mtd)}<br>UTD ${n(d.cash.utd)}</div></div>
    ${d.cash.chart ? `<div style="width:40%">${chartSvg(d.cash.chart)}</div>` : ''}
    ${footer({ generatedAt: meta.generatedAt, version: meta.version, status: d.header.logsheet ? d.header.logsheet.status : 'No logsheet', platform: meta.platform })}
  </body></html>`;
}
