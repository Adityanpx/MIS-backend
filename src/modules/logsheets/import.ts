/**
 * Excel import for Daily Logsheets.
 *
 *   1) GET  /import/template?from=YYYY-MM-DD&to=YYYY-MM-DD
 *      Streams a workbook with one row per date, one column per typed parameter, the standard
 *      row locked below each header, and a hidden `_meta` sheet carrying the plant id and the
 *      column → parameter-code mapping (so renames and reorders by the user are tolerated).
 *
 *   2) POST /import/preview   (multipart: file + from + to)
 *      Parses the workbook, validates every row against the same rules submit() runs, and
 *      returns a per-file report: errors, warnings and the list of dates that already have
 *      a logsheet (conflicts).
 *
 *   3) POST /import   (multipart: file + from + to + conflict=use_excel|keep_existing)
 *      Re-validates then saves every day in ONE transaction. Existing submitted/corrected
 *      days are rewritten with a correction history entry, drafts are promoted to submitted,
 *      missing days are inserted as submitted. If any row has an error the whole file is
 *      rejected — the user fixes it and uploads again.
 *
 * No AI anywhere: every check is a plain rule read from the engine settings bundle.
 */
import ExcelJS from 'exceljs';
import type { Buffer as NodeBuffer } from 'node:buffer';
import { exec, many, one } from '../../db/sql';
import { withTenant, type Tx } from '../../db/tenant';
import { tenantTx } from '../../lib/context';
import { addDays, diffDays, todayIST } from '../../lib/dates';
import { conflict, unprocessable } from '../../lib/errors';
import type { RequestMeta } from '../../lib/request-meta';
import type { ClientCtx, PlantCtx } from '../../types/express';
import { clientActor, writeAudit } from '../audit/audit.service';
import { standardAt, valueAt } from '../engine/core/effective';
import type { DerivedMap, EngineSettings, ParamDef } from '../engine/core/types';
import { getBundle } from '../engine/engine.service';
import { bumpVersions, markPdfsStale, requestRecalc } from '../settings/versions';
import { dateRule, typedParams, validateValues, type Values } from './validation';

// ──────────────────────────────────────────────────────────────── types

export type ConflictPolicy = 'use_excel' | 'keep_existing';

export interface ImportIssue {
  date: string;
  code: string;          // param code, 'DATE' for row-level issues, '_FILE' for workbook-level
  name: string;
  message: string;
}
export interface ImportConflictRow { date: string; status: string }
export interface ImportPreview {
  from: string;
  to: string;
  rows: number;                        // rows read from the file
  rowsReady: number;                   // rows with no hard errors
  errors: ImportIssue[];
  warnings: ImportIssue[];             // informational — do not block
  conflicts: ImportConflictRow[];      // dates that already have a logsheet
  /** whole-file flag — true when errors.length === 0 */
  ok: boolean;
}
export interface ImportResult {
  from: string;
  to: string;
  saved: number;
  skipped: number;      // conflicts the user chose to keep
  corrected: number;    // existing-submitted days rewritten
  inserted: number;     // brand-new days
  dataVersion: number;
  warnings: ImportIssue[];
}

// ──────────────────────────────────────────────────────────────── template

const DATE_HDR = 'Date';
const META_SHEET = '_meta';
const DATA_SHEET = 'Logsheets';

/** How the standard reads at the top of each column (one or many entries when it changes mid-range). */
function standardCellText(s: EngineSettings, p: ParamDef, from: string, to: string): string {
  if (p.aggregation === 'text') return '—';
  const safety = s.safety.find((i) => i.id === p.safetyItemId);
  const atDate = (d: string): string => {
    if (safety) {
      const req = valueAt(safety.required, d);
      return req === undefined || req === null ? '—' : `Req ${req}`;
    }
    const st = standardAt(p, d, s.primaryStandard);
    if (!st) return '—';
    if (p.stdType === 'range') {
      if (st.min !== null && st.max !== null) return `${st.min} – ${st.max}`;
      if (st.min !== null) return `≥ ${st.min}`;
      if (st.max !== null) return `≤ ${st.max}`;
      return '—';
    }
    if (p.stdType === 'monthly_allowance') return st.monthly !== null ? `Monthly ${st.monthly}` : '—';
    if (p.stdType === 'required_qty') return st.std !== null ? `Req ${st.std}` : '—';
    if (p.stdType === 'per_day' && st.std !== null) {
      return st.monthly !== null ? `Std ${st.std} · Monthly ${st.monthly}` : `Std ${st.std}`;
    }
    return '—';
  };
  // Group consecutive dates whose rendered standard is identical.
  const segments: Array<{ from: string; text: string }> = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const text = atDate(d);
    const last = segments[segments.length - 1];
    if (!last || last.text !== text) segments.push({ from: d, text });
  }
  if (segments.length === 1) return `Std: ${segments[0]?.text ?? '—'}`;
  return segments.map((seg, i) => (i === 0 ? `Std: ${seg.text}` : `(from ${seg.from}: ${seg.text})`)).join(' ');
}

