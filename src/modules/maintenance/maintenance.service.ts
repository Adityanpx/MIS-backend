import type { z } from 'zod';
import { exec, many, maybeOne, one, setClause } from '../../db/sql';
import { withTenant, type Tx } from '../../db/tenant';
import { tenantTx } from '../../lib/context';
import { todayIST } from '../../lib/dates';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import type { RequestMeta } from '../../lib/request-meta';
import type { ClientCtx, PlantCtx } from '../../types/express';
import { clientActor, diff, writeAudit } from '../audit/audit.service';
import { sendInBackground } from '../notifications/email.service';
import { notify, plantRecipients } from '../notifications/notify.service';
import { bumpVersions, markPdfsStale } from '../settings/versions';
import type * as m from '../../shared/schemas/maintenance';

type Ctx = ClientCtx;
const T = (ctx: Ctx) => tenantTx(ctx);

/* ==================================================================== Equipment (EQP-*) */

const EQUIPMENT_COLS = `id, code, name, category, area, make_model AS "makeModel", capacity, criticality, standby,
  installed_on AS "installedOn", status, out_of_service_reason AS "outOfServiceReason", out_of_service_on AS "outOfServiceOn",
  is_active AS "isActive", notes`;

export async function listEquipment(ctx: Ctx, plant: PlantCtx) {
  return withTenant(T(ctx), (tx) => many(tx, `
    SELECT ${EQUIPMENT_COLS},
           EXISTS (SELECT 1 FROM app.breakdowns b WHERE b.tenant_id = $1 AND b.equipment_id = equipment.id
                     AND b.status NOT IN ('restored', 'cancelled')) AS "hasOpenBreakdown"
      FROM app.equipment WHERE tenant_id = $1 AND plant_id = $2
     ORDER BY criticality, name`,
    [ctx.tenantId, plant.id]));
}

async function loadEquipment(tx: Tx, ctx: Ctx, plant: PlantCtx, id: string) {
  const r = await maybeOne<Record<string, unknown>>(tx,
    `SELECT ${EQUIPMENT_COLS} FROM app.equipment WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
    [ctx.tenantId, plant.id, id]);
  if (!r) throw notFound('Equipment');
  return r;
}

export async function createEquipment(ctx: Ctx, plant: PlantCtx, b: z.infer<typeof m.equipmentCreateBody>, meta: RequestMeta) {
  const row = await withTenant(T(ctx), async (tx) => {
    const exists = await maybeOne(tx, 'SELECT 1 FROM app.equipment WHERE tenant_id = $1 AND plant_id = $2 AND code = $3',
      [ctx.tenantId, plant.id, b.code]);
    if (exists) throw conflict('CODE_TAKEN', 'An equipment item with this code already exists.');
    const r = await one<{ id: string }>(tx, `
      INSERT INTO app.equipment (tenant_id, plant_id, code, name, category, area, make_model, capacity, criticality,
                                 standby, installed_on, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [ctx.tenantId, plant.id, b.code, b.name, b.category, b.area ?? null, b.makeModel ?? null, b.capacity ?? null,
        b.criticality, b.standby, b.installedOn ?? null, b.notes ?? null, ctx.userId]);
    await writeAudit(tx, clientActor(ctx), { action: 'equipment.create', entity: 'equipment', entityId: r.id, after: b }, meta);
    await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
    return r.id;
  });
  return withTenant(T(ctx), (tx) => loadEquipment(tx, ctx, plant, row));
}

