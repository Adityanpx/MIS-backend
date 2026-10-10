import { exec, many, maybeOne, one } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { registerHandler } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { addDays, todayIST } from '../../lib/dates';
import { writeAudit, userActor } from '../audit/audit.service';
import { getBundle } from '../engine/engine.service';
import { readStoredFile } from '../exports/download';
import { sendInBackground } from '../notifications/email.service';
import { notify, plantRecipients } from '../notifications/notify.service';
import { bumpVersions, requestRecalc } from '../settings/versions';
import { typedParams, validateValues } from '../logsheets/validation';
import { parseWorkbook, type Issue } from './parse';

interface ImportRow { id: string; plant_id: string; file_key: string; mapping: 'template' | 'excel_data_entry'; options: Record<string, unknown>; created_by: string }
async function loadImport(tenantId: string, id: string) {
  return withTenant({ tenantId, actorId: null }, (tx) => one<ImportRow>(tx,
    'SELECT id, plant_id, file_key, mapping, options, created_by FROM app.imports WHERE tenant_id = $1 AND id = $2', [tenantId, id]));
}
async function parseFor(tenantId: string, imp: ImportRow) {
  const b = await getBundle(tenantId, imp.plant_id);
  const textCodes = new Set(b.settings.params.filter((p) => p.aggregation === 'text').map((p) => p.code));
  const parsed = await parseWorkbook(await readStoredFile(imp.file_key), imp.mapping, textCodes);
  const known = new Set(b.settings.params.filter((p) => p.inputMode !== 'calculated').map((p) => p.code));
  const unknown = [...new Set(parsed.rows.flatMap((r) => Object.keys(r.values)))].filter((c) => !known.has(c));
  const yesterday = addDays(todayIST(), -1);
  const extra: Issue[] = [];
  for (const r of parsed.rows) {
    if (r.date < b.settings.plant.misStart || r.date > b.settings.plant.omEnd || r.date > yesterday) {
      extra.push({ row: r.row, column: 'date', message: `Date ${r.date} is outside MIS start…contract end / yesterday` });
      continue;
    }
    const values = new Map(Object.entries(r.values).filter(([k]) => known.has(k)));
    for (const e of validateValues(b.settings, b.derived, r.date, values, true).errors) {
      extra.push({ row: r.row, column: e.code, code: e.code, message: e.message, value: r.values[e.code] });
    }
  }
  return { b, parsed, unknown, extra };
}

registerHandler(QUEUES.importValidate, async (data) => {
  const { tenantId, importId } = data as { tenantId: string; importId: string };
  const imp = await loadImport(tenantId, importId);
  try {
    const { parsed, unknown, extra } = await parseFor(tenantId, imp);
    const existing = await withTenant({ tenantId, actorId: null }, (tx) => many<{ log_date: string }>(tx,
      `SELECT log_date FROM app.logsheets WHERE tenant_id = $1 AND plant_id = $2 AND status <> 'draft' AND log_date = ANY($3::date[])`,
      [tenantId, imp.plant_id, parsed.rows.map((r) => r.date)]));
    const errors = [...parsed.errors, ...extra];
    const report = {
      rows: parsed.rows.length, firstDate: parsed.rows[0]?.date ?? null, lastDate: parsed.rows.at(-1)?.date ?? null,
      errorRows: new Set(errors.map((e) => e.row)).size, errors: errors.slice(0, 1000), conversions: parsed.conversions.slice(0, 1000),
      duplicates: existing.map((e) => e.log_date), unknownColumns: unknown, suggestedOpenings: parsed.suggestedOpenings,
    };
    await withTenant({ tenantId, actorId: null }, (tx) => exec(tx,
      `UPDATE app.imports SET status = 'validated', report = $3::jsonb WHERE tenant_id = $1 AND id = $2`, [tenantId, importId, JSON.stringify(report)]));
  } catch (err) {
    await withTenant({ tenantId, actorId: null }, (tx) => exec(tx,
      `UPDATE app.imports SET status = 'failed', report = $3::jsonb WHERE tenant_id = $1 AND id = $2`,
      [tenantId, importId, JSON.stringify({ fatal: String((err as Error).message) })]));
  }
});