/** Build the .xlsx the user downloads and fills in. */
export async function templateWorkbook(ctx: ClientCtx, plant: PlantCtx, from: string, to: string): Promise<NodeBuffer> {
  const b = await getBundle(ctx.tenantId, plant.id);
  const s = b.settings;
  // Parameters active anywhere inside the range (stocks are typed as separate consumed/received codes too).
  const codes = new Set<string>();
  for (let d = from; d <= to; d = addDays(d, 1)) for (const p of typedParams(s, d)) codes.add(p.code);
  const params = s.params.filter((p) => codes.has(p.code)).sort((a, x) => a.block - x.block || a.order - x.order);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'OMMIS';
  wb.created = new Date();

  const ws = wb.addWorksheet(DATA_SHEET, { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });
  // Columns: Date + one per param. Widths are modest — Excel wraps long headings.
  ws.columns = [{ header: DATE_HDR, key: 'date', width: 12 },
    ...params.map((p) => ({ header: '', key: `p_${p.id}`, width: 16 }))];

  // Minimal, consistent typography — Calibri 10, no colour fills.
  const base = { name: 'Calibri', size: 10 } as const;
  const thin = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };

  // Row 1 — Header (code, name, unit). Plain, slightly bold, thin border below.
  const hdr = ws.getRow(1);
  hdr.values = [DATE_HDR, ...params.map((p) => `${p.code} — ${p.name}${p.unit ? ` (${p.unit})` : ''}`)];
  hdr.height = 28;
  hdr.eachCell((c) => {
    c.font = { ...base, bold: true };
    c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    c.border = { bottom: thin };
  });

  // Row 2 — Standard row (locked, minimal styling).
  const stdRow = ws.getRow(2);
  stdRow.values = ['Std', ...params.map((p) => standardCellText(s, p, from, to))];
  stdRow.height = 18;
  stdRow.eachCell((c) => {
    c.font = { ...base, italic: true, color: { argb: 'FF666666' } };
    c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    c.protection = { locked: true };
    c.border = { bottom: thin };
  });

  // Data rows — one per date, pre-filled and locked in column A.
  const totalDays = diffDays(to, from) + 1;
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(from, i);
    const r = ws.getRow(3 + i);
    const dateCell = r.getCell(1);
    dateCell.value = d;
    dateCell.numFmt = '@';                 // keep as plain text so Excel never reformats or shifts it
    dateCell.protection = { locked: true };
    dateCell.font = { ...base };
    dateCell.alignment = { horizontal: 'left', vertical: 'middle' };
    dateCell.border = { right: thin };
    // Cell per parameter
    for (let j = 0; j < params.length; j++) {
      const p = params[j];
      if (!p) continue;
      const cell = r.getCell(2 + j);
      cell.font = { ...base };
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
      const active = (!p.activeFrom || p.activeFrom <= d) && (!p.activeTo || p.activeTo >= d);
      if (!active) {
        cell.value = '—';
        cell.protection = { locked: true };
        cell.font = { ...base, color: { argb: 'FF999999' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        continue;
      }
      cell.protection = { locked: false };
      if (p.aggregation === 'text') {
        cell.numFmt = '@';
      } else {
        cell.numFmt = p.decimals > 0 ? `0.${'0'.repeat(Math.min(p.decimals, 6))}` : '0';
        // Hard min/max via Excel data validation — a nudge, not the real check (server re-validates).
        if (p.hardMin !== null || p.hardMax !== null) {
          const lo = p.hardMin ?? -1e15;
          const hi = p.hardMax ?? 1e15;
          cell.dataValidation = {
            type: 'decimal', operator: 'between', allowBlank: true, showErrorMessage: true,
            formulae: [lo, hi], errorTitle: 'Out of range',
            error: `Allowed: ${p.hardMin ?? '−∞'} to ${p.hardMax ?? '+∞'}`,
          };
        }
      }
    }
  }
  // Protect the sheet: only cells with protection: { locked: false } become editable,
  // so the Date column, the Std row, and inactive cells can't be touched.
  await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatCells: false,
    formatColumns: false, formatRows: false, insertRows: false, insertColumns: false, deleteRows: false,
    deleteColumns: false, sort: false, autoFilter: false });

  // ─── hidden `_meta` sheet ─────────────────────────────────────
  const meta = wb.addWorksheet(META_SHEET, { state: 'hidden' });
  meta.addRow(['key', 'value']);
  meta.addRow(['SCHEMA', 'ommis-logsheet-import@1']);
  meta.addRow(['PLANT_ID', plant.id]);
  meta.addRow(['FROM', from]);
  meta.addRow(['TO', to]);
  meta.addRow(['CREATED_AT', new Date().toISOString()]);
  meta.addRow([]);
  meta.addRow(['col', 'param_code', 'param_id']);
  params.forEach((p, i) => meta.addRow([i + 2, p.code, p.id])); // +2 because column A is Date
  await meta.protect('', { selectLockedCells: false, selectUnlockedCells: false });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

