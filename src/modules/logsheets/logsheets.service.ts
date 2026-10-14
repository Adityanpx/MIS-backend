import { LOCK_MINUTES } from '../../config/constants';
import { exec, many, maybeOne, one } from '../../db/sql';
import { withTenant, type Tx } from '../../db/tenant';
import { tenantTx } from '../../lib/context';
import { addDays, monthEnd } from '../../lib/dates';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import type { RequestMeta } from '../../lib/request-meta';
import type { ClientCtx, PlantCtx } from '../../types/express';
import { clientActor, writeAudit } from '../audit/audit.service';
import { standardAt, valueAt } from '../engine/core/effective';
import { getBundle } from '../engine/engine.service';
import { sendInBackground } from '../notifications/email.service';
import { notify, plantRecipients } from '../notifications/notify.service';
import { bumpVersions, markPdfsStale, requestRecalc } from '../settings/versions';
import { dateRule, typedParams, validateValues, type Values } from './validation';

type ValueIn = { parameterId: string; value: number | string | null };
const BLOCKS: Record<number, string> = {
  1: 'Key plant parameters', 2: 'Chemicals & consumables', 3: 'Inlet lab', 4: 'Outlet lab', 5: 'Safety items',
  6: 'Staff attendance', 7: 'Site cash', 8: 'Other',
};
const SUBMITTED = ['submitted', 'corrected', 'checked', 'verified'];

interface SheetRow {
  id: string; status: string; version: number; locked_by: string | null; locked_until: string | null; locked_name: string | null;
  submitted_by: string | null; submitted_at: string | null; submitted_name: string | null; remarks: string | null; source: string;
}
async function loadSheet(tx: Tx, ctx: ClientCtx, plantId: string, date: string, forUpdate = false): Promise<SheetRow | undefined> {
  if (forUpdate) await tx.query('SELECT 1 FROM app.logsheets WHERE tenant_id = $1 AND plant_id = $2 AND log_date = $3 FOR UPDATE', [ctx.tenantId, plantId, date]);
  return maybeOne<SheetRow>(tx,
    `SELECT l.id, l.status, l.version, l.locked_by, l.locked_until, lu.name AS locked_name, l.submitted_by, l.submitted_at,
            su.name AS submitted_name, l.remarks, l.source
       FROM app.logsheets l
       LEFT JOIN app.users lu ON lu.tenant_id = l.tenant_id AND lu.id = l.locked_by
       LEFT JOIN app.users su ON su.tenant_id = l.tenant_id AND su.id = l.submitted_by
      WHERE l.tenant_id = $1 AND l.plant_id = $2 AND l.log_date = $3`, [ctx.tenantId, plantId, date]);
}
async function entryOptions(tx: Tx, ctx: ClientCtx, plant: PlantCtx) {
  const s = await one<{ allow_same_day: boolean; editor_backfill_days: number }>(tx,
    'SELECT allow_same_day, editor_backfill_days FROM app.plant_settings WHERE tenant_id = $1 AND plant_id = $2', [ctx.tenantId, plant.id]);
  return { setupStatus: plant.setupStatus, allowSameDay: s.allow_same_day, backfillDays: s.editor_backfill_days, isClientAdmin: ctx.isClientAdmin };
}
const lockedByOther = (r: SheetRow | undefined, userId: string) =>
  !!r?.locked_by && r.locked_by !== userId && !!r.locked_until && Date.parse(r.locked_until) > Date.now();

/** Map {parameterId → value} to codes; unknown ids → 404 (another plant's parameter behaves like a missing one). */
function toValues(params: Array<{ id: string; code: string; inputMode: string }>, items: ValueIn[]): Values {
  const byId = new Map(params.map((p) => [p.id, p]));
  const out: Values = new Map();
  for (const it of items) {
    const p = byId.get(it.parameterId);
    if (!p) throw notFound('Parameter');
    if (p.inputMode === 'calculated') continue; // never stored: always computed
    out.set(p.code, it.value);
  }
  return out;
}

