// logsheet.ts
import type { Bundle } from '../../engine/core/mis';
import { standardAt, valueAt } from '../../engine/core/effective';
import { dayValue } from '../../engine/core/derive';
import { eventOn } from '../../engine/core/stats';
import { BASE_CSS, dt, esc, footer, n } from './html';

const BLOCKS: Record<number, string> = { 1: 'KEY PLANT PARAMETERS', 2: 'CHEMICALS & CONSUMABLES', 3: 'INLET LAB', 4: 'OUTLET LAB',
  5: 'SAFETY ITEMS', 6: 'STAFF ATTENDANCE', 7: 'SITE CASH', 8: 'OTHER' };

export function logsheetHtml(b: Bundle, d: string, meta: { version: number; platform: string; generatedAt: string; logoUrl?: string | null }): string {
  const s = b.settings;
  const rec = b.data.days.get(d);
  const blocks = [...new Set(s.params.map((p) => p.block))].sort((a, x) => a - x).map((block) => {
    const rows = s.params.filter((p) => p.block === block && (!p.activeTo || p.activeTo >= d)).sort((a, x) => a.order - x.order).map((p) => {
      const v = p.aggregation === 'text' ? (rec?.values[p.code] as string | null) ?? '' : dayValue(b.data, b.derived, p.code, d);
      const st = standardAt(p, d, s.primaryStandard);
      const safety = s.safety.find((i) => i.id === p.safetyItemId);
      const std = safety ? valueAt(safety.required, d) : st?.std ?? (st?.max != null ? `≤ ${st.max}` : null);
      const warn = typeof v === 'number' && eventOn(s, p, d, v, s.primaryStandard);
      return `<tr><td>${esc(p.name)}</td><td>${esc(p.unit)}</td><td class="num">${typeof std === 'number' ? n(std, 2) : esc(std ?? '–')}</td>
        <td class="num ${warn ? 'bad' : ''}">${typeof v === 'number' ? n(v, p.decimals) : esc(v)}</td></tr>`;
    }).join('');
    return `<h3>${esc(BLOCKS[block] ?? `BLOCK ${block}`)}</h3><table><tr><th>Field</th><th>Unit</th><th>Standard</th><th>Value</th></tr>${rows}</table>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS} @page { size: A4 portrait; margin: 8mm; } body { font-size: 8.5px; }
    h3 { font-size: 9.5px; margin: 4px 0 2px; } .cols { columns: 2; column-gap: 8px; } table { break-inside: avoid; }
    .sig { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; } .sig div { border-top: 1px solid #333; padding-top: 2px; }</style></head><body>
    <div style="display:flex;justify-content:space-between"><div>${meta.logoUrl ? `<img src="${esc(meta.logoUrl)}" style="height:28px">` : ''}</div>
      <div style="text-align:center"><h1 style="font-size:13px">${esc(s.display.logsheetTitle)}</h1><div>${esc(s.display.companyName)}</div></div>
      <div style="text-align:right">Date <b>${dt(d)}</b><br>Status ${esc(rec?.status ?? 'No logsheet')}${rec ? ` v${rec.version}` : ''}</div></div>
    <div class="cols">${blocks}</div>
    <div class="sig"><div>${esc(s.display.sigPrepared)}<br>${esc(rec?.submittedByName ?? '')} ${esc(rec?.submittedAt?.slice(0, 16).replace('T', ' ') ?? '')}</div>
      <div>${esc(s.display.sigChecked)}</div><div>${esc(s.display.sigVerified)}</div></div>
    ${footer({ generatedAt: meta.generatedAt, version: meta.version, status: rec?.status ?? 'none', platform: meta.platform })}</body></html>`;
}