// ──────────────────────────────────────────────────────────────── parsing

interface ParsedMeta {
  schema: string;
  plantId: string;
  from: string;
  to: string;
  /** column index (1-based) → parameter code */
  columns: Map<number, string>;
}
interface ParsedRow { date: string; values: Map<string, string> }   // raw cell strings; typed per-param later

/** Reads the workbook and extracts meta + rows. Shape errors throw here so we fail fast. */
async function parseWorkbook(buf: NodeBuffer): Promise<{ meta: ParsedMeta; rows: ParsedRow[] }> {
  const wb = new ExcelJS.Workbook();
  try {
    // ExcelJS's older types declare Buffer with ArrayBuffer rather than ArrayBufferLike — the
    // runtime handles both just fine, so widen the type here to keep the compiler happy.
    await (wb.xlsx.load as unknown as (b: unknown) => Promise<unknown>)(buf);
  } catch {
    throw unprocessable('IMPORT_NOT_XLSX', 'This file is not a valid .xlsx workbook.');
  }
  const ws = wb.getWorksheet(DATA_SHEET);
  const metaWs = wb.getWorksheet(META_SHEET);
  if (!ws || !metaWs) {
    throw unprocessable('IMPORT_TEMPLATE_MISSING', 'Please upload the template downloaded from this page.');
  }
  // Meta
  const kv = new Map<string, string>();
  for (let i = 1; i <= 6; i++) {
    const k = String(metaWs.getRow(i).getCell(1).value ?? '').trim();
    const v = String(metaWs.getRow(i).getCell(2).value ?? '').trim();
    if (k) kv.set(k, v);
  }
  const schema = kv.get('SCHEMA') ?? '';
  const plantId = kv.get('PLANT_ID') ?? '';
  const from = kv.get('FROM') ?? '';
  const to = kv.get('TO') ?? '';
  if (schema !== 'ommis-logsheet-import@1' || !plantId || !from || !to) {
    throw unprocessable('IMPORT_TEMPLATE_MISSING', 'Please upload the template downloaded from this page.');
  }
  // Column map (row 8 header, row 9+ data)
  const columns = new Map<number, string>();
  for (let i = 9; i <= metaWs.rowCount; i++) {
    const colN = Number(metaWs.getRow(i).getCell(1).value);
    const code = String(metaWs.getRow(i).getCell(2).value ?? '').trim();
    if (Number.isFinite(colN) && code) columns.set(colN, code);
  }
  if (columns.size === 0) throw unprocessable('IMPORT_TEMPLATE_MISSING', 'Please upload the template downloaded from this page.');

  // Rows: data starts at row 3 of the Logsheets sheet.
  const rows: ParsedRow[] = [];
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const dCell = row.getCell(1).value;
    const date = cellToDate(dCell);
    if (!date) continue;                // blank or trailing row — ignore
    const values = new Map<string, string>();
    for (const [colN, code] of columns) {
      const raw = row.getCell(colN).value;
      const text = cellToPlainText(raw);
      if (text !== '' && text !== '—') values.set(code, text);
    }
    rows.push({ date, values });
  }
  return { meta: { schema, plantId, from, to, columns }, rows };
}

