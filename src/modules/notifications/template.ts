const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

export type TemplateVars = Record<string, string | number>;

/** Replaces {{name}} placeholders. HTML bodies get escaped values; text bodies and subjects get raw values. */
export function renderString(tpl: string, vars: TemplateVars, html: boolean): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) return '';
    const s = String(v);
    return html ? escapeHtml(s) : s;
  });
}
