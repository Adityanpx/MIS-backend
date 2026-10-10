import { exec, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { conflict } from '../../lib/errors';
import {
  createCashParameters, createSafetyItem, createStaffCategory, createStockItem, insertParameter, upsertConstant, upsertStandard,
} from './settings.repo';
import { STP_TEMPLATE, type PlantTemplate } from './stp-template';

/** TPL-01: fills an EMPTY plant with the template. Standards, constants and strengths are effective from the MIS start. */
export async function applyTemplate(
  tx: Tx, tenantId: string, plantId: string, misStart: string, actorId: string | null, template: PlantTemplate = STP_TEMPLATE,
): Promise<void> {
  const { n } = await one<{ n: number }>(
    tx, 'SELECT count(*) AS n FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2', [tenantId, plantId]);
  if (n > 0) throw conflict('SETTINGS_NOT_EMPTY', 'This plant already has parameters.');
  for (const c of template.constants) await upsertConstant(tx, tenantId, plantId, c, misStart, null, actorId);
  for (const p of template.parameters) {
    const id = await insertParameter(tx, tenantId, plantId, p, {}, actorId);
    if (p.standard) await upsertStandard(tx, tenantId, id, misStart, p.standard, null, actorId);
  }
  for (const s of template.stockItems) {
    await createStockItem(tx, tenantId, plantId, { ...s, openingDate: null }, misStart, actorId);
  }
  for (const s of template.staff) await createStaffCategory(tx, tenantId, plantId, s, misStart, actorId);
  for (const s of template.safety) await createSafetyItem(tx, tenantId, plantId, s, misStart, actorId);
  await createCashParameters(tx, tenantId, plantId, actorId);
  await exec(
    tx, 'UPDATE app.plant_settings SET cash_alert_limit = $3, petty_float = $4 WHERE tenant_id = $1 AND plant_id = $2',
    [tenantId, plantId, template.cash.alertLimit, template.cash.pettyFloat]);
}