/** ExcelJS cell → 'YYYY-MM-DD' (never a Date object) or '' on anything else. */
function cellToDate(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
/** ExcelJS cell → plain text. Handles rich text, formulas, numbers, dates, nulls. */
function cellToPlainText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim();
  if (v instanceof Date) return cellToDate(v);
  if (typeof v === 'object' && v) {
    const o = v as { result?: unknown; text?: unknown; richText?: Array<{ text?: string }>; formula?: unknown };
    if (o.result !== undefined && o.result !== null) return cellToPlainText(o.result);
    if (Array.isArray(o.richText)) return o.richText.map((p) => p.text ?? '').join('').trim();
    if (typeof o.text === 'string') return o.text.trim();
  }
  return String(v).trim();
}

// ──────────────────────────────────────────────────────────────── validation per day

interface DayPlan {
  date: string;
  status: 'missing' | 'draft' | 'submitted' | 'corrected' | 'checked' | 'verified';
  existingVersion: number;
  existingId: string | null;
  values: Values;                      // typed, ready for writeValues
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

/** Turn a raw cell text into the typed Value for a parameter (number / string / null). */
function typeValue(p: ParamDef, raw: string): { ok: true; value: number | string | null } | { ok: false; message: string } {
  if (raw === '') return { ok: true, value: null };
  if (p.aggregation === 'text') return { ok: true, value: raw };
  // Accept Indian grouping like "1,23,456.78" by stripping commas (numbers only).
  const n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return { ok: false, message: `Must be a number (got "${raw}")` };
  if (p.decimals === 0 && (p.group === 'staff' || p.group === 'safety') && !Number.isInteger(n)) {
    return { ok: false, message: 'Must be a whole number' };
  }
  return { ok: true, value: n };
}

type Existing = { date: string; id: string; status: string; version: number };

async function loadExisting(tx: Tx, ctx: ClientCtx, plantId: string, from: string, to: string): Promise<Map<string, Existing>> {
  const rows = await many<Existing>(tx,
    `SELECT log_date AS date, id, status, version FROM app.logsheets
      WHERE tenant_id = $1 AND plant_id = $2 AND log_date BETWEEN $3 AND $4
      FOR UPDATE`, [ctx.tenantId, plantId, from, to]);
  return new Map(rows.map((r) => [r.date, r]));
}

async function buildPlans(
  ctx: ClientCtx, plant: PlantCtx, from: string, to: string, rows: ParsedRow[],
  s: EngineSettings, derived: DerivedMap, tx: Tx,
  opts: { setupStatus: string; allowSameDay: boolean; backfillDays: number; isClientAdmin: boolean },
): Promise<{ plans: DayPlan[]; dupDates: string[]; missingDates: string[] }> {
  const byDate = new Map<string, Map<string, string>>();
  const dupDates: string[] = [];
  const unexpected: string[] = [];
  for (const r of rows) {
    if (r.date < from || r.date > to) { unexpected.push(r.date); continue; }
    if (byDate.has(r.date)) { dupDates.push(r.date); continue; }
    byDate.set(r.date, r.values);
  }
  const existing = await loadExisting(tx, ctx, plant.id, from, to);
  const codeToParam = new Map(s.params.map((p) => [p.code, p]));
  const plans: DayPlan[] = [];
  const missingDates: string[] = [];

  for (let d = from; d <= to; d = addDays(d, 1)) {
    const rec = byDate.get(d);
    const ex = existing.get(d);
    const rule = dateRule(s, { ...opts, exists: !!ex }, d);

    if (!rec) { missingDates.push(d); continue; }

    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];

    // Date must be open for entry — a Client Admin may still fill it for existing days.
    if (!rule.allowed && !(opts.isClientAdmin && ex)) {
      errors.push({ date: d, code: 'DATE', name: 'Date', message: reasonText(rule.reason) });
      plans.push({ date: d, status: (ex?.status as DayPlan['status']) ?? 'missing',
        existingId: ex?.id ?? null, existingVersion: ex?.version ?? 0, values: new Map(), errors, warnings });
      continue;
    }

    // Type each cell against its parameter definition.
    const values: Values = new Map();
    const active = new Set(typedParams(s, d).map((p) => p.code));
    for (const [code, raw] of rec) {
      const p = codeToParam.get(code);
      if (!p) continue;                             // meta references a code that no longer exists — silently ignore
      if (!active.has(code)) continue;              // the user typed into a locked "—" cell — ignore, not an error
      const r = typeValue(p, raw);
      if (!r.ok) errors.push({ date: d, code: p.code, name: p.name, message: r.message });
      else values.set(code, r.value);
    }

    // Logical validation (missing mandatories, hardMin/Max, event rule, staff totals, …).
    const { errors: ve, warnings: vw } = validateValues(s, derived, d, new Map(values), true);
    for (const e of ve) errors.push({ date: d, code: e.code, name: codeToParam.get(e.code)?.name ?? e.code, message: e.message });
    for (const w of vw) warnings.push({ date: d, code: w.code, name: codeToParam.get(w.code)?.name ?? w.code, message: w.message });

    // A submitted/corrected logsheet being edited by someone else right now — hold the import.
    if (ex) {
      const r2 = await one<{ locked_by: string | null; locked_until: string | null; locked_name: string | null }>(tx,
        `SELECT l.locked_by, l.locked_until, u.name AS locked_name
           FROM app.logsheets l LEFT JOIN app.users u ON u.tenant_id = l.tenant_id AND u.id = l.locked_by
          WHERE l.tenant_id = $1 AND l.id = $2`, [ctx.tenantId, ex.id]);
      if (r2.locked_by && r2.locked_by !== ctx.userId && r2.locked_until && Date.parse(r2.locked_until) > Date.now()) {
        errors.push({ date: d, code: 'DATE', name: 'Date', message: `Being edited by ${r2.locked_name ?? 'another user'}` });
      }
    }

    plans.push({
      date: d, status: (ex?.status as DayPlan['status']) ?? 'missing',
      existingId: ex?.id ?? null, existingVersion: ex?.version ?? 0,
      values, errors, warnings,
    });
  }

