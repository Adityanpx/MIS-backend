// table.ts
import type { ReportTable } from '../../reports/table';
import { BASE_CSS, esc, n } from './html';

export function tableHtml(t: ReportTable): string {
  const cell = (v: unknown) => (typeof v === 'number' ? `<td class="num">${n(v, 2)}</td>` : `<td>${esc(v ?? '')}</td>`);
  const rows = [...t.rows, ...(t.footer ?? [])].map((r) => `<tr>${t.columns.map((c) => cell(r[c.key])).join('')}</tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS} @page { size: A4 landscape; margin: 8mm; } body { font-size: 9px; }</style></head>
    <body><h2>${esc(t.title)}</h2><div class="muted">${esc(t.subtitle ?? '')}</div>
    <table><tr>${t.columns.map((c) => `<th>${esc(c.header)}</th>`).join('')}</tr>${rows}</table></body></html>`;
}