// ------------------------------------------------------------------ read
export async function calendar(ctx: ClientCtx, plant: PlantCtx, month: string) {
  const from = `${month}-01`;
  const to = monthEnd(from);
  return withTenant(tenantTx(ctx), async (tx) => {
    const opts = await entryOptions(tx, ctx, plant);
    const rows = await many<{ log_date: string; status: string; submitted_name: string | null; submitted_at: string | null }>(tx,
      `SELECT l.log_date, l.status, u.name AS submitted_name, l.submitted_at FROM app.logsheets l
         LEFT JOIN app.users u ON u.tenant_id = l.tenant_id AND u.id = l.submitted_by
        WHERE l.tenant_id = $1 AND l.plant_id = $2 AND l.log_date BETWEEN $3 AND $4`, [ctx.tenantId, plant.id, from, to]);
    const byDate = new Map(rows.map((r) => [r.log_date, r]));
    const b = await getBundle(ctx.tenantId, plant.id);
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = byDate.get(d);
      const rule = dateRule(b.settings, { ...opts, exists: !!r }, d);
      const status = r ? (r.status === 'draft' ? 'draft' : r.status) : rule.allowed ? 'missing'
        : rule.reason === 'FUTURE_DATE' ? 'future' : 'not_allowed';
      days.push({ date: d, status, reason: r ? null : rule.reason, submittedBy: r?.submitted_name ?? null, submittedAt: r?.submitted_at ?? null });
    }
    return { month, days };
  });
}

/** TRD §5.7 form metadata: fields with the standard valid on the date, values, lock and preview context. */
export async function form(ctx: ClientCtx, plant: PlantCtx, date: string) {
  const b = await getBundle(ctx.tenantId, plant.id);
  const s = b.settings;
  return withTenant(tenantTx(ctx), async (tx) => {
    const sheet = await loadSheet(tx, ctx, plant.id, date);
    const opts = await entryOptions(tx, ctx, plant);
    const rule = dateRule(s, { ...opts, exists: !!sheet }, date);
    const values = sheet
      ? await many<{ parameter_id: string; value_num: string | null; value_text: string | null }>(tx,
          'SELECT parameter_id, value_num, value_text FROM app.logsheet_values WHERE tenant_id = $1 AND logsheet_id = $2', [ctx.tenantId, sheet.id])
      : [];
    const params = typedParams(s, date).concat(s.params.filter((p) => p.inputMode === 'calculated'));
    const blocks = [...new Set(params.map((p) => p.block))].sort((a, x) => a - x).map((block) => ({
      block, title: BLOCKS[block] ?? `Block ${block}`,
      fields: params.filter((p) => p.block === block).sort((a, x) => a.order - x.order).map((p) => {
        const st = standardAt(p, date, s.primaryStandard);
        const safety = s.safety.find((i) => i.id === p.safetyItemId);
        return {
          parameterId: p.id, code: p.code, name: p.name, unit: p.unit, inputMode: p.inputMode, formula: p.formula,
          decimals: p.decimals, hardMin: p.hardMin, hardMax: p.hardMax, aggregation: p.aggregation, direction: p.direction,
          eventRule: p.eventRule, mandatory: p.mandatory, linkRole: p.linkRole,
          standard: safety ? { std: valueAt(safety.required, date) ?? null, min: null, max: null, monthly: null }
            : st ? { std: st.std, min: st.min, max: st.max, monthly: st.monthly } : null,
        };
      }),
    }));
    const prev = b.derived.get(addDays(date, -1));
    const canEdit = rule.allowed && plant.myRole !== 'viewer' && plant.myRole !== 'checker' && plant.myRole !== 'verifier'
      && (!sheet || sheet.status === 'draft');
    return {
      date, rule, canEdit, canCorrect: ctx.isClientAdmin && !!sheet && SUBMITTED.includes(sheet.status),
      logsheet: sheet ? {
        id: sheet.id, status: sheet.status, version: sheet.version, source: sheet.source, remarks: sheet.remarks,
        submittedBy: sheet.submitted_name, submittedAt: sheet.submitted_at,
        lock: lockedByOther(sheet, ctx.userId) ? { byName: sheet.locked_name, until: sheet.locked_until } : null,
      } : null,
      blocks,
      values: Object.fromEntries(values.map((v) => [v.parameter_id, v.value_num !== null ? Number(v.value_num) : v.value_text])),
      // v1.1 (block 8, §12.3): the open breakdowns the editor must acknowledge before submitting.
      maintenance: s.maintenance.enabled ? {
        reviewTickRequired: s.maintenance.reviewTickRequired,
        openBreakdowns: s.maintenance.breakdowns
          .filter((bd) => bd.status !== 'cancelled' && bd.startedAt.slice(0, 10) <= date && (!bd.restoredAt || bd.restoredAt.slice(0, 10) > date))
          .map((bd) => ({ id: bd.id, equipmentCode: bd.equipmentCode, equipmentName: bd.equipmentName, criticality: bd.criticality,
            startedAt: bd.startedAt, status: bd.status, expectedRestoreOn: bd.expectedRestoreOn })),
      } : null,
      context: { // lets the frontend compute live previews with src/shared/formula.ts (LOG-04)
        previousClosing: Object.fromEntries(s.stock.map((i) => [i.code, date === addDays(i.openingDate, 1) ? i.opening : prev?.stock[i.code] ?? null])),
        stockItems: s.stock.map((i) => ({ code: i.code, name: i.name, consumedCode: i.consumedCode, receivedCode: i.receivedCode, minLevel: i.minLevel })),
        previousCash: date === addDays(s.cash.openingDate, 1) ? s.cash.opening : prev?.cash ?? null,
        cashAlertLimit: s.cash.alertLimit,
        staff: s.staff.map((c) => ({ code: c.code, name: c.name, strength: valueAt(c.strengths, date) ?? 0, vacantCode: c.vacantCode,
          presentCode: c.presentCode, leaveCode: c.leaveCode })),
        constants: Object.fromEntries(Object.entries(s.constants).map(([k, rows]) => [k, valueAt(rows, date) ?? null])),
      },
    };
  });
}