  for (const d of unexpected) {
    // A row outside the declared range — flag it so users notice they picked the wrong file.
    plans.push({ date: d, status: 'missing', existingId: null, existingVersion: 0, values: new Map(),
      errors: [{ date: d, code: 'DATE', name: 'Date', message: `Date ${d} is outside the selected range ${from} → ${to}` }],
      warnings: [] });
  }
  for (const d of dupDates) {
    plans.push({ date: d, status: 'missing', existingId: null, existingVersion: 0, values: new Map(),
      errors: [{ date: d, code: 'DATE', name: 'Date', message: `Date ${d} appears more than once in the file` }],
      warnings: [] });
  }

  return { plans, dupDates, missingDates };
}

function reasonText(r: string | null): string {
  switch (r) {
    case 'OUTSIDE_CONTRACT': return 'Outside the MIS period';
    case 'FUTURE_DATE': return 'Not open yet';
    case 'PLANT_NOT_LIVE': return 'Plant is not live yet';
    case 'OUTSIDE_BACKFILL_WINDOW': return 'Outside the back-fill window';
    default: return 'Not open for entry';
  }
}

// ──────────────────────────────────────────────────────────────── preview + run

async function entryOptions(tx: Tx, ctx: ClientCtx, plant: PlantCtx) {
  const s = await one<{ allow_same_day: boolean; editor_backfill_days: number }>(tx,
    'SELECT allow_same_day, editor_backfill_days FROM app.plant_settings WHERE tenant_id = $1 AND plant_id = $2',
    [ctx.tenantId, plant.id]);
  return { setupStatus: plant.setupStatus, allowSameDay: s.allow_same_day,
    backfillDays: s.editor_backfill_days, isClientAdmin: ctx.isClientAdmin };
}

/** Shared parse + plan-build body. Verifies the meta and range match the request. */
async function parseAndPlan(ctx: ClientCtx, plant: PlantCtx, from: string, to: string, file: NodeBuffer, tx: Tx) {
  const b = await getBundle(ctx.tenantId, plant.id);
  const { meta, rows } = await parseWorkbook(file);
  if (meta.plantId !== plant.id) {
    throw unprocessable('IMPORT_PLANT_MISMATCH',
      'This file was generated for a different plant. Please download a fresh template for this plant.');
  }
  if (meta.from !== from || meta.to !== to) {
    throw unprocessable('IMPORT_RANGE_MISMATCH',
      `This file covers ${meta.from} → ${meta.to} but you selected ${from} → ${to}.`);
  }
  const opts = await entryOptions(tx, ctx, plant);
  const built = await buildPlans(ctx, plant, from, to, rows, b.settings, b.derived, tx, opts);
  return { plans: built.plans, rowCount: rows.length };
}

