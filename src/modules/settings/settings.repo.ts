import { exec, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import type { TemplateParam } from './stp-template';

export interface ParamLinks {
  linkRole?: string; stockItemId?: string; staffCategoryId?: string; safetyItemId?: string; activeFrom?: string;
}

export async function insertParameter(
  tx: Tx, tenantId: string, plantId: string, p: TemplateParam, links: ParamLinks, actorId: string | null,
): Promise<string> {
  const r = await one<{ id: string }>(
    tx,
    `INSERT INTO app.parameters (tenant_id, plant_id, code, name, short_name, group_key, unit, input_mode, formula, decimals,
        hard_min, hard_max, aggregation, std_type, direction, event_rule, result_noun, link_role, stock_item_id,
        staff_category_id, safety_item_id, logsheet_block, logsheet_order, mis_section, mis_order, dashboard_card,
        dashboard_order, chart_type, chart_metric, mandatory, active_from, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
     RETURNING id`,
    [tenantId, plantId, p.code, p.name, p.shortName ?? null, p.group, p.unit, p.inputMode ?? 'typed', p.formula ?? null,
      p.decimals, p.hardMin ?? null, p.hardMax ?? null, p.aggregation, p.stdType, p.direction, p.eventRule,
      p.resultNoun ?? null, links.linkRole ?? null, links.stockItemId ?? null, links.staffCategoryId ?? null,
      links.safetyItemId ?? null, p.block, p.order, p.misSection ?? null, p.misOrder ?? null, p.dashboardCard ?? false,
      p.dashboardOrder ?? null, p.chartType ?? 'none', p.chartMetric ?? null, p.mandatory ?? (p.aggregation !== 'text'),
      links.activeFrom ?? null, actorId],
  );
  return r.id;
}

/** Same effective date = overwrite (UNIQUE tenant_id, parameter_id, effective_from). */
export async function upsertStandard(
  tx: Tx, tenantId: string, parameterId: string, from: string,
  s: { std?: number | null; monthly?: number | null; min?: number | null; max?: number | null }, reason: string | null,
  actorId: string | null,
): Promise<void> {
  await exec(
    tx,
    `INSERT INTO app.parameter_standards (tenant_id, parameter_id, effective_from, std_value, monthly_allowance,
        limit_min, limit_max, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, parameter_id, effective_from) DO UPDATE SET
       std_value = EXCLUDED.std_value, monthly_allowance = EXCLUDED.monthly_allowance,
       limit_min = EXCLUDED.limit_min, limit_max = EXCLUDED.limit_max, reason = EXCLUDED.reason`,
    [tenantId, parameterId, from, s.std ?? null, s.monthly ?? null, s.min ?? null, s.max ?? null, reason, actorId],
  );
}

export async function upsertConstant(
  tx: Tx, tenantId: string, plantId: string, c: { code: string; name: string; value: number; unit?: string | null },
  from: string, reason: string | null, actorId: string | null,
): Promise<void> {
  await exec(
    tx,
    `INSERT INTO app.plant_constants (tenant_id, plant_id, code, name, value, unit, effective_from, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, plant_id, code, effective_from) DO UPDATE SET
       value = EXCLUDED.value, name = EXCLUDED.name, unit = EXCLUDED.unit, reason = EXCLUDED.reason`,
    [tenantId, plantId, c.code, c.name, c.value, c.unit ?? null, from, reason, actorId],
  );
}

/** STK-02: a stock item creates <CODE>_CONSUMED (typed, with the per-day standard) and <CODE>_RECEIVED (typed, default 0). */
export async function createStockItem(
  tx: Tx, tenantId: string, plantId: string,
  s: { code: string; name: string; unit: string; stdPerDay: number; openingBalance?: number; openingDate?: string | null;
       minLevel?: number | null; dashboardOrder?: number },
  from: string, actorId: string | null,
): Promise<string> {
  const { n } = await one<{ n: number }>(
    tx, 'SELECT count(*) AS n FROM app.stock_items WHERE tenant_id = $1 AND plant_id = $2', [tenantId, plantId]);
  const item = await one<{ id: string }>(
    tx,
    `INSERT INTO app.stock_items (tenant_id, plant_id, name, unit, opening_balance, opening_date, min_level, display_order, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tenantId, plantId, s.name, s.unit, s.openingBalance ?? 0, s.openingDate ?? null, s.minLevel ?? null, n + 1, actorId],
  );
  const consumed = await insertParameter(tx, tenantId, plantId, {
    code: `${s.code}_CONSUMED`, name: `${s.name} consumed`, shortName: s.name, group: 'chemical', unit: s.unit, decimals: 2,
    hardMin: 0, aggregation: 'sum', stdType: 'per_day', direction: 'lower_better', eventRule: 'above_std',
    resultNoun: 'CONSUMED', block: 2, order: (n + 1) * 2 - 1, misSection: 'chemicals', misOrder: n + 1,
    dashboardCard: true, dashboardOrder: s.dashboardOrder ?? 10 + n, chartType: 'line', chartMetric: 'avg_per_day',
  }, { linkRole: 'consumed', stockItemId: item.id }, actorId);
  await upsertStandard(tx, tenantId, consumed, from, { std: s.stdPerDay }, null, actorId);
  await insertParameter(tx, tenantId, plantId, {
    code: `${s.code}_RECEIVED`, name: `${s.name} received`, group: 'chemical', unit: s.unit, decimals: 2, hardMin: 0,
    aggregation: 'sum', stdType: 'none', direction: 'neutral', eventRule: 'none', block: 2, order: (n + 1) * 2,
    mandatory: false,
  }, { linkRole: 'received', stockItemId: item.id }, actorId);
  return item.id;
}

/** STF-02: Vacant / Present / On leave (typed). Absent is derived by the engine. */
export async function createStaffCategory(
  tx: Tx, tenantId: string, plantId: string, s: { code: string; name: string; strength: number }, from: string,
  actorId: string | null,
): Promise<string> {
  const { n } = await one<{ n: number }>(
    tx, 'SELECT count(*) AS n FROM app.staff_categories WHERE tenant_id = $1 AND plant_id = $2', [tenantId, plantId]);
  const cat = await one<{ id: string }>(
    tx, `INSERT INTO app.staff_categories (tenant_id, plant_id, name, display_order, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, plantId, s.name, n + 1, actorId]);
  await exec(
    tx, `INSERT INTO app.staff_strengths (tenant_id, category_id, effective_from, strength, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, cat.id, from, s.strength, actorId]);
  const roles: Array<[string, string]> = [['VACANT', 'vacant'], ['PRESENT', 'present'], ['LEAVE', 'leave']];
  for (const [i, [suffix, role]] of roles.entries()) {
    await insertParameter(tx, tenantId, plantId, {
      code: `STAFF_${s.code}_${suffix}`, name: `${s.name} ${role === 'leave' ? 'on leave' : role}`, group: 'staff', unit: 'Nos',
      decimals: 0, hardMin: 0, aggregation: 'snapshot', stdType: 'none', direction: 'neutral', eventRule: 'none',
      block: 6, order: n * 3 + i + 1,
    }, { linkRole: role, staffCategoryId: cat.id }, actorId);
  }
  return cat.id;
}

/** SAF-01: one typed "available" parameter per item; the required quantity is effective-dated. */
export async function createSafetyItem(
  tx: Tx, tenantId: string, plantId: string, s: { code: string; name: string; qty: number }, from: string,
  actorId: string | null,
): Promise<string> {
  const { n } = await one<{ n: number }>(
    tx, 'SELECT count(*) AS n FROM app.safety_items WHERE tenant_id = $1 AND plant_id = $2', [tenantId, plantId]);
  const item = await one<{ id: string }>(
    tx, `INSERT INTO app.safety_items (tenant_id, plant_id, name, display_order, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, plantId, s.name, n + 1, actorId]);
  await exec(
    tx, `INSERT INTO app.safety_requirements (tenant_id, item_id, effective_from, qty, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, item.id, from, s.qty, actorId]);
  await insertParameter(tx, tenantId, plantId, {
    code: `SAFE_${s.code}`, name: `${s.name} available`, shortName: s.name, group: 'safety', unit: 'Nos', decimals: 0,
    hardMin: 0, aggregation: 'snapshot', stdType: 'required_qty', direction: 'higher_better', eventRule: 'below_std',
    block: 5, order: n + 1,
  }, { linkRole: 'available', safetyItemId: item.id }, actorId);
  return item.id;
}

/** Site cash parameters (CSH-*): expense, received, description. */
export async function createCashParameters(tx: Tx, tenantId: string, plantId: string, actorId: string | null): Promise<void> {
  await insertParameter(tx, tenantId, plantId, {
    code: 'CASH_EXPENSE', name: 'Expenses today', group: 'cash', unit: 'INR', decimals: 0, hardMin: 0, aggregation: 'sum',
    stdType: 'none', direction: 'lower_better', eventRule: 'none', block: 7, order: 1, dashboardCard: true,
    dashboardOrder: 40, chartType: 'line', chartMetric: 'monthly_total',
  }, { linkRole: 'expense' }, actorId);
  await insertParameter(tx, tenantId, plantId, {
    code: 'CASH_RECEIVED', name: 'Petty cash received', group: 'cash', unit: 'INR', decimals: 0, hardMin: 0,
    aggregation: 'sum', stdType: 'none', direction: 'neutral', eventRule: 'none', block: 7, order: 2, mandatory: false,
  }, { linkRole: 'cash_received' }, actorId);
  await insertParameter(tx, tenantId, plantId, {
    code: 'CASH_DESC', name: 'Description of expenses', group: 'cash', unit: 'text', decimals: 0, aggregation: 'text',
    stdType: 'none', direction: 'neutral', eventRule: 'none', block: 7, order: 3, mandatory: false,
  }, { linkRole: 'description' }, actorId);
}