// ------------------------------------------------------------------ lock (LOG-14)
export async function lock(ctx: ClientCtx, plant: PlantCtx, date: string) {
  const b = await getBundle(ctx.tenantId, plant.id);
  return withTenant(tenantTx(ctx), async (tx) => {
    const existing = await loadSheet(tx, ctx, plant.id, date);
    const rule = dateRule(b.settings, { ...(await entryOptions(tx, ctx, plant)), exists: !!existing }, date);
    if (!rule.allowed && !(ctx.isClientAdmin && existing)) throw unprocessable('LOGSHEET_DATE_NOT_ALLOWED', 'This date is not open for entry.', { reason: rule.reason });
    await exec(tx,
      `INSERT INTO app.logsheets (tenant_id, plant_id, log_date, status, version, created_by) VALUES ($1, $2, $3, 'draft', 0, $4)
       ON CONFLICT (tenant_id, plant_id, log_date) DO NOTHING`, [ctx.tenantId, plant.id, date, ctx.userId]);
    const r = await maybeOne<{ locked_until: string }>(tx,
      `UPDATE app.logsheets SET locked_by = $4, locked_until = now() + make_interval(mins => $5)
        WHERE tenant_id = $1 AND plant_id = $2 AND log_date = $3
          AND (locked_by IS NULL OR locked_until < now() OR locked_by = $4)
        RETURNING locked_until`, [ctx.tenantId, plant.id, date, ctx.userId, LOCK_MINUTES]);
    if (!r) {
      const s = await loadSheet(tx, ctx, plant.id, date);
      throw conflict('LOGSHEET_LOCKED', `Being edited by ${s?.locked_name ?? 'another user'}.`, { byName: s?.locked_name, until: s?.locked_until });
    }
    return { lockedUntil: r.locked_until };
  });
}
export async function unlock(ctx: ClientCtx, plant: PlantCtx, date: string) {
  await withTenant(tenantTx(ctx), (tx) => exec(tx,
    `UPDATE app.logsheets SET locked_by = NULL, locked_until = NULL WHERE tenant_id = $1 AND plant_id = $2 AND log_date = $3 AND locked_by = $4`,
    [ctx.tenantId, plant.id, date, ctx.userId]));
}