export async function patchEquipment(ctx: Ctx, plant: PlantCtx, id: string, b: z.infer<typeof m.equipmentPatchBody>, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    const before = await loadEquipment(tx, ctx, plant, id);
    const set = setClause({
      name: b.name, category: b.category, area: b.area, make_model: b.makeModel, capacity: b.capacity,
      criticality: b.criticality, standby: b.standby, installed_on: b.installedOn, notes: b.notes, is_active: b.isActive,
    }, 4);
    if (set.values.length === 0) return;
    await exec(tx, `UPDATE app.equipment SET ${set.sql} WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
      [ctx.tenantId, plant.id, id, ...set.values]);
    const after = await loadEquipment(tx, ctx, plant, id);
    await writeAudit(tx, clientActor(ctx), { action: 'equipment.update', entity: 'equipment', entityId: id, ...diff(before, after) }, meta);
    // Criticality/active changes move the availability-% denominator for every period, so stale every MIS PDF.
    await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
    await markPdfsStale(tx, ctx.tenantId, plant.id, plant.misStart, 'equipment_changed');
  });
  return withTenant(T(ctx), (tx) => loadEquipment(tx, ctx, plant, id));
}

export async function setOutOfService(ctx: Ctx, plant: PlantCtx, id: string, b: z.infer<typeof m.equipmentOutOfServiceBody>, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    await loadEquipment(tx, ctx, plant, id);
    const open = await maybeOne(tx, `SELECT 1 FROM app.breakdowns WHERE tenant_id = $1 AND equipment_id = $2
       AND status NOT IN ('restored', 'cancelled')`, [ctx.tenantId, id]);
    if (open) throw conflict('OPEN_BREAKDOWN', 'Close all open breakdowns before setting this equipment out of service.');
    await exec(tx, `UPDATE app.equipment SET status = 'out_of_service', out_of_service_reason = $4, out_of_service_on = $5
       WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
      [ctx.tenantId, plant.id, id, b.reason, b.on ?? todayIST()]);
    await writeAudit(tx, clientActor(ctx), { action: 'equipment.out_of_service', entity: 'equipment', entityId: id, after: b, reason: b.reason }, meta);
    await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
  });
  return withTenant(T(ctx), (tx) => loadEquipment(tx, ctx, plant, id));
}

/* ==================================================================== Breakdowns (BRK-*) */

const BREAKDOWN_COLS = `b.id, b.equipment_id AS "equipmentId", e.code AS "equipmentCode", e.name AS "equipmentName",
  e.criticality, b.started_at AS "startedAt", b.fault, b.cause_category AS "causeCategory", b.impact,
  b.standby_running AS "standbyRunning", b.action_taken AS "actionTaken", b.spares_required AS "sparesRequired",
  b.expected_restore_on AS "expectedRestoreOn", b.status, b.restored_at AS "restoredAt", b.root_cause AS "rootCause",
  b.corrective_action AS "correctiveAction", b.cost, b.cancelled_reason AS "cancelledReason",
  b.created_at AS "createdAt", b.created_by AS "createdBy"`;

async function loadBreakdown(tx: Tx, ctx: Ctx, plant: PlantCtx, id: string) {
  const r = await maybeOne<Record<string, unknown>>(tx,
    `SELECT ${BREAKDOWN_COLS} FROM app.breakdowns b JOIN app.equipment e ON e.tenant_id = b.tenant_id AND e.id = b.equipment_id
      WHERE b.tenant_id = $1 AND b.plant_id = $2 AND b.id = $3`,
    [ctx.tenantId, plant.id, id]);
  if (!r) throw notFound('Breakdown');
  return r;
}

async function assertEquipmentActive(tx: Tx, ctx: Ctx, plant: PlantCtx, equipmentId: string) {
  const e = await maybeOne<{ is_active: boolean }>(tx,
    'SELECT is_active FROM app.equipment WHERE tenant_id = $1 AND plant_id = $2 AND id = $3', [ctx.tenantId, plant.id, equipmentId]);
  if (!e) throw notFound('Equipment');
  if (!e.is_active) throw unprocessable('EQUIPMENT_INACTIVE', 'This equipment is deactivated.');
}