export async function previewImport(
  ctx: ClientCtx, plant: PlantCtx, from: string, to: string, file: NodeBuffer,
): Promise<ImportPreview> {
  return withTenant(tenantTx(ctx), async (tx) => {
    const { plans, rowCount } = await parseAndPlan(ctx, plant, from, to, file, tx);
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const conflicts: ImportConflictRow[] = [];
    let ready = 0;
    for (const p of plans) {
      errors.push(...p.errors);
      warnings.push(...p.warnings);
      if (p.errors.length === 0) ready++;
      if (p.existingId && p.status !== 'missing') conflicts.push({ date: p.date, status: p.status });
    }
    return { from, to, rows: rowCount, rowsReady: ready, errors, warnings, conflicts, ok: errors.length === 0 };
  });
}

/** Save every planned day in one transaction. Existing submitted days are recorded as corrections. */
export async function runImport(
  ctx: ClientCtx, plant: PlantCtx, from: string, to: string, file: NodeBuffer,
  policy: ConflictPolicy, meta: RequestMeta,
): Promise<ImportResult> {
  const b = await getBundle(ctx.tenantId, plant.id);
  const s = b.settings;
  const codeToParam = new Map(s.params.map((p) => [p.code, p]));

  const result = await withTenant(tenantTx(ctx), async (tx) => {
    const { plans } = await parseAndPlan(ctx, plant, from, to, file, tx);
    // Hard stop on any row-level error — whole file fails.
    const bad = plans.filter((p) => p.errors.length).flatMap((p) => p.errors);
    if (bad.length) throw unprocessable('IMPORT_VALIDATION_FAILED', 'The file has errors.', { errors: bad });

    let inserted = 0, corrected = 0, skipped = 0;
    const allWarnings: ImportIssue[] = [];
    const daysWritten: string[] = [];

    for (const p of plans) {
      if (!p.values.size && p.status === 'missing') continue; // nothing to do for a totally empty row
      const isExistingSubmitted = p.existingId &&
        (p.status === 'submitted' || p.status === 'corrected' || p.status === 'checked' || p.status === 'verified');

      if (isExistingSubmitted && policy === 'keep_existing') { skipped++; continue; }

      if (isExistingSubmitted) {
        await rewriteAsCorrection(tx, ctx, plant, p, codeToParam);
        corrected++;
      } else {
        await insertOrPromote(tx, ctx, plant, p, codeToParam);
        inserted++;
      }
      allWarnings.push(...p.warnings);
      daysWritten.push(p.date);
    }

    if (daysWritten.length === 0) {
      // Everything was skipped — still a valid outcome, not an error.
      return { from, to, saved: 0, skipped, corrected, inserted, dataVersion: 0, warnings: [] };
    }

    const versions = await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
    // A late entry changes every later derived day — invalidate PDFs from the earliest written day + 1.
    const earliest = daysWritten.reduce((a, d) => (d < a ? d : a));
    await markPdfsStale(tx, ctx.tenantId, plant.id, addDays(earliest, 1), 'data_changed');
    await writeAudit(tx, clientActor(ctx), {
      action: 'logsheet.import', entity: 'plant', entityId: plant.id,
      after: { from, to, saved: daysWritten.length, inserted, corrected, skipped, policy },
    }, meta);

    return {
      from, to, saved: daysWritten.length, skipped, corrected, inserted,
      dataVersion: versions.dataVersion, warnings: allWarnings,
    };
  });

  if (result.saved > 0) await requestRecalc(ctx.tenantId, plant.id, from, to, 'import');
  return result;
}

// ──────────────────────────────────────────────────────────────── per-day writers

async function writeRowValues(
  tx: Tx, ctx: ClientCtx, logsheetId: string,
  params: ParamDef[], values: Values,
) {
  for (const p of params) {
    if (!values.has(p.code)) continue;
    const v = values.get(p.code);
    if (v === null || v === undefined || v === '') {
      await exec(tx, 'DELETE FROM app.logsheet_values WHERE tenant_id = $1 AND logsheet_id = $2 AND parameter_id = $3',
        [ctx.tenantId, logsheetId, p.id]);
      continue;
    }
    await exec(tx,
      `INSERT INTO app.logsheet_values (tenant_id, logsheet_id, parameter_id, value_num, value_text) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, logsheet_id, parameter_id) DO UPDATE SET value_num = EXCLUDED.value_num, value_text = EXCLUDED.value_text`,
      [ctx.tenantId, logsheetId, p.id, typeof v === 'number' ? v : null, typeof v === 'string' ? v : null]);
  }
}