// ------------------------------------------------------------------ draft + submit (LOG-13, LOG-15)
async function writeValues(tx: Tx, ctx: ClientCtx, logsheetId: string, params: Array<{ id: string; code: string; aggregation: string }>, values: Values) {
  for (const p of params) {
    if (!values.has(p.code)) continue;
    const v = values.get(p.code);
    if (v === null || v === undefined || v === '') {
      await exec(tx, 'DELETE FROM app.logsheet_values WHERE tenant_id = $1 AND logsheet_id = $2 AND parameter_id = $3', [ctx.tenantId, logsheetId, p.id]);
      continue;
    }
    await exec(tx,
      `INSERT INTO app.logsheet_values (tenant_id, logsheet_id, parameter_id, value_num, value_text) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, logsheet_id, parameter_id) DO UPDATE SET value_num = EXCLUDED.value_num, value_text = EXCLUDED.value_text`,
      [ctx.tenantId, logsheetId, p.id, typeof v === 'number' ? v : null, typeof v === 'string' ? v : null]);
  }
}
async function currentValues(tx: Tx, ctx: ClientCtx, logsheetId: string): Promise<Values> {
  const rows = await many<{ code: string; value_num: string | null; value_text: string | null }>(tx,
    `SELECT p.code, v.value_num, v.value_text FROM app.logsheet_values v JOIN app.parameters p ON p.tenant_id = v.tenant_id AND p.id = v.parameter_id
      WHERE v.tenant_id = $1 AND v.logsheet_id = $2`, [ctx.tenantId, logsheetId]);
  return new Map(rows.map((r) => [r.code, r.value_num !== null ? Number(r.value_num) : r.value_text]));
}

export async function saveDraft(ctx: ClientCtx, plant: PlantCtx, date: string, body: { values: ValueIn[]; version: number }, meta: RequestMeta) {
  const b = await getBundle(ctx.tenantId, plant.id);
  return withTenant(tenantTx(ctx), async (tx) => {
    const sheet = await loadSheet(tx, ctx, plant.id, date, true);
    const rule = dateRule(b.settings, { ...(await entryOptions(tx, ctx, plant)), exists: !!sheet }, date);
    if (!rule.allowed) throw unprocessable('LOGSHEET_DATE_NOT_ALLOWED', 'This date is not open for entry.', { reason: rule.reason });
    if (sheet && sheet.status !== 'draft') throw conflict('LOGSHEET_ALREADY_SUBMITTED', 'This logsheet is already submitted.');
    if ((sheet?.version ?? 0) !== body.version) throw conflict('STALE_VERSION', 'Someone else saved this logsheet. Reload it.');
    if (lockedByOther(sheet, ctx.userId)) throw conflict('LOGSHEET_LOCKED', `Being edited by ${sheet?.locked_name}.`);
    const params = typedParams(b.settings, date);
    const values = toValues(b.settings.params, body.values);
    const { errors } = validateValues(b.settings, b.derived, date, new Map(values), false);
    if (errors.length) throw unprocessable('VALIDATION_FAILED', 'Some values are invalid.', { fields: errors });
    const row = await one<{ id: string; version: number }>(tx,
      `INSERT INTO app.logsheets (tenant_id, plant_id, log_date, status, version, created_by) VALUES ($1, $2, $3, 'draft', 1, $4)
       ON CONFLICT (tenant_id, plant_id, log_date) DO UPDATE SET version = app.logsheets.version + 1
       RETURNING id, version`, [ctx.tenantId, plant.id, date, ctx.userId]);
    await writeValues(tx, ctx, row.id, params, values);
    await writeAudit(tx, clientActor(ctx), { action: 'logsheet.save_draft', entity: 'logsheet', entityId: row.id, after: { date, version: row.version } }, meta);
    return { id: row.id, status: 'draft', version: row.version };
  });
}