async function addUpdate(tx: Tx, ctx: Ctx, breakdownId: string, kind: string, statusAfter: string | null, note: string | null) {
  await exec(tx, `INSERT INTO app.breakdown_updates (tenant_id, breakdown_id, user_id, kind, status_after, note)
     VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, breakdownId, ctx.userId, kind, statusAfter, note]);
}

export async function logBreakdown(ctx: Ctx, plant: PlantCtx, b: z.infer<typeof m.breakdownCreateBody>, meta: RequestMeta) {
  const outbox: Array<string | null> = [];
  const row = await withTenant(T(ctx), async (tx) => {
    await assertEquipmentActive(tx, ctx, plant, b.equipmentId);
    if (new Date(b.startedAt).getTime() > Date.now()) throw unprocessable('FUTURE_START', 'Start time cannot be in the future.');
    if (b.expectedRestoreOn < b.startedAt.slice(0, 10)) {
      throw unprocessable('BAD_EXPECTED', 'Expected restoration must be on or after the start date.');
    }
    const r = await one<{ id: string; criticality: string; equipment_name: string }>(tx, `
      WITH ins AS (
        INSERT INTO app.breakdowns (tenant_id, plant_id, equipment_id, started_at, fault, cause_category, impact,
                                    standby_running, action_taken, spares_required, expected_restore_on, status, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12) RETURNING id
      )
      SELECT ins.id, e.criticality, e.name AS equipment_name FROM ins, app.equipment e
       WHERE e.tenant_id = $1 AND e.id = $3`,
      [ctx.tenantId, plant.id, b.equipmentId, b.startedAt, b.fault, b.causeCategory ?? null, b.impact, b.standbyRunning,
        b.actionTaken ?? null, b.sparesRequired ?? null, b.expectedRestoreOn, ctx.userId]);
    await addUpdate(tx, ctx, r.id, 'created', 'open', null);
    await writeAudit(tx, clientActor(ctx), { action: 'breakdown.create', entity: 'breakdown', entityId: r.id, after: b }, meta);
    await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
    await markPdfsStale(tx, ctx.tenantId, plant.id, b.startedAt.slice(0, 10), 'breakdown_changed');
    if (r.criticality === 'critical') {
      outbox.push(...await notify(tx, {
        tenantId: ctx.tenantId, to: await plantRecipients(tx, ctx.tenantId, plant.id, ['client_admin', 'editor']),
        code: 'N-O11', critical: true, email: true,
        title: `${plant.name}: CRITICAL breakdown — ${r.equipment_name}`, body: b.fault,
        link: `/plants/${plant.id}/maintenance/breakdowns/${r.id}`,
      }));
    }
    return r.id;
  });
  sendInBackground(outbox);
  return withTenant(T(ctx), (tx) => loadBreakdown(tx, ctx, plant, row));
}

const OPEN_STATUSES = ['open', 'in_progress', 'awaiting_spares'];

export async function updateBreakdown(ctx: Ctx, plant: PlantCtx, id: string, b: z.infer<typeof m.breakdownPatchBody>, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    const before = await maybeOne<{ status: string; started_at: string }>(tx,
      'SELECT status, started_at FROM app.breakdowns WHERE tenant_id = $1 AND plant_id = $2 AND id = $3 FOR UPDATE',
      [ctx.tenantId, plant.id, id]);
    if (!before) throw notFound('Breakdown');
    if (!OPEN_STATUSES.includes(before.status)) throw conflict('BREAKDOWN_NOT_OPEN', 'This breakdown is already closed.');
    if (b.status && !OPEN_STATUSES.includes(b.status)) throw unprocessable('INVALID_STATUS', 'Use restore/cancel to close a breakdown.');
    const beforeDto = await loadBreakdown(tx, ctx, plant, id);
    const set = setClause({
      fault: b.fault, cause_category: b.causeCategory, impact: b.impact, standby_running: b.standbyRunning,
      action_taken: b.actionTaken, spares_required: b.sparesRequired, expected_restore_on: b.expectedRestoreOn, status: b.status,
    }, 4);
    if (set.values.length) {
      await exec(tx, `UPDATE app.breakdowns SET ${set.sql} WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
        [ctx.tenantId, plant.id, id, ...set.values]);
    }
    if (b.status && b.status !== before.status) await addUpdate(tx, ctx, id, 'status', b.status, b.note ?? null);
    else if (b.note) await addUpdate(tx, ctx, id, 'note', null, b.note);
    const afterDto = await loadBreakdown(tx, ctx, plant, id);
    await writeAudit(tx, clientActor(ctx), { action: 'breakdown.update', entity: 'breakdown', entityId: id, ...diff(beforeDto, afterDto) }, meta);
    await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
    await markPdfsStale(tx, ctx.tenantId, plant.id, before.started_at.slice(0, 10), 'breakdown_changed');
  });
  return withTenant(T(ctx), (tx) => loadBreakdown(tx, ctx, plant, id));
}

