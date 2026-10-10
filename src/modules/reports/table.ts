import ExcelJS from 'exceljs';

export interface Column { key: string; header: string; numFmt?: string; width?: number }
export interface ReportTable {
  title: string;
  subtitle?: string;
  columns: Column[];
  rows: Array<Record<string, string | number | null>>;
  footer?: Array<Record<string, string | number | null>>;
  meta?: Record<string, unknown>;
}

/** EXP-05: every report can be exported to Excel. Numbers stay numbers (Indian grouping via numFmt). */
export async function tableToXlsx(t: ReportTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OMMIS';
  const ws = wb.addWorksheet(t.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  ws.addRow([t.title]).font = { bold: true, size: 13 };
  if (t.subtitle) ws.addRow([t.subtitle]);
  ws.addRow([]);
  const head = ws.addRow(t.columns.map((c) => c.header));
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }; });
  for (const r of [...t.rows, ...(t.footer ?? [])]) ws.addRow(t.columns.map((c) => r[c.key] ?? null));
  t.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width ?? Math.max(12, c.header.length + 2);
    if (c.numFmt) col.numFmt = c.numFmt;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
export const NUM0 = '#,##,##0';
export const NUM2 = '#,##,##0.00';