async function readCurrentValues(tx: Tx, ctx: ClientCtx, logsheetId: string): Promise<Values> {
  const rows = await many<{ code: string; value_num: string | null; value_text: string | null }>(tx,
    `SELECT p.code, v.value_num, v.value_text
       FROM app.logsheet_values v
       JOIN app.parameters p ON p.tenant_id = v.tenant_id AND p.id = v.parameter_id
      WHERE v.tenant_id = $1 AND v.logsheet_id = $2`, [ctx.tenantId, logsheetId]);
  return new Map(rows.map((r) => [r.code, r.value_num !== null ? Number(r.value_num) : r.value_text]));
}

/** Insert the logsheet as submitted (or promote an existing draft). */
async function insertOrPromote(
  tx: Tx, ctx: ClientCtx, plant: PlantCtx, p: DayPlan, codeToParam: Map<string, ParamDef>,
) {
  const row = await one<{ id: string; version: number }>(tx,
    `INSERT INTO app.logsheets (tenant_id, plant_id, log_date, status, version, submitted_by, submitted_at, source, created_by)
     VALUES ($1, $2, $3, 'submitted', 1, $4, now(), 'import', $4)
     ON CONFLICT (tenant_id, plant_id, log_date) DO UPDATE SET
       status = 'submitted', version = app.logsheets.version + 1, submitted_by = $4, submitted_at = now(),
       source = 'import', locked_by = NULL, locked_until = NULL
     RETURNING id, version`, [ctx.tenantId, plant.id, p.date, ctx.userId]);
  const params = [...codeToParam.values()];
  await writeRowValues(tx, ctx, row.id, params, p.values);
}

/** Rewrite a submitted/corrected/checked/verified day, logging history for every changed value. */
async function rewriteAsCorrection(
  tx: Tx, ctx: ClientCtx, plant: PlantCtx, p: DayPlan, codeToParam: Map<string, ParamDef>,
) {
  if (!p.existingId) return;
  // Stale-check — someone edited the day between parseAndPlan and now.
  const cur = await one<{ version: number }>(tx,
    'SELECT version FROM app.logsheets WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [ctx.tenantId, p.existingId]);
  if (cur.version !== p.existingVersion) {
    throw conflict('STALE_VERSION', `The logsheet for ${p.date} was changed by another user. Please upload again.`);
  }
  const before = await readCurrentValues(tx, ctx, p.existingId);
  const newVersion = cur.version + 1;
  const params = [...codeToParam.values()];
  const reason = 'Excel import';

  for (const prm of params) {
    if (!p.values.has(prm.code)) continue;
    const o = before.get(prm.code) ?? null;
    const n = p.values.get(prm.code) ?? null;
    if (o === n) continue;
    await exec(tx,
      `INSERT INTO app.logsheet_value_history (tenant_id, logsheet_id, parameter_id, version,
         old_num, new_num, old_text, new_text, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [ctx.tenantId, p.existingId, prm.id, newVersion,
        typeof o === 'number' ? o : null, typeof n === 'number' ? n : null,
        typeof o === 'string' ? o : null, typeof n === 'string' ? n : null,
        ctx.userId, reason]);
  }
  await writeRowValues(tx, ctx, p.existingId, params, p.values);
  await exec(tx,
    `UPDATE app.logsheets SET status = 'corrected', version = $3, source = 'import',
       locked_by = NULL, locked_until = NULL
      WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, p.existingId, newVersion]);
}

// ──────────────────────────────────────────────────────────────── guard utilities

/** Shared range guard used by every import endpoint — plant lifecycle + sane bounds. */
export function assertRange(plant: PlantCtx, from: string, to: string) {
  if (from < plant.misStart || to > plant.omEnd) {
    throw unprocessable('IMPORT_RANGE_OUT_OF_CONTRACT',
      `Pick a range inside the plant's O&M window (${plant.misStart} → ${plant.omEnd}).`);
  }
  if (to > todayIST()) {
    throw unprocessable('IMPORT_RANGE_FUTURE', 'A logsheet cannot be imported for a future date.');
  }
}