export async function submit(ctx: ClientCtx, plant: PlantCtx, date: string,
  body: { values?: ValueIn[]; version: number; remarks?: string; breakdownReviewed?: boolean }, meta: RequestMeta) {
  const b = await getBundle(ctx.tenantId, plant.id);
  const outbox: Array<string | null> = [];
  const result = await withTenant(tenantTx(ctx), async (tx) => {
    const sheet = await loadSheet(tx, ctx, plant.id, date, true);
    const rule = dateRule(b.settings, { ...(await entryOptions(tx, ctx, plant)), exists: !!sheet }, date);
    if (!rule.allowed) throw unprocessable('LOGSHEET_DATE_NOT_ALLOWED', 'This date is not open for entry.', { reason: rule.reason });
    if (sheet && sheet.status !== 'draft') throw conflict('LOGSHEET_ALREADY_SUBMITTED', 'This logsheet is already submitted.');
    if ((sheet?.version ?? 0) !== body.version) throw conflict('STALE_VERSION', 'Someone else saved this logsheet. Reload it.');
    if (lockedByOther(sheet, ctx.userId)) throw conflict('LOGSHEET_LOCKED', `Being edited by ${sheet?.locked_name}.`);
    // v1.1 (block 8): with maintenance on, the editor must tick that they reviewed the breakdown status before submitting.
    if (b.settings.maintenance.enabled && b.settings.maintenance.reviewTickRequired && !body.breakdownReviewed) {
      throw unprocessable('BREAKDOWN_REVIEW_REQUIRED', 'Please review the machinery breakdown status before submitting.');
    }
    const params = typedParams(b.settings, date);
    const values = sheet ? await currentValues(tx, ctx, sheet.id) : new Map();
    for (const [k, v] of toValues(b.settings.params, body.values ?? [])) values.set(k, v);
    const { errors, warnings } = validateValues(b.settings, b.derived, date, values, true);
    if (errors.length) throw unprocessable('VALIDATION_FAILED', 'Some values are invalid.', { fields: errors });
    const row = await one<{ id: string; version: number }>(tx,
      `INSERT INTO app.logsheets (tenant_id, plant_id, log_date, status, version, submitted_by, submitted_at, remarks, created_by)
       VALUES ($1, $2, $3, 'submitted', 1, $4, now(), $5, $4)
       ON CONFLICT (tenant_id, plant_id, log_date) DO UPDATE SET status = 'submitted', version = app.logsheets.version + 1,
         submitted_by = $4, submitted_at = now(), remarks = coalesce($5, app.logsheets.remarks), locked_by = NULL, locked_until = NULL
       RETURNING id, version`, [ctx.tenantId, plant.id, date, ctx.userId, body.remarks ?? null]);
    await writeValues(tx, ctx, row.id, params, values);
    const versions = await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
    await markPdfsStale(tx, ctx.tenantId, plant.id, addDays(date, 1), 'data_changed'); // a late entry changes later balances
    await writeAudit(tx, clientActor(ctx), { action: 'logsheet.submit', entity: 'logsheet', entityId: row.id,
      after: { date, version: row.version, warnings: warnings.length, breakdownReviewed: body.breakdownReviewed ?? null } }, meta);
    // N-O02 / N-O03 / N-O09 (in-app)
    const outletBad = warnings.filter((w) => b.settings.params.find((p) => p.code === w.code)?.group === 'lab_outlet');
    const stockBad = warnings.filter((w) => w.message.includes('closing balance'));
    const cashBad = warnings.filter((w) => b.settings.params.find((p) => p.code === w.code)?.linkRole === 'expense');
    const link = `/plants/${plant.id}/mis?date=${date}`;
    if (outletBad.length) {
      outbox.push(...await notify(tx, { tenantId: ctx.tenantId, to: await plantRecipients(tx, ctx.tenantId, plant.id, ['client_admin']),
        code: 'N-O02', title: `${plant.name}: outlet limit exceeded on ${date}`, body: outletBad.map((w) => w.message).join('; '), link }));
    }
    if (stockBad.length) {
      outbox.push(...await notify(tx, { tenantId: ctx.tenantId, to: await plantRecipients(tx, ctx.tenantId, plant.id, ['client_admin', 'editor']),
        code: 'N-O03', title: `${plant.name}: low stock on ${date}`, body: stockBad.map((w) => w.message).join('; '), link }));
    }
    if (cashBad.length) {
      outbox.push(...await notify(tx, { tenantId: ctx.tenantId, to: await plantRecipients(tx, ctx.tenantId, plant.id, ['client_admin']),
        code: 'N-O09', title: `${plant.name}: cash expense above limit on ${date}`, body: cashBad.map((w) => w.message).join('; '), link }));
    }
    return { id: row.id, status: 'submitted', version: row.version, warnings, dataVersion: versions.dataVersion };
  });
  sendInBackground(outbox);
  await requestRecalc(ctx.tenantId, plant.id, date, date, 'submit');
  return result;
}