/** IMP-03/04/05: insert logsheets (source=import, status submitted) in batches of 200; one recalculation at the end; no PDFs. */
registerHandler(QUEUES.importApply, async (data) => {
  const { tenantId, importId } = data as { tenantId: string; importId: string };
  const imp = await loadImport(tenantId, importId);
  const opts = imp.options as { skipErrorRows?: boolean; existing?: 'skip' | 'overwrite'; reason?: string;
    openings?: { stock?: Record<string, number>; cash?: number; asOf?: string } };
  const ctx = { tenantId, actorId: imp.created_by };
  try {
    const { b, parsed, extra } = await parseFor(tenantId, imp);
    const bad = new Set([...parsed.errors, ...extra].map((e) => e.row));
    if (bad.size && !opts.skipErrorRows) throw new Error(`${bad.size} row(s) have errors; fix them or choose "skip error rows".`);
    const params = new Map(b.settings.params.map((p) => [p.code, p]));
    let inserted = 0;
    let skipped = 0;
    const rows = parsed.rows.filter((r) => !bad.has(r.row));
    // openings first (IMP-05)
    if (opts.openings) {
      await withTenant(ctx, async (tx) => {
        for (const [code, qty] of Object.entries(opts.openings!.stock ?? {})) {
          const item = b.settings.stock.find((i) => i.code === code);
          if (item) await exec(tx, 'UPDATE app.stock_items SET opening_balance = $3, opening_date = $4 WHERE tenant_id = $1 AND id = $2',
            [tenantId, item.id, qty, opts.openings!.asOf ?? addDays(rows[0]?.date ?? b.settings.plant.misStart, -1)]);
        }
        if (opts.openings!.cash !== undefined) {
          await exec(tx, 'UPDATE app.plant_settings SET cash_opening = $3, cash_opening_date = $4 WHERE tenant_id = $1 AND plant_id = $2',
            [tenantId, imp.plant_id, opts.openings!.cash, opts.openings!.asOf ?? addDays(rows[0]?.date ?? b.settings.plant.misStart, -1)]);
        }
        await bumpVersions(tx, tenantId, imp.plant_id, 'settings');
      });
    }
    for (let i = 0; i < rows.length; i += 200) {
      await withTenant(ctx, async (tx) => {
        for (const r of rows.slice(i, i + 200)) {
          const existing = await maybeOne<{ id: string; status: string }>(tx,
            'SELECT id, status FROM app.logsheets WHERE tenant_id = $1 AND plant_id = $2 AND log_date = $3 FOR UPDATE', [tenantId, imp.plant_id, r.date]);
          if (existing && existing.status !== 'draft' && opts.existing !== 'overwrite') { skipped++; continue; }
          const sheet = await one<{ id: string }>(tx,
            `INSERT INTO app.logsheets (tenant_id, plant_id, log_date, status, version, submitted_by, submitted_at, source, import_id, created_by)
             VALUES ($1, $2, $3, 'submitted', 1, $4, now(), 'import', $5, $4)
             ON CONFLICT (tenant_id, plant_id, log_date) DO UPDATE SET status = 'submitted', version = app.logsheets.version + 1,
               source = 'import', import_id = $5, submitted_by = $4, submitted_at = now()
             RETURNING id`, [tenantId, imp.plant_id, r.date, imp.created_by, importId]);
          await exec(tx, 'DELETE FROM app.logsheet_values WHERE tenant_id = $1 AND logsheet_id = $2', [tenantId, sheet.id]);
          const values = new Map(Object.entries(r.values));
          validateValues(b.settings, b.derived, r.date, values, false); // fills received fields with 0
          for (const p of typedParams(b.settings, r.date)) {
            const v = values.get(p.code);
            if (v === null || v === undefined || !params.has(p.code)) continue;
            await exec(tx, `INSERT INTO app.logsheet_values (tenant_id, logsheet_id, parameter_id, value_num, value_text) VALUES ($1, $2, $3, $4, $5)`,
              [tenantId, sheet.id, p.id, typeof v === 'number' ? v : null, typeof v === 'string' ? v : null]);
          }
          inserted++;
        }
        await bumpVersions(tx, tenantId, imp.plant_id, 'data');
      });
    }
    const outbox = await withTenant(ctx, async (tx) => {
      await exec(tx, `UPDATE app.imports SET status = 'applied', report = coalesce(report, '{}'::jsonb) || $3::jsonb WHERE tenant_id = $1 AND id = $2`,
        [tenantId, importId, JSON.stringify({ applied: { inserted, skipped, errorRowsSkipped: bad.size } })]);
      await writeAudit(tx, userActor(tenantId, imp.created_by), { action: 'import.apply', entity: 'import', entityId: importId,
        after: { inserted, skipped }, reason: opts.reason ?? null });
      const to = (await plantRecipients(tx, tenantId, imp.plant_id, ['client_admin'])).filter((u) => u.id === imp.created_by);
      return notify(tx, { tenantId, to, code: 'N-O08', title: 'Import finished', body: `${inserted} logsheet(s) imported, ${skipped} skipped.`,
        link: `/plants/${imp.plant_id}/imports/${importId}`, email: true });
    });
    sendInBackground(outbox);
    if (rows[0]) await requestRecalc(tenantId, imp.plant_id, addDays(rows[0].date, -1));
  } catch (err) {
    await withTenant(ctx, (tx) => exec(tx,
      `UPDATE app.imports SET status = 'failed', report = coalesce(report, '{}'::jsonb) || $3::jsonb WHERE tenant_id = $1 AND id = $2`,
      [tenantId, importId, JSON.stringify({ fatal: String((err as Error).message) })]));
  }
});