export async function restoreBreakdown(ctx: Ctx, plant: PlantCtx, id: string, b: z.infer<typeof m.breakdownRestoreBody>, meta: RequestMeta) {
  const outbox: Array<string | null> = [];
  await withTenant(T(ctx), async (tx) => {
    const before = await maybeOne<{ status: string; started_at: string; equipment_name: string }>(tx,
      `SELECT bd.status, bd.started_at, e.name AS equipment_name
         FROM app.breakdowns bd JOIN app.equipment e ON e.tenant_id = bd.tenant_id AND e.id = bd.equipment_id
        WHERE bd.tenant_id = $1 AND bd.plant_id = $2 AND bd.id = $3 FOR UPDATE`,
      [ctx.tenantId, plant.id, id]);
    if (!before) throw notFound('Breakdown');
    if (!OPEN_STATUSES.includes(before.status)) throw conflict('BREAKDOWN_NOT_OPEN', 'This breakdown is already closed.');
    if (new Date(b.restoredAt).getTime() < new Date(before.started_at).getTime()) {
      throw unprocessable('BAD_RESTORED_AT', 'Restoration time cannot be before the start time.');
    }
    await exec(tx, `UPDATE app.breakdowns SET status = 'restored', restored_at = $4, root_cause = $5, corrective_action = $6,
        cost = $7, updated_by = $8 WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
      [ctx.tenantId, plant.id, id, b.restoredAt, b.rootCause, b.correctiveAction ?? null, b.cost ?? null, ctx.userId]);
    await addUpdate(tx, ctx, id, 'restored', 'restored', b.note ?? null);
    await writeAudit(tx, clientActor(ctx), { action: 'breakdown.restore', entity: 'breakdown', entityId: id, after: b }, meta);
    await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
    await markPdfsStale(tx, ctx.tenantId, plant.id, before.started_at.slice(0, 10), 'breakdown_changed');
    outbox.push(...await notify(tx, {
      tenantId: ctx.tenantId, to: await plantRecipients(tx, ctx.tenantId, plant.id, ['client_admin', 'editor']),
      code: 'N-O14', title: `${plant.name}: breakdown restored — ${before.equipment_name}`, body: b.rootCause,
      link: `/plants/${plant.id}/maintenance/breakdowns/${id}`,
    }));
  });
  sendInBackground(outbox);
  return withTenant(T(ctx), (tx) => loadBreakdown(tx, ctx, plant, id));
}

export async function cancelBreakdown(ctx: Ctx, plant: PlantCtx, id: string, b: z.infer<typeof m.breakdownCancelBody>, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    const before = await maybeOne<{ status: string; started_at: string }>(tx,
      'SELECT status, started_at FROM app.breakdowns WHERE tenant_id = $1 AND plant_id = $2 AND id = $3 FOR UPDATE',
      [ctx.tenantId, plant.id, id]);
    if (!before) throw notFound('Breakdown');
    if (!OPEN_STATUSES.includes(before.status)) throw conflict('BREAKDOWN_NOT_OPEN', 'This breakdown is already closed.');
    await exec(tx, `UPDATE app.breakdowns SET status = 'cancelled', cancelled_reason = $4, updated_by = $5
       WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`, [ctx.tenantId, plant.id, id, b.reason, ctx.userId]);
    await addUpdate(tx, ctx, id, 'cancelled', 'cancelled', b.reason);
    await writeAudit(tx, clientActor(ctx), { action: 'breakdown.cancel', entity: 'breakdown', entityId: id, reason: b.reason }, meta);
    await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
    await markPdfsStale(tx, ctx.tenantId, plant.id, before.started_at.slice(0, 10), 'breakdown_changed');
  });
  return withTenant(T(ctx), (tx) => loadBreakdown(tx, ctx, plant, id));
}

export async function reopenBreakdown(ctx: Ctx, plant: PlantCtx, id: string, b: z.infer<typeof m.breakdownReopenBody>, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    const before = await maybeOne<{ status: string; started_at: string }>(tx,
      'SELECT status, started_at FROM app.breakdowns WHERE tenant_id = $1 AND plant_id = $2 AND id = $3 FOR UPDATE',
      [ctx.tenantId, plant.id, id]);
    if (!before) throw notFound('Breakdown');
    if (before.status !== 'restored') throw conflict('BREAKDOWN_NOT_RESTORED', 'Only a restored breakdown can be reopened.');
    await exec(tx, `UPDATE app.breakdowns SET status = 'open', restored_at = NULL, root_cause = NULL, corrective_action = NULL,
        cost = NULL, updated_by = $4 WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`, [ctx.tenantId, plant.id, id, ctx.userId]);
    await addUpdate(tx, ctx, id, 'reopened', 'open', b.reason);
    await writeAudit(tx, clientActor(ctx), { action: 'breakdown.reopen', entity: 'breakdown', entityId: id, reason: b.reason }, meta);
    await bumpVersions(tx, ctx.tenantId, plant.id, 'data');
    await markPdfsStale(tx, ctx.tenantId, plant.id, before.started_at.slice(0, 10), 'breakdown_changed');
  });
  return withTenant(T(ctx), (tx) => loadBreakdown(tx, ctx, plant, id));
}

export async function addNote(ctx: Ctx, plant: PlantCtx, id: string, b: z.infer<typeof m.breakdownNoteBody>, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    const before = await maybeOne(tx, 'SELECT 1 FROM app.breakdowns WHERE tenant_id = $1 AND plant_id = $2 AND id = $3',
      [ctx.tenantId, plant.id, id]);
    if (!before) throw notFound('Breakdown');
    await addUpdate(tx, ctx, id, 'note', null, b.note);
    await writeAudit(tx, clientActor(ctx), { action: 'breakdown.note', entity: 'breakdown', entityId: id, after: b }, meta);
  });
  return listBreakdownUpdates(ctx, plant, id);
}

export async function listBreakdowns(ctx: Ctx, plant: PlantCtx, q: z.infer<typeof m.breakdownListQuery>) {
  return withTenant(T(ctx), async (tx) => {
    const where = `b.tenant_id = $1 AND b.plant_id = $2
       AND ($3::text IS NULL OR ($3 = 'open_any' AND b.status IN ('open','in_progress','awaiting_spares')) OR b.status = $3)
       AND ($4::date IS NULL OR b.started_at >= $4::date)
       AND ($5::date IS NULL OR b.started_at < ($5::date + 1))
       AND ($6::uuid IS NULL OR b.equipment_id = $6)
       AND ($7::text IS NULL OR e.criticality = $7)`;
    const params = [ctx.tenantId, plant.id, q.status ?? null, q.from ?? null, q.to ?? null, q.equipmentId ?? null, q.criticality ?? null];
    const { total } = await one<{ total: number }>(tx,
      `SELECT count(*) AS total FROM app.breakdowns b JOIN app.equipment e ON e.tenant_id = b.tenant_id AND e.id = b.equipment_id WHERE ${where}`, params);
    const items = await many(tx,
      `SELECT ${BREAKDOWN_COLS} FROM app.breakdowns b JOIN app.equipment e ON e.tenant_id = b.tenant_id AND e.id = b.equipment_id
        WHERE ${where} ORDER BY b.started_at DESC LIMIT $8 OFFSET $9`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    return { items, total };
  });
}

export async function getBreakdown(ctx: Ctx, plant: PlantCtx, id: string) {
  return withTenant(T(ctx), async (tx) => ({
    ...(await loadBreakdown(tx, ctx, plant, id)),
    updates: await listUpdatesTx(tx, ctx, id),
  }));
}

async function listUpdatesTx(tx: Tx, ctx: Ctx, breakdownId: string) {
  return many(tx, `
    SELECT u.id, u.at, u.user_id AS "userId", usr.name AS "userName", u.kind, u.status_after AS "statusAfter", u.note
      FROM app.breakdown_updates u LEFT JOIN app.users usr ON usr.tenant_id = u.tenant_id AND usr.id = u.user_id
     WHERE u.tenant_id = $1 AND u.breakdown_id = $2 ORDER BY u.at`, [ctx.tenantId, breakdownId]);
}

export async function listBreakdownUpdates(ctx: Ctx, plant: PlantCtx, id: string) {
  return withTenant(T(ctx), async (tx) => {
    const exists = await maybeOne(tx, 'SELECT 1 FROM app.breakdowns WHERE tenant_id = $1 AND plant_id = $2 AND id = $3',
      [ctx.tenantId, plant.id, id]);
    if (!exists) throw notFound('Breakdown');
    return listUpdatesTx(tx, ctx, id);
  });
}
