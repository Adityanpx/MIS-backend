import type { Flag } from '../../engine/core/types';
import { formatDisplayDate } from '../../../lib/dates';
import { formatIndian } from '../../../shared/format';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c] ?? c);
/** Display rounding per §13.12 (storage keeps full precision). */
export const n = (v: number | null | undefined, dp = 0) => (v === null || v === undefined || Number.isNaN(v) ? '–' : formatIndian(v, dp));
export const pctText = (v: number | null, dp = 0) => (v === null ? '–' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(dp)}%`);
export const cls = (f: Flag | undefined) => (f === 'bad' ? 'bad' : f === 'ok' ? 'ok' : '');
export const dt = (d: string | null | undefined) => (d ? formatDisplayDate(d) : '–');
export const BASE_CSS = `
  * { box-sizing: border-box; } body { font-family: 'Noto Sans', Arial, Helvetica, sans-serif; margin: 0; color: #111; }
  table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #555; padding: 2px 4px; }
  th { background: #1f3864; color: #fff; font-weight: 600; } .bad { color: #c00000; font-weight: 700; } .ok { color: #1f4e9a; }
  .num { text-align: right; } .muted { color: #666; } h1, h2, h3 { margin: 0; }
  .footer { position: fixed; bottom: 4mm; left: 8mm; right: 8mm; font-size: 8px; color: #666; display: flex; justify-content: space-between; }`;
export function footer(meta: { generatedAt: string; version: number; status: string; platform: string }): string {
  return `<div class="footer"><span>Generated ${esc(meta.generatedAt.replace('T', ' ').slice(0, 16))} UTC by ${esc(meta.platform)}</span>
    <span>Version v${meta.version} · Logsheet: ${esc(meta.status)}</span><span>Page 1 of 1</span></div>`;
}