// ------------------------------------------------------------------ corrections (LOG-17…LOG-21)
async function applyCorrection(tx: Tx, ctx: ClientCtx, plant: PlantCtx, date: string, items: ValueIn[], reason: string,
  version: number | null, meta: RequestMeta) {
  const b = await getBundle(ctx.tenantId, plant.id);
  const sheet = await loadSheet(tx, ctx, plant.id, date, true);
  if (!sheet || !SUBMITTED.includes(sheet.status)) throw notFound('Submitted logsheet');
  if (version !== null && sheet.version !== version) throw conflict('STALE_VERSION', 'The logsheet changed. Reload it.');
  const before = await currentValues(tx, ctx, sheet.id);
  const after = new Map(before);
  const changes = toValues(b.settings.params, items);
  for (const [k, v] of changes) after.set(k, v);
  const { errors } = validateValues(b.settings, b.derived, date, after, true);
  if (errors.length) throw unprocessable('VALIDATION_FAILED', 'Some values are invalid.', { fields: errors });
  const newVersion = sheet.version + 1;
  const params = typedParams(b.settings, date);
  let changed = 0;
  for (const p of params) {
    if (!changes.has(p.code)) continue;
    const o = before.get(p.code) ?? null;
    const n = after.get(p.code) ?? null;
    if (o === n) continue;
    changed++;
    await exec(tx,
      `INSERT INTO app.logsheet_value_history (tenant_id, logsheet_id, parameter_id, version, old_num, new_num, old_text, new_text, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [ctx.tenantId, sheet.id, p.id, newVersion, typeof o === 'number' ? o : null, typeof n === 'number' ? n : null,
        typeof o === 'string' ? o : null, typeof n === 'string' ? n : null, ctx.userId, reason]);
  }
  if (changed === 0) throw unprocessable('NO_CHANGES', 'No value was changed.');
  await writeValues(tx, ctx, sheet.id, params, after);
  await exec(tx, `UPDATE app.logsheets SET status = 'corrected', version = $3 WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, sheet.id, newVersion]);
  await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
  await markPdfsStale(tx, ctx.tenantId, plant.id, addDays(date, 1), 'data_changed');
  await writeAudit(tx, clientActor(ctx), { action: 'logsheet.correct', entity: 'logsheet', entityId: sheet.id,
    before: Object.fromEntries([...changes.keys()].map((k) => [k, before.get(k) ?? null])),
    after: Object.fromEntries(changes), reason }, meta);
  return { id: sheet.id, status: 'corrected', version: newVersion, changed };
}

export async function correct(ctx: ClientCtx, plant: PlantCtx, date: string, body: { values: ValueIn[]; version: number; reason: string }, meta: RequestMeta) {
  const r = await withTenant(tenantTx(ctx), (tx) => applyCorrection(tx, ctx, plant, date, body.values, body.reason, body.version, meta));
  await requestRecalc(ctx.tenantId, plant.id, date, date, 'correction');
  return r;
}

export async function history(ctx: ClientCtx, plant: PlantCtx, date: string) {
  return withTenant(tenantTx(ctx), async (tx) => {
    const sheet = await loadSheet(tx, ctx, plant.id, date);
    if (!sheet) throw notFound('Logsheet');
    return many(tx,
      `SELECT h.version, p.code, p.name, h.old_num, h.new_num, h.old_text, h.new_text, u.name AS changed_by, h.changed_at, h.reason
         FROM app.logsheet_value_history h
         JOIN app.parameters p ON p.tenant_id = h.tenant_id AND p.id = h.parameter_id
         LEFT JOIN app.users u ON u.tenant_id = h.tenant_id AND u.id = h.changed_by
        WHERE h.tenant_id = $1 AND h.logsheet_id = $2 ORDER BY h.changed_at DESC, p.code`, [ctx.tenantId, sheet.id]);
  });
}

