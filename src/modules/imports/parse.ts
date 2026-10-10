import ExcelJS from 'exceljs';
import { isISODate } from '../../lib/dates';

/** IMP-01: built-in mapping of the old workbook's DATA ENTRY sheet (data from row 7, date in column B). */
export const DATA_ENTRY_MAP: Record<string, string> = {
  H: 'INFLOW', J: 'EB_KWH', K: 'PF', M: 'BGE_HRS', N: 'BGE_KWH', P: 'DG_HRS',
  R: 'DIESEL_CONSUMED', S: 'DIESEL_RECEIVED', V: 'POLY_CONSUMED', W: 'POLY_RECEIVED', Z: 'CHLORINE_CONSUMED',
  AA: 'CHLORINE_RECEIVED', AD: 'LIME_CONSUMED', AE: 'LIME_RECEIVED', AH: 'ALUM_CONSUMED', AI: 'ALUM_RECEIVED',
  AL: 'IN_PH', AM: 'IN_BOD', AN: 'IN_COD', AO: 'IN_TSS', AP: 'IN_FC', AR: 'OUT_PH', AS: 'OUT_BOD', AT: 'OUT_COD',
  AU: 'OUT_TSS', AV: 'OUT_FC', AX: 'SAFE_HELMET', AY: 'SAFE_SHOES', AZ: 'SAFE_BELT',
  BC: 'STAFF_PAYROLL_VACANT', BD: 'STAFF_PAYROLL_PRESENT', BE: 'STAFF_PAYROLL_LEAVE',
  BI: 'STAFF_FTC_VACANT', BJ: 'STAFF_FTC_PRESENT', BK: 'STAFF_FTC_LEAVE',
  BO: 'STAFF_TP_VACANT', BP: 'STAFF_TP_PRESENT', BQ: 'STAFF_TP_LEAVE',
  BT: 'CASH_EXPENSE', BU: 'CASH_RECEIVED', BW: 'CASH_DESC',
};
/** Row-7 balance columns → used to suggest openings as of the day BEFORE the first date (IMP-05, §13.7). */
const BALANCE_COLS: Record<string, { balance: string; consumed: string; received: string }> = {
  DIESEL: { balance: 'T', consumed: 'R', received: 'S' }, POLY: { balance: 'X', consumed: 'V', received: 'W' },
  CHLORINE: { balance: 'AB', consumed: 'Z', received: 'AA' }, LIME: { balance: 'AF', consumed: 'AD', received: 'AE' },
  ALUM: { balance: 'AJ', consumed: 'AH', received: 'AI' },
};

export interface ParsedRow { row: number; date: string; values: Record<string, number | string | null> }
export interface Issue { row: number; column: string; code?: string; message: string; value?: unknown }
export interface ParseResult {
  rows: ParsedRow[]; errors: Issue[]; conversions: Issue[];
  suggestedOpenings: { stock: Record<string, number>; cash: number | null; asOf: string | null };
}

function cellValue(c: ExcelJS.Cell): unknown {
  const v = c.value as unknown;
  if (v && typeof v === 'object' && 'result' in (v as Record<string, unknown>)) return (v as { result: unknown }).result; // formula
  if (v && typeof v === 'object' && 'richText' in (v as Record<string, unknown>)) {
    return (v as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('');
  }
  return v;
}
function toDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && isISODate(v.trim())) return v.trim();
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000).toISOString().slice(0, 10);
  return null;
}

export async function parseWorkbook(buf: Buffer, mapping: 'template' | 'excel_data_entry', textCodes: Set<string>): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = mapping === 'excel_data_entry' ? wb.getWorksheet('DATA ENTRY') : wb.worksheets[0];
  const out: ParseResult = { rows: [], errors: [], conversions: [], suggestedOpenings: { stock: {}, cash: null, asOf: null } };
  if (!ws) {
    out.errors.push({ row: 0, column: '', message: mapping === 'excel_data_entry' ? 'Sheet "DATA ENTRY" not found' : 'The workbook is empty' });
    return out;
  }
  let columns: Array<{ col: string; code: string }>;
  let firstRow: number;
  let dateCol: string;
  if (mapping === 'excel_data_entry') {
    columns = Object.entries(DATA_ENTRY_MAP).map(([col, code]) => ({ col, code }));
    firstRow = 7;
    dateCol = 'B';
  } else {
    const header = ws.getRow(1);
    columns = [];
    dateCol = 'A';
    header.eachCell((c, i) => {
      const name = String(cellValue(c) ?? '').trim().toUpperCase();
      const col = ws.getColumn(i).letter;
      if (name === 'DATE') dateCol = col;
      else if (/^[A-Z][A-Z0-9_]+$/.test(name)) columns.push({ col, code: name });
    });
    firstRow = 2;
  }
  for (let r = firstRow; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const date = toDate(cellValue(row.getCell(dateCol)));
    if (!date) {
      if (cellValue(row.getCell(dateCol)) === null || cellValue(row.getCell(dateCol)) === undefined) break; // end of data
      out.errors.push({ row: r, column: dateCol, message: 'Invalid date' });
      continue;
    }
    const values: ParsedRow['values'] = {};
    let any = false;
    for (const { col, code } of columns) {
      const v = cellValue(row.getCell(col));
      if (v === null || v === undefined || v === '') {
        values[code] = null;
        continue;
      }
      any = true;
      if (textCodes.has(code)) {
        values[code] = String(v).slice(0, 1000);
      } else if (typeof v === 'number') {
        values[code] = v;
      } else if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) {
        values[code] = Number(v);
        out.conversions.push({ row: r, column: col, code, message: `Number stored as text '${v}' converted`, value: v });
      } else {
        values[code] = null;
        out.errors.push({ row: r, column: col, code, message: 'Not a number', value: v });
      }
    }
    if (!any) break; // DATA ENTRY pre-fills future dates without values
    if (r === firstRow && mapping === 'excel_data_entry') {
      out.suggestedOpenings.asOf = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      for (const [item, c] of Object.entries(BALANCE_COLS)) {
        const bal = Number(cellValue(row.getCell(c.balance)) ?? NaN);
        if (Number.isFinite(bal)) {
          out.suggestedOpenings.stock[item] = bal + (Number(values[`${item}_CONSUMED`]) || 0) - (Number(values[`${item}_RECEIVED`]) || 0);
        }
      }
      const cash = Number(cellValue(row.getCell('BV')) ?? NaN);
      if (Number.isFinite(cash)) out.suggestedOpenings.cash = cash + (Number(values.CASH_EXPENSE) || 0) - (Number(values.CASH_RECEIVED) || 0);
    }
    out.rows.push({ row: r, date, values });
  }
  return out;
}