export async function requestCorrection(ctx: ClientCtx, plant: PlantCtx, date: string, body: { values: ValueIn[]; reason: string }, meta: RequestMeta) {
  const b = await getBundle(ctx.tenantId, plant.id);
  const outbox: Array<string | null> = [];
  const r = await withTenant(tenantTx(ctx), async (tx) => {
    const sheet = await loadSheet(tx, ctx, plant.id, date);
    if (!sheet || !SUBMITTED.includes(sheet.status)) throw notFound('Submitted logsheet');
    toValues(b.settings.params, body.values); // validates the parameter ids belong to this plant
    const row = await one<{ id: string }>(tx,
      `INSERT INTO app.correction_requests (tenant_id, logsheet_id, requested_by, reason, proposed) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [ctx.tenantId, sheet.id, ctx.userId, body.reason, JSON.stringify(body.values)]);
    await writeAudit(tx, clientActor(ctx), { action: 'correction_request.create', entity: 'correction_request', entityId: row.id, after: body }, meta);
    outbox.push(...await notify(tx, { tenantId: ctx.tenantId, to: await plantRecipients(tx, ctx.tenantId, plant.id, ['client_admin']),
      code: 'N-O06', title: `${plant.name}: correction requested for ${date}`, body: body.reason,
      link: `/plants/${plant.id}/logsheets/correction-requests`, email: true }));
    return { id: row.id, status: 'pending' };
  });
  sendInBackground(outbox);
  return r;
}

export async function listCorrectionRequests(ctx: ClientCtx, plant: PlantCtx, status?: string) {
  return withTenant(tenantTx(ctx), (tx) => many(tx,
    `SELECT c.id, l.log_date AS date, c.reason, c.proposed, c.status, c.comment, c.created_at, u.name AS requested_by,
            d.name AS decided_by, c.decided_at
       FROM app.correction_requests c
       JOIN app.logsheets l ON l.tenant_id = c.tenant_id AND l.id = c.logsheet_id
       JOIN app.users u ON u.tenant_id = c.tenant_id AND u.id = c.requested_by
       LEFT JOIN app.users d ON d.tenant_id = c.tenant_id AND d.id = c.decided_by
      WHERE c.tenant_id = $1 AND l.plant_id = $2 AND ($3::text IS NULL OR c.status = $3)
      ORDER BY c.created_at DESC LIMIT 200`, [ctx.tenantId, plant.id, status ?? null]));
}

export async function decideCorrection(ctx: ClientCtx, plant: PlantCtx, id: string, approve: boolean, comment: string | undefined, meta: RequestMeta) {
  const outbox: Array<string | null> = [];
  let date = '';
  await withTenant(tenantTx(ctx), async (tx) => {
    const c = await maybeOne<{ id: string; requested_by: string; reason: string; proposed: Array<{ parameterId: string; value: number | string | null }>; status: string; log_date: string }>(tx,
      `SELECT c.id, c.requested_by, c.reason, c.proposed, c.status, l.log_date FROM app.correction_requests c
         JOIN app.logsheets l ON l.tenant_id = c.tenant_id AND l.id = c.logsheet_id
        WHERE c.tenant_id = $1 AND l.plant_id = $2 AND c.id = $3 FOR UPDATE OF c`, [ctx.tenantId, plant.id, id]);
    if (!c) throw notFound('Correction request');
    if (c.status !== 'pending') throw conflict('ALREADY_DECIDED', 'This request was already decided.');
    date = c.log_date;
    if (approve) await applyCorrection(tx, ctx, plant, c.log_date, c.proposed, c.reason, null, meta);
    await exec(tx, `UPDATE app.correction_requests SET status = $3, decided_by = $4, decided_at = now(), comment = $5 WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, id, approve ? 'approved' : 'rejected', ctx.userId, comment ?? null]);
    await writeAudit(tx, clientActor(ctx), { action: `correction_request.${approve ? 'approve' : 'reject'}`, entity: 'correction_request', entityId: id, after: { comment } }, meta);
    const requester = (await plantRecipients(tx, ctx.tenantId, plant.id, ['editor', 'checker', 'verifier', 'viewer', 'client_admin']))
      .filter((u) => u.id === c.requested_by);
    outbox.push(...await notify(tx, { tenantId: ctx.tenantId, to: requester, code: 'N-O06',
      title: `${plant.name}: correction for ${c.log_date} ${approve ? 'approved' : 'rejected'}`, body: comment ?? '',
      link: `/plants/${plant.id}/logsheets/${c.log_date}`, email: true }));
  });
  sendInBackground(outbox);
  if (approve) await requestRecalc(ctx.tenantId, plant.id, date, date, 'correction');
}

/** RPT-12 helper and the dashboard "latest date": latest submitted date of the plant. */
export async function latestSubmitted(ctx: ClientCtx, plantId: string): Promise<string | null> {
  return withTenant(tenantTx(ctx), async (tx) => (await maybeOne<{ d: string | null }>(tx,
    `SELECT max(log_date) AS d FROM app.logsheets WHERE tenant_id = $1 AND plant_id = $2 AND status <> 'draft'`, [ctx.tenantId, plantId]))?.d ?? null);
}
