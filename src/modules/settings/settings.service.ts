import { randomUUID } from 'node:crypto';
import { exec, many, maybeOne, one, setClause } from '../../db/sql';
import { withTenant, type Tx } from '../../db/tenant';
import { tenantTx } from '../../lib/context';
import { addDays, todayIST } from '../../lib/dates';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { D, money } from '../../lib/money';
import type { RequestMeta } from '../../lib/request-meta';
import { FormulaError, orderCalculated, parseFormula, formulaRefs } from '../../shared/formula';
import type { ClientCtx, PlantCtx } from '../../types/express';
import { clientActor, diff, writeAudit } from '../audit/audit.service';
import { assertTenantKey, signedUrlOrNull, storage, tenantKey } from '../files/storage';
import type { AllowedKind } from '../files/upload';
import { applyTemplate } from './apply-template';
import {
  createSafetyItem, createStaffCategory, createStockItem, insertParameter, upsertConstant, upsertStandard,
} from './settings.repo';
import { bumpVersions, markPdfsStale, requestRecalc } from './versions';

type Ctx = ClientCtx;
const T = (ctx: Ctx) => tenantTx(ctx);

/** Every write in this module: audit + settings_version++ + (optionally) stale PDFs and a recalculation after commit. */
async function changed(
  tx: Tx, ctx: Ctx, plant: PlantCtx, meta: RequestMeta,
  audit: { action: string; entity: string; entityId?: string | null; before?: unknown; after?: unknown; reason?: string | null },
  recalcFrom: string | null,
): Promise<string | null> {
  await writeAudit(tx, clientActor(ctx), audit, meta);
  await bumpVersions(tx, ctx.tenantId, plant.id, 'settings');
  if (recalcFrom) await markPdfsStale(tx, ctx.tenantId, plant.id, recalcFrom, 'settings_changed');
  return recalcFrom;
}
async function afterCommit(ctx: Ctx, plant: PlantCtx, recalcFrom: string | null): Promise<void> {
  if (recalcFrom) await requestRecalc(ctx.tenantId, plant.id, recalcFrom);
}

/** CHG-01/02: effective date defaults to today; a backdated change needs a reason. Never before the O&M start. */
function effectiveDate(plant: PlantCtx, input: { effectiveFrom?: string; reason?: string }): { from: string; reason: string | null } {
  const today = todayIST();
  const from = input.effectiveFrom ?? today;
  if (from < plant.omStart || from > plant.omEnd) {
    throw unprocessable('EFFECTIVE_DATE_OUT_OF_RANGE', 'The effective date must be within the O&M contract period.');
  }
  if (from < today && !input.reason) {
    throw unprocessable('REASON_REQUIRED', 'A reason is required for a backdated change (it recalculates past reports).');
  }
  return { from, reason: input.reason ?? null };
}

// ======================================================================= general (§11.1)
export async function getGeneral(ctx: Ctx, plant: PlantCtx) {
  return withTenant(T(ctx), async (tx) => {
    const r = await one<Record<string, unknown>>(
      tx,
      `SELECT p.name, p.code, p.type, p.capacity_mld, p.om_start, p.om_tenure_months, p.om_end, p.mis_start, p.setup_status,
              s.end_customer_name, s.report_company_name, s.logsheet_title, s.dashboard_title, s.tagline,
              s.sig_prepared_label, s.sig_checked_label, s.sig_verified_label, s.allow_same_day, s.editor_backfill_days,
              s.approval_enabled, s.avg_divisor, s.pdf_prefix_mis
         FROM app.plants p JOIN app.plant_settings s ON s.tenant_id = p.tenant_id AND s.plant_id = p.id
        WHERE p.tenant_id = $1 AND p.id = $2`,
      [ctx.tenantId, plant.id],
    );
    return {
      name: r.name, code: r.code, type: r.type, capacityMld: Number(r.capacity_mld), omStart: r.om_start,
      omTenureMonths: r.om_tenure_months, omEnd: r.om_end, misStart: r.mis_start, setupStatus: r.setup_status,
      endCustomerName: r.end_customer_name, reportCompanyName: r.report_company_name, logsheetTitle: r.logsheet_title,
      dashboardTitle: r.dashboard_title, tagline: r.tagline, sigPreparedLabel: r.sig_prepared_label,
      sigCheckedLabel: r.sig_checked_label, sigVerifiedLabel: r.sig_verified_label, allowSameDay: r.allow_same_day,
      editorBackfillDays: r.editor_backfill_days, approvalEnabled: r.approval_enabled, avgDivisor: r.avg_divisor,
      pdfPrefixMis: r.pdf_prefix_mis,
    };
  });
}

export async function patchGeneral(ctx: Ctx, plant: PlantCtx, b: Record<string, unknown> & {
  displayName?: string; misStart?: string; confirmMisStartChange?: boolean;
}, meta: RequestMeta) {
  let recalc: string | null = null;
  await withTenant(T(ctx), async (tx) => {
    const before = await getGeneralRow(tx, ctx, plant);
    if (b.displayName !== undefined) {
      await exec(tx, 'UPDATE app.plants SET name = $3 WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, plant.id, b.displayName]);
    }
    if (b.misStart !== undefined && b.misStart !== plant.misStart) {
      if (b.misStart < plant.omStart || b.misStart > plant.omEnd) {
        throw unprocessable('MIS_START_OUT_OF_RANGE', 'MIS start must be within the O&M contract period.');
      }
      const first = await maybeOne<{ d: string }>(
        tx, 'SELECT min(log_date) AS d FROM app.logsheets WHERE tenant_id = $1 AND plant_id = $2', [ctx.tenantId, plant.id]);
      // SET-03: once logsheets exist, the MIS start may only move earlier, and only with confirmation.
      if (first?.d && (b.misStart > plant.misStart || b.misStart > first.d || !b.confirmMisStartChange)) {
        throw unprocessable('MIS_START_LOCKED', 'Logsheets exist: the MIS start can only move earlier, with confirmation.');
      }
      await exec(tx, 'UPDATE app.plants SET mis_start = $3 WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, plant.id, b.misStart]);
      recalc = b.misStart < plant.misStart ? b.misStart : plant.misStart;
    }
    const set = setClause({
      end_customer_name: b.endCustomerName, report_company_name: b.reportCompanyName, logsheet_title: b.logsheetTitle,
      dashboard_title: b.dashboardTitle, tagline: b.tagline, sig_prepared_label: b.sigPreparedLabel,
      sig_checked_label: b.sigCheckedLabel, sig_verified_label: b.sigVerifiedLabel, allow_same_day: b.allowSameDay,
      editor_backfill_days: b.editorBackfillDays, avg_divisor: b.avgDivisor, pdf_prefix_mis: b.pdfPrefixMis,
    }, 3);
    if (set.values.length) {
      await exec(tx, `UPDATE app.plant_settings SET ${set.sql} WHERE tenant_id = $1 AND plant_id = $2`,
        [ctx.tenantId, plant.id, ...set.values]);
    }
    if (b.avgDivisor !== undefined) recalc = recalc ?? plant.misStart; // averages change everywhere
    const after = await getGeneralRow(tx, ctx, plant);
    await changed(tx, ctx, plant, meta, { action: 'settings.general_update', entity: 'plant', entityId: plant.id, ...diff(before, after) },
      recalc ?? (JSON.stringify(before) !== JSON.stringify(after) ? plant.misStart : null));
  });
  await afterCommit(ctx, plant, recalc ?? plant.misStart);
  return getGeneral(ctx, plant);
}
async function getGeneralRow(tx: Tx, ctx: Ctx, plant: PlantCtx): Promise<Record<string, unknown>> {
  return one(tx,
    `SELECT p.name, p.mis_start, s.end_customer_name, s.report_company_name, s.logsheet_title, s.dashboard_title, s.tagline,
            s.sig_prepared_label, s.sig_checked_label, s.sig_verified_label, s.allow_same_day, s.editor_backfill_days,
            s.avg_divisor, s.pdf_prefix_mis
       FROM app.plants p JOIN app.plant_settings s ON s.tenant_id = p.tenant_id AND s.plant_id = p.id
      WHERE p.tenant_id = $1 AND p.id = $2`, [ctx.tenantId, plant.id]);
}

// ======================================================================= parameters (§11.2)
const PARAM_COLS = `id, code, name, short_name, group_key, unit, input_mode, formula, decimals, hard_min, hard_max, aggregation,
  std_type, direction, event_rule, result_noun, link_role, stock_item_id, staff_category_id, safety_item_id, logsheet_block,
  logsheet_order, mis_section, mis_order, dashboard_card, dashboard_order, chart_type, chart_metric, mandatory, active_from, active_to`;

interface ParamRow {
  id: string; code: string; name: string; short_name: string | null; group_key: string; unit: string; input_mode: string;
  formula: string | null; decimals: number; hard_min: string | null; hard_max: string | null; aggregation: string;
  std_type: string; direction: string; event_rule: string; result_noun: string | null; link_role: string | null;
  stock_item_id: string | null; staff_category_id: string | null; safety_item_id: string | null;
  logsheet_block: number | null; logsheet_order: number | null; mis_section: string | null; mis_order: number | null;
  dashboard_card: boolean; dashboard_order: number | null; chart_type: string; chart_metric: string | null;
  mandatory: boolean; active_from: string | null; active_to: string | null;
}
const numOrNull = (v: string | null) => (v === null ? null : Number(v));
export const toParamDto = (r: ParamRow, standards: unknown[] = []) => ({
  id: r.id, code: r.code, name: r.name, shortName: r.short_name, groupKey: r.group_key, unit: r.unit, inputMode: r.input_mode,
  formula: r.formula, decimals: r.decimals, hardMin: numOrNull(r.hard_min), hardMax: numOrNull(r.hard_max),
  aggregation: r.aggregation, stdType: r.std_type, direction: r.direction, eventRule: r.event_rule, resultNoun: r.result_noun,
  linkRole: r.link_role, stockItemId: r.stock_item_id, staffCategoryId: r.staff_category_id, safetyItemId: r.safety_item_id,
  logsheetBlock: r.logsheet_block, logsheetOrder: r.logsheet_order, misSection: r.mis_section, misOrder: r.mis_order,
  dashboardCard: r.dashboard_card, dashboardOrder: r.dashboard_order, chartType: r.chart_type, chartMetric: r.chart_metric,
  mandatory: r.mandatory, activeFrom: r.active_from, activeTo: r.active_to, standards,
});

async function loadParam(tx: Tx, ctx: Ctx, plant: PlantCtx, id: string): Promise<ParamRow> {
  const r = await maybeOne<ParamRow>(tx, `SELECT ${PARAM_COLS} FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
    [ctx.tenantId, plant.id, id]);
  if (!r) throw notFound('Parameter');
  return r;
}
const standardsOf = (tx: Tx, ctx: Ctx, paramId: string) =>
  many<{ effective_from: string; std_value: string | null; monthly_allowance: string | null; limit_min: string | null; limit_max: string | null; reason: string | null }>(
    tx,
    `SELECT effective_from, std_value, monthly_allowance, limit_min, limit_max, reason FROM app.parameter_standards
      WHERE tenant_id = $1 AND parameter_id = $2 ORDER BY effective_from`,
    [ctx.tenantId, paramId],
  ).then((rows) => rows.map((s) => ({
    effectiveFrom: s.effective_from, std: numOrNull(s.std_value), monthly: numOrNull(s.monthly_allowance),
    min: numOrNull(s.limit_min), max: numOrNull(s.limit_max), reason: s.reason,
  })));

export async function listParameters(ctx: Ctx, plant: PlantCtx) {
  return withTenant(T(ctx), async (tx) => {
    const rows = await many<ParamRow>(tx,
      `SELECT ${PARAM_COLS} FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 ORDER BY logsheet_block, logsheet_order, code`,
      [ctx.tenantId, plant.id]);
    const out = [];
    for (const r of rows) out.push(toParamDto(r, await standardsOf(tx, ctx, r.id)));
    return out;
  });
}
export async function getParameter(ctx: Ctx, plant: PlantCtx, id: string) {
  return withTenant(T(ctx), async (tx) => toParamDto(await loadParam(tx, ctx, plant, id), await standardsOf(tx, ctx, id)));
}

/** PAR-06: refs must be existing parameter or constant codes, no circular references. */
async function validateFormulas(tx: Tx, ctx: Ctx, plant: PlantCtx, change: { code: string; formula: string | null }): Promise<void> {
  const params = await many<{ code: string; formula: string | null; input_mode: string }>(
    tx, 'SELECT code, formula, input_mode FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2', [ctx.tenantId, plant.id]);
  const consts = await many<{ code: string }>(
    tx, 'SELECT DISTINCT code FROM app.plant_constants WHERE tenant_id = $1 AND plant_id = $2', [ctx.tenantId, plant.id]);
  const known = new Set([...params.map((p) => p.code), ...consts.map((c) => c.code), change.code]);
  const formulas: Record<string, string> = {};
  for (const p of params) if (p.input_mode !== 'typed' && p.formula && p.code !== change.code) formulas[p.code] = p.formula;
  if (change.formula) formulas[change.code] = change.formula;
  try {
    for (const [c, f] of Object.entries(formulas)) {
      for (const ref of formulaRefs(parseFormula(f))) {
        if (!known.has(ref)) throw new FormulaError(`Unknown code "${ref}" in the formula of ${c}`);
      }
    }
    orderCalculated(formulas);
  } catch (e) {
    if (e instanceof FormulaError) throw unprocessable('INVALID_FORMULA', e.message, { field: 'formula' });
    throw e;
  }
}

export async function createParameter(ctx: Ctx, plant: PlantCtx, b: {
  code: string; name: string; shortName?: string; groupKey: string; unit: string; inputMode: string; formula?: string;
  decimals: number; hardMin?: number | null; hardMax?: number | null; aggregation: string; stdType: string; direction: string;
  eventRule: string; resultNoun?: string; logsheetBlock?: number; logsheetOrder?: number; misSection?: string | null;
  misOrder?: number; dashboardCard: boolean; dashboardOrder?: number; chartType: string; chartMetric?: string | null;
  mandatory: boolean; standard?: { std?: number; monthly?: number; min?: number; max?: number };
}, meta: RequestMeta) {
  const id = await withTenant(T(ctx), async (tx) => {
    const exists = await maybeOne(tx, 'SELECT 1 FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 AND code = $3',
      [ctx.tenantId, plant.id, b.code]);
    if (exists) throw conflict('CODE_TAKEN', 'A parameter with this code already exists.');
    if (b.inputMode !== 'typed') await validateFormulas(tx, ctx, plant, { code: b.code, formula: b.formula ?? null });
    const today = todayIST();
    const newId = await insertParameter(tx, ctx.tenantId, plant.id, {
      code: b.code, name: b.name, shortName: b.shortName, group: b.groupKey as never, unit: b.unit,
      inputMode: b.inputMode as never, formula: b.formula, decimals: b.decimals, hardMin: b.hardMin ?? undefined,
      hardMax: b.hardMax ?? undefined, aggregation: b.aggregation as never, stdType: b.stdType as never,
      direction: b.direction as never, eventRule: b.eventRule as never, resultNoun: b.resultNoun,
      block: b.logsheetBlock ?? 8, order: b.logsheetOrder ?? 99, misSection: (b.misSection ?? undefined) as never,
      misOrder: b.misOrder, dashboardCard: b.dashboardCard, dashboardOrder: b.dashboardOrder,
      chartType: b.chartType as never, chartMetric: (b.chartMetric ?? undefined) as never, mandatory: b.mandatory,
    }, { activeFrom: today > plant.misStart ? today : undefined }, ctx.userId);
    if (b.standard) await upsertStandard(tx, ctx.tenantId, newId, plant.misStart, b.standard, null, ctx.userId);
    await changed(tx, ctx, plant, meta, { action: 'parameter.create', entity: 'parameter', entityId: newId, after: b }, null);
    return newId;
  });
  return getParameter(ctx, plant, id);
}

export async function patchParameter(ctx: Ctx, plant: PlantCtx, id: string, b: Record<string, unknown>, meta: RequestMeta) {
  let recalc: string | null = null;
  await withTenant(T(ctx), async (tx) => {
    const before = await loadParam(tx, ctx, plant, id);
    if (b.formula !== undefined || b.inputMode !== undefined) {
      const mode = (b.inputMode as string | undefined) ?? before.input_mode;
      const formula = (b.formula as string | undefined) ?? before.formula;
      if (mode !== 'typed') {
        if (!formula) throw unprocessable('INVALID_FORMULA', 'A formula is required', { field: 'formula' });
        await validateFormulas(tx, ctx, plant, { code: before.code, formula });
      }
      recalc = plant.misStart;
    }
    if (['aggregation', 'stdType', 'eventRule', 'direction'].some((k) => b[k] !== undefined)) recalc = plant.misStart;
    const set = setClause({
      name: b.name, short_name: b.shortName, group_key: b.groupKey, unit: b.unit, input_mode: b.inputMode, formula: b.formula,
      decimals: b.decimals, hard_min: b.hardMin, hard_max: b.hardMax, aggregation: b.aggregation, std_type: b.stdType,
      direction: b.direction, event_rule: b.eventRule, result_noun: b.resultNoun, logsheet_block: b.logsheetBlock,
      logsheet_order: b.logsheetOrder, mis_section: b.misSection, mis_order: b.misOrder, dashboard_card: b.dashboardCard,
      dashboard_order: b.dashboardOrder, chart_type: b.chartType, chart_metric: b.chartMetric, mandatory: b.mandatory,
    }, 4);
    if (set.values.length === 0) return;
    await exec(tx, `UPDATE app.parameters SET ${set.sql} WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
      [ctx.tenantId, plant.id, id, ...set.values]);
    const after = await loadParam(tx, ctx, plant, id);
    await changed(tx, ctx, plant, meta, {
      action: 'parameter.update', entity: 'parameter', entityId: id,
      ...diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>),
    }, recalc);
  });
  await afterCommit(ctx, plant, recalc);
  return getParameter(ctx, plant, id);
}

/** PAR-17: the parameter disappears from the logsheet and reports from `effectiveFrom`; history is kept. */
export async function deactivateParameter(ctx: Ctx, plant: PlantCtx, id: string, b: { effectiveFrom?: string; reason?: string }, meta: RequestMeta) {
  const { from, reason } = effectiveDate(plant, b);
  await withTenant(T(ctx), async (tx) => {
    const p = await loadParam(tx, ctx, plant, id);
    const used = await maybeOne(tx,
      `SELECT 1 FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 AND formula ~ ('\\m' || $3 || '\\M') AND active_to IS NULL`,
      [ctx.tenantId, plant.id, p.code]);
    if (used) throw conflict('PARAMETER_IN_USE', 'Another calculated parameter uses this code.');
    await exec(tx, 'UPDATE app.parameters SET active_to = $4 WHERE tenant_id = $1 AND plant_id = $2 AND id = $3',
      [ctx.tenantId, plant.id, id, addDays(from, -1)]);
    await changed(tx, ctx, plant, meta, { action: 'parameter.deactivate', entity: 'parameter', entityId: id, after: { from }, reason }, from);
  });
  await afterCommit(ctx, plant, from);
  return getParameter(ctx, plant, id);
}

export async function addStandard(ctx: Ctx, plant: PlantCtx, id: string, b: {
  std?: number | null; monthly?: number | null; min?: number | null; max?: number | null; effectiveFrom?: string; reason?: string;
}, meta: RequestMeta) {
  const { from, reason } = effectiveDate(plant, b);
  if (b.min != null && b.max != null && b.min > b.max) throw badRequest('INVALID_RANGE', 'Minimum must not exceed maximum.');
  await withTenant(T(ctx), async (tx) => {
    await loadParam(tx, ctx, plant, id);
    await upsertStandard(tx, ctx.tenantId, id, from, b, reason, ctx.userId);
    await changed(tx, ctx, plant, meta, { action: 'parameter.standard_set', entity: 'parameter', entityId: id, after: { ...b, from }, reason }, from);
  });
  await afterCommit(ctx, plant, from);
  return getParameter(ctx, plant, id);
}

// ======================================================================= constants (§11.3)
export async function listConstants(ctx: Ctx, plant: PlantCtx) {
  return withTenant(T(ctx), async (tx) =>
    (await many<{ code: string; name: string; value: string; unit: string | null; effective_from: string; reason: string | null }>(tx,
      `SELECT code, name, value, unit, effective_from, reason FROM app.plant_constants WHERE tenant_id = $1 AND plant_id = $2
        ORDER BY code, effective_from`, [ctx.tenantId, plant.id]))
      .map((c) => ({ code: c.code, name: c.name, value: Number(c.value), unit: c.unit, effectiveFrom: c.effective_from, reason: c.reason })));
}
export async function addConstant(ctx: Ctx, plant: PlantCtx, b: {
  code: string; name: string; value: number; unit?: string; effectiveFrom?: string; reason?: string;
}, meta: RequestMeta) {
  const { from, reason } = effectiveDate(plant, b);
  await withTenant(T(ctx), async (tx) => {
    await upsertConstant(tx, ctx.tenantId, plant.id, b, from, reason, ctx.userId);
    await changed(tx, ctx, plant, meta, { action: 'constant.set', entity: 'plant_constant', entityId: b.code, after: { ...b, from }, reason }, from);
  });
  await afterCommit(ctx, plant, from);
  return listConstants(ctx, plant);
}

// ======================================================================= stock items (§11.5)
export async function listStockItems(ctx: Ctx, plant: PlantCtx) {
  return withTenant(T(ctx), async (tx) =>
    (await many<Record<string, string | number | boolean | null>>(tx,
      `SELECT s.id, s.name, s.unit, s.opening_balance, s.opening_date, s.min_level, s.display_order, s.is_active,
              (SELECT p.code FROM app.parameters p WHERE p.tenant_id = s.tenant_id AND p.stock_item_id = s.id AND p.link_role = 'consumed') AS consumed_code,
              (SELECT ps.std_value FROM app.parameter_standards ps JOIN app.parameters p ON p.tenant_id = ps.tenant_id AND p.id = ps.parameter_id
                WHERE p.tenant_id = s.tenant_id AND p.stock_item_id = s.id AND p.link_role = 'consumed'
                ORDER BY ps.effective_from DESC LIMIT 1) AS std_per_day
         FROM app.stock_items s WHERE s.tenant_id = $1 AND s.plant_id = $2 ORDER BY s.display_order`,
      [ctx.tenantId, plant.id]))
      .map((s) => ({
        id: s.id, name: s.name, unit: s.unit, openingBalance: Number(s.opening_balance), openingDate: s.opening_date,
        minLevel: s.min_level === null ? null : Number(s.min_level), displayOrder: s.display_order, isActive: s.is_active,
        code: String(s.consumed_code ?? '').replace(/_CONSUMED$/, ''), stdPerDay: s.std_per_day === null ? null : Number(s.std_per_day),
      })));
}
export async function addStockItem(ctx: Ctx, plant: PlantCtx, b: {
  name: string; unit: string; code?: string; stdPerDay: number; openingBalance: number; openingDate?: string; minLevel?: number | null;
}, meta: RequestMeta) {
  const code = b.code ?? b.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  const openingDate = b.openingDate ?? addDays(plant.misStart, -1);
  await withTenant(T(ctx), async (tx) => {
    const exists = await maybeOne(tx, 'SELECT 1 FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 AND code = $3',
      [ctx.tenantId, plant.id, `${code}_CONSUMED`]);
    if (exists) throw conflict('CODE_TAKEN', 'A stock item with this code already exists.');
    const id = await createStockItem(tx, ctx.tenantId, plant.id, { ...b, code, openingDate }, plant.misStart, ctx.userId);
    await changed(tx, ctx, plant, meta, { action: 'stock_item.create', entity: 'stock_item', entityId: id, after: b }, openingDate);
  });
  await afterCommit(ctx, plant, openingDate);
  return listStockItems(ctx, plant);
}
export async function patchStockItem(ctx: Ctx, plant: PlantCtx, id: string, b: {
  name?: string; unit?: string; openingBalance?: number; openingDate?: string; minLevel?: number | null; displayOrder?: number;
  isActive?: boolean; reason?: string;
}, meta: RequestMeta) {
  let recalc: string | null = null;
  await withTenant(T(ctx), async (tx) => {
    const before = await maybeOne<Record<string, unknown>>(tx,
      'SELECT name, unit, opening_balance, opening_date, min_level, display_order, is_active FROM app.stock_items WHERE tenant_id = $1 AND plant_id = $2 AND id = $3',
      [ctx.tenantId, plant.id, id]);
    if (!before) throw notFound('Stock item');
    if (b.openingBalance !== undefined || b.openingDate !== undefined) {
      const hasData = await maybeOne(tx, 'SELECT 1 FROM app.logsheets WHERE tenant_id = $1 AND plant_id = $2 LIMIT 1', [ctx.tenantId, plant.id]);
      if (hasData && !b.reason) throw unprocessable('REASON_REQUIRED', 'Changing an opening balance after data exists needs a reason.');
      recalc = b.openingDate ?? (before.opening_date as string | null) ?? addDays(plant.misStart, -1);
    }
    const set = setClause({ name: b.name, unit: b.unit, opening_balance: b.openingBalance, opening_date: b.openingDate,
      min_level: b.minLevel, display_order: b.displayOrder, is_active: b.isActive }, 4);
    if (set.values.length) {
      await exec(tx, `UPDATE app.stock_items SET ${set.sql} WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
        [ctx.tenantId, plant.id, id, ...set.values]);
    }
    const after = await one<Record<string, unknown>>(tx,
      'SELECT name, unit, opening_balance, opening_date, min_level, display_order, is_active FROM app.stock_items WHERE tenant_id = $1 AND id = $2',
      [ctx.tenantId, id]);
    await changed(tx, ctx, plant, meta, { action: 'stock_item.update', entity: 'stock_item', entityId: id, ...diff(before, after), reason: b.reason }, recalc);
  });
  await afterCommit(ctx, plant, recalc);
  return listStockItems(ctx, plant);
}
/** STK-06: dated adjustment (physical count difference); included in the balance from that date. */
export async function addStockAdjustment(ctx: Ctx, plant: PlantCtx, id: string, b: { adjDate: string; qty: number; reason: string }, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    const item = await maybeOne(tx, 'SELECT 1 FROM app.stock_items WHERE tenant_id = $1 AND plant_id = $2 AND id = $3', [ctx.tenantId, plant.id, id]);
    if (!item) throw notFound('Stock item');
    await exec(tx, `INSERT INTO app.stock_adjustments (tenant_id, stock_item_id, adj_date, qty, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.tenantId, id, b.adjDate, b.qty, b.reason, ctx.userId]);
    await changed(tx, ctx, plant, meta, { action: 'stock.adjust', entity: 'stock_item', entityId: id, after: b, reason: b.reason }, b.adjDate);
  });
  await afterCommit(ctx, plant, b.adjDate);
}

// ======================================================================= staff & safety (§11.7–11.8)
export async function listStaff(ctx: Ctx, plant: PlantCtx) {
  return withTenant(T(ctx), async (tx) => {
    const cats = await many<{ id: string; name: string; display_order: number; is_active: boolean }>(tx,
      'SELECT id, name, display_order, is_active FROM app.staff_categories WHERE tenant_id = $1 AND plant_id = $2 ORDER BY display_order',
      [ctx.tenantId, plant.id]);
    const out = [];
    for (const c of cats) {
      const s = await many<{ effective_from: string; strength: number; reason: string | null }>(tx,
        'SELECT effective_from, strength, reason FROM app.staff_strengths WHERE tenant_id = $1 AND category_id = $2 ORDER BY effective_from',
        [ctx.tenantId, c.id]);
      out.push({ id: c.id, name: c.name, displayOrder: c.display_order, isActive: c.is_active,
        strengths: s.map((x) => ({ effectiveFrom: x.effective_from, strength: x.strength, reason: x.reason })) });
    }
    return out;
  });
}
export async function listSafety(ctx: Ctx, plant: PlantCtx) {
  return withTenant(T(ctx), async (tx) => {
    const items = await many<{ id: string; name: string; display_order: number; is_active: boolean }>(tx,
      'SELECT id, name, display_order, is_active FROM app.safety_items WHERE tenant_id = $1 AND plant_id = $2 ORDER BY display_order',
      [ctx.tenantId, plant.id]);
    const out = [];
    for (const i of items) {
      const r = await many<{ effective_from: string; qty: number; reason: string | null }>(tx,
        'SELECT effective_from, qty, reason FROM app.safety_requirements WHERE tenant_id = $1 AND item_id = $2 ORDER BY effective_from',
        [ctx.tenantId, i.id]);
      out.push({ id: i.id, name: i.name, displayOrder: i.display_order, isActive: i.is_active,
        requirements: r.map((x) => ({ effectiveFrom: x.effective_from, qty: x.qty, reason: x.reason })) });
    }
    return out;
  });
}
const codeFrom = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20);

export async function addStaffCategory(ctx: Ctx, plant: PlantCtx, b: { name: string; code?: string; strength: number }, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    const id = await createStaffCategory(tx, ctx.tenantId, plant.id, { code: b.code ?? codeFrom(b.name), name: b.name, strength: b.strength },
      plant.misStart, ctx.userId);
    await changed(tx, ctx, plant, meta, { action: 'staff_category.create', entity: 'staff_category', entityId: id, after: b }, null);
  });
  return listStaff(ctx, plant);
}
export async function addSafetyItem(ctx: Ctx, plant: PlantCtx, b: { name: string; code?: string; qty: number }, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    const id = await createSafetyItem(tx, ctx.tenantId, plant.id, { code: b.code ?? codeFrom(b.name), name: b.name, qty: b.qty },
      plant.misStart, ctx.userId);
    await changed(tx, ctx, plant, meta, { action: 'safety_item.create', entity: 'safety_item', entityId: id, after: b }, null);
  });
  return listSafety(ctx, plant);
}
export async function patchItem(ctx: Ctx, plant: PlantCtx, kind: 'staff' | 'safety', id: string,
  b: { name?: string; displayOrder?: number; isActive?: boolean }, meta: RequestMeta) {
  const table = kind === 'staff' ? 'app.staff_categories' : 'app.safety_items';
  await withTenant(T(ctx), async (tx) => {
    const set = setClause({ name: b.name, display_order: b.displayOrder, is_active: b.isActive }, 4);
    if (!set.values.length) return;
    const n = await exec(tx, `UPDATE ${table} SET ${set.sql} WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
      [ctx.tenantId, plant.id, id, ...set.values]);
    if (n === 0) throw notFound(kind === 'staff' ? 'Staff category' : 'Safety item');
    await changed(tx, ctx, plant, meta, { action: `${kind}.update`, entity: kind, entityId: id, after: b }, null);
  });
  return kind === 'staff' ? listStaff(ctx, plant) : listSafety(ctx, plant);
}
export async function addStrength(ctx: Ctx, plant: PlantCtx, kind: 'staff' | 'safety', id: string,
  b: { strength?: number; qty?: number; effectiveFrom?: string; reason?: string }, meta: RequestMeta) {
  const { from, reason } = effectiveDate(plant, b);
  await withTenant(T(ctx), async (tx) => {
    const owner = kind === 'staff'
      ? await maybeOne(tx, 'SELECT 1 FROM app.staff_categories WHERE tenant_id = $1 AND plant_id = $2 AND id = $3', [ctx.tenantId, plant.id, id])
      : await maybeOne(tx, 'SELECT 1 FROM app.safety_items WHERE tenant_id = $1 AND plant_id = $2 AND id = $3', [ctx.tenantId, plant.id, id]);
    if (!owner) throw notFound(kind === 'staff' ? 'Staff category' : 'Safety item');
    if (kind === 'staff') {
      await exec(tx, `INSERT INTO app.staff_strengths (tenant_id, category_id, effective_from, strength, reason, created_by)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, category_id, effective_from) DO UPDATE SET strength = EXCLUDED.strength, reason = EXCLUDED.reason`,
        [ctx.tenantId, id, from, b.strength, reason, ctx.userId]);
    } else {
      await exec(tx, `INSERT INTO app.safety_requirements (tenant_id, item_id, effective_from, qty, reason, created_by)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, item_id, effective_from) DO UPDATE SET qty = EXCLUDED.qty, reason = EXCLUDED.reason`,
        [ctx.tenantId, id, from, b.qty, reason, ctx.userId]);
    }
    await changed(tx, ctx, plant, meta, { action: `${kind}.requirement_set`, entity: kind, entityId: id, after: { ...b, from }, reason }, from);
  });
  await afterCommit(ctx, plant, from);
  return kind === 'staff' ? listStaff(ctx, plant) : listSafety(ctx, plant);
}

// ======================================================================= contract years & revenue (§11.6)
export async function listContractYears(ctx: Ctx, plant: PlantCtx) {
  return withTenant(T(ctx), async (tx) => {
    const years = await many<{ id: string; year_no: number; start_date: string; end_date: string; days: number; fixed_fee: string; fee_configured: boolean }>(tx,
      `SELECT id, year_no, start_date, end_date, days, fixed_fee, fee_configured FROM app.contract_years
        WHERE tenant_id = $1 AND plant_id = $2 ORDER BY year_no`, [ctx.tenantId, plant.id]);
    const comps = await many<{ id: string; contract_year_id: string; name: string; code: string; rate: string; std_qty_per_day: string }>(tx,
      `SELECT c.id, c.contract_year_id, c.name, p.code, c.rate, c.std_qty_per_day FROM app.revenue_components c
         JOIN app.parameters p ON p.tenant_id = c.tenant_id AND p.id = c.parameter_id
        WHERE c.tenant_id = $1 AND p.plant_id = $2 ORDER BY c.name`, [ctx.tenantId, plant.id]);
    let totalValue = D(0);
    const out = years.map((y) => {
      const components = comps.filter((c) => c.contract_year_id === y.id).map((c) => ({
        id: c.id, name: c.name, parameterCode: c.code, rate: Number(c.rate), stdQtyPerDay: Number(c.std_qty_per_day),
      }));
      const varPerDay = components.reduce((s, c) => s.plus(D(c.rate).mul(c.stdQtyPerDay)), D(0));
      const fpPerDay = D(y.fixed_fee).div(y.days);
      const value = D(y.fixed_fee).plus(varPerDay.mul(y.days));
      totalValue = totalValue.plus(value);
      return {
        yearNo: y.year_no, startDate: y.start_date, endDate: y.end_date, days: y.days, fixedFee: y.fixed_fee,
        feeConfigured: y.fee_configured, components,
        derived: { // REV-06
          fixedPerDay: money(fpPerDay), fixedPerMonth: money(D(y.fixed_fee).div(12)), variableStdPerDay: money(varPerDay),
          variableStdPerMonth: money(varPerDay.mul(y.days).div(12)), variableStdPerYear: money(varPerDay.mul(y.days)),
          contractValue: money(value),
        },
      };
    });
    return { years: out, totalContractValue: money(totalValue) };
  });
}
async function loadYear(tx: Tx, ctx: Ctx, plant: PlantCtx, yearNo: number) {
  const y = await maybeOne<{ id: string; start_date: string; fixed_fee: string }>(tx,
    'SELECT id, start_date, fixed_fee FROM app.contract_years WHERE tenant_id = $1 AND plant_id = $2 AND year_no = $3',
    [ctx.tenantId, plant.id, yearNo]);
  if (!y) throw notFound('Contract year');
  return y;
}
export async function setYearFee(ctx: Ctx, plant: PlantCtx, yearNo: number, fixedFee: string, meta: RequestMeta) {
  let from = '';
  await withTenant(T(ctx), async (tx) => {
    const y = await loadYear(tx, ctx, plant, yearNo);
    from = y.start_date;
    await exec(tx, 'UPDATE app.contract_years SET fixed_fee = $3, fee_configured = true WHERE tenant_id = $1 AND id = $2 AND plant_id = $4',
      [ctx.tenantId, y.id, fixedFee, plant.id]);
    await changed(tx, ctx, plant, meta, { action: 'contract_year.fee_set', entity: 'contract_year', entityId: y.id,
      before: { fixedFee: y.fixed_fee }, after: { fixedFee } }, from);
  });
  await afterCommit(ctx, plant, from);
  return listContractYears(ctx, plant);
}
async function paramIdByCode(tx: Tx, ctx: Ctx, plant: PlantCtx, code: string): Promise<string> {
  const p = await maybeOne<{ id: string; aggregation: string }>(tx,
    'SELECT id, aggregation FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 AND code = $3', [ctx.tenantId, plant.id, code]);
  if (!p) throw notFound('Parameter');
  if (p.aggregation !== 'sum') throw unprocessable('INVALID_COMPONENT_PARAMETER', 'Revenue components must link to a SUM-type parameter.');
  return p.id;
}
export async function addComponent(ctx: Ctx, plant: PlantCtx, yearNo: number,
  b: { name: string; parameterCode: string; rate: number; stdQtyPerDay: number }, meta: RequestMeta) {
  let from = '';
  await withTenant(T(ctx), async (tx) => {
    const y = await loadYear(tx, ctx, plant, yearNo);
    from = y.start_date;
    const pid = await paramIdByCode(tx, ctx, plant, b.parameterCode);
    const r = await one<{ id: string }>(tx, `INSERT INTO app.revenue_components (tenant_id, contract_year_id, name, parameter_id, rate, std_qty_per_day, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, y.id, b.name, pid, b.rate, b.stdQtyPerDay, ctx.userId]);
    await changed(tx, ctx, plant, meta, { action: 'revenue_component.create', entity: 'revenue_component', entityId: r.id, after: b }, from);
  });
  await afterCommit(ctx, plant, from);
  return listContractYears(ctx, plant);
}
export async function patchComponent(ctx: Ctx, plant: PlantCtx, yearNo: number, id: string,
  b: { name?: string; rate?: number; stdQtyPerDay?: number } | null, meta: RequestMeta) {
  let from = '';
  await withTenant(T(ctx), async (tx) => {
    const y = await loadYear(tx, ctx, plant, yearNo);
    from = y.start_date;
    const exists = await maybeOne(tx, 'SELECT 1 FROM app.revenue_components WHERE tenant_id = $1 AND contract_year_id = $2 AND id = $3',
      [ctx.tenantId, y.id, id]);
    if (!exists) throw notFound('Revenue component');
    if (b === null) {
      await exec(tx, 'DELETE FROM app.revenue_components WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    } else {
      const set = setClause({ name: b.name, rate: b.rate, std_qty_per_day: b.stdQtyPerDay }, 3);
      if (set.values.length) await exec(tx, `UPDATE app.revenue_components SET ${set.sql} WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, id, ...set.values]);
    }
    await changed(tx, ctx, plant, meta, { action: b === null ? 'revenue_component.delete' : 'revenue_component.update',
      entity: 'revenue_component', entityId: id, after: b }, from);
  });
  await afterCommit(ctx, plant, from);
  return listContractYears(ctx, plant);
}
/** REV-05 helper: copy the previous year's fee and components into `yearNo`. */
export async function copyPreviousYear(ctx: Ctx, plant: PlantCtx, yearNo: number, meta: RequestMeta) {
  if (yearNo < 2) throw badRequest('INVALID_YEAR', 'Year 1 has no previous year.');
  let from = '';
  await withTenant(T(ctx), async (tx) => {
    const prev = await loadYear(tx, ctx, plant, yearNo - 1);
    const y = await loadYear(tx, ctx, plant, yearNo);
    from = y.start_date;
    await exec(tx, 'UPDATE app.contract_years SET fixed_fee = $3, fee_configured = true WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, y.id, prev.fixed_fee]);
    await exec(tx, 'DELETE FROM app.revenue_components WHERE tenant_id = $1 AND contract_year_id = $2', [ctx.tenantId, y.id]);
    await exec(tx, `INSERT INTO app.revenue_components (tenant_id, contract_year_id, name, parameter_id, rate, std_qty_per_day, created_by)
      SELECT tenant_id, $3, name, parameter_id, rate, std_qty_per_day, $4 FROM app.revenue_components WHERE tenant_id = $1 AND contract_year_id = $2`,
      [ctx.tenantId, prev.id, y.id, ctx.userId]);
    await changed(tx, ctx, plant, meta, { action: 'contract_year.copy_previous', entity: 'contract_year', entityId: y.id }, from);
  });
  await afterCommit(ctx, plant, from);
  return listContractYears(ctx, plant);
}
/** REV-05: each year from `fromYearNo` = previous year × (1 + pct), optionally rounded UP to whole rupees. */
export async function applyEscalation(ctx: Ctx, plant: PlantCtx, b: {
  fromYearNo: number; pct: number; target: 'fixed_fee' | 'component_rates' | 'both'; roundUpToRupee: boolean;
}, meta: RequestMeta) {
  let from = '';
  await withTenant(T(ctx), async (tx) => {
    const years = await many<{ id: string; year_no: number; start_date: string; fixed_fee: string }>(tx,
      'SELECT id, year_no, start_date, fixed_fee FROM app.contract_years WHERE tenant_id = $1 AND plant_id = $2 ORDER BY year_no',
      [ctx.tenantId, plant.id]);
    const factor = D(1).plus(D(b.pct).div(100));
    let prevFee = D(years.find((y) => y.year_no === b.fromYearNo - 1)?.fixed_fee ?? 0);
    for (const y of years.filter((x) => x.year_no >= b.fromYearNo)) {
      if (!from) from = y.start_date;
      if (b.target !== 'component_rates') {
        let fee = prevFee.mul(factor);
        fee = b.roundUpToRupee ? fee.ceil() : fee.toDecimalPlaces(2);
        await exec(tx, 'UPDATE app.contract_years SET fixed_fee = $3, fee_configured = true WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, y.id, fee.toFixed(2)]);
        prevFee = fee;
      }
      if (b.target !== 'fixed_fee') {
        const prev = years.find((x) => x.year_no === y.year_no - 1);
        if (prev) {
          await exec(tx, 'DELETE FROM app.revenue_components WHERE tenant_id = $1 AND contract_year_id = $2', [ctx.tenantId, y.id]);
          await exec(tx, `INSERT INTO app.revenue_components (tenant_id, contract_year_id, name, parameter_id, rate, std_qty_per_day, created_by)
            SELECT tenant_id, $3, name, parameter_id, round(rate * $4, 4), std_qty_per_day, $5 FROM app.revenue_components
             WHERE tenant_id = $1 AND contract_year_id = $2`, [ctx.tenantId, prev.id, y.id, factor.toString(), ctx.userId]);
        }
      }
    }
    if (!from) throw badRequest('INVALID_YEAR', 'No contract years from that year number.');
    await changed(tx, ctx, plant, meta, { action: 'contract_year.apply_escalation', entity: 'plant', entityId: plant.id, after: b }, from);
  });
  await afterCommit(ctx, plant, from);
  return listContractYears(ctx, plant);
}

// ======================================================================= cash (§11.9)
export async function getCash(ctx: Ctx, plant: PlantCtx) {
  return withTenant(T(ctx), async (tx) => {
    const r = await one<{ cash_opening: string; cash_opening_date: string | null; cash_alert_limit: string | null; petty_float: string | null }>(tx,
      'SELECT cash_opening, cash_opening_date, cash_alert_limit, petty_float FROM app.plant_settings WHERE tenant_id = $1 AND plant_id = $2',
      [ctx.tenantId, plant.id]);
    return { cashOpening: Number(r.cash_opening), cashOpeningDate: r.cash_opening_date ?? addDays(plant.misStart, -1),
      cashAlertLimit: r.cash_alert_limit === null ? null : Number(r.cash_alert_limit), pettyFloat: r.petty_float === null ? null : Number(r.petty_float) };
  });
}
export async function patchCash(ctx: Ctx, plant: PlantCtx, b: { cashOpening?: number; cashOpeningDate?: string;
  cashAlertLimit?: number | null; pettyFloat?: number | null }, meta: RequestMeta) {
  const recalc = b.cashOpening !== undefined || b.cashOpeningDate !== undefined || b.cashAlertLimit !== undefined
    ? (b.cashOpeningDate ?? addDays(plant.misStart, -1)) : null;
  await withTenant(T(ctx), async (tx) => {
    const set = setClause({ cash_opening: b.cashOpening, cash_opening_date: b.cashOpeningDate, cash_alert_limit: b.cashAlertLimit, petty_float: b.pettyFloat }, 3);
    if (!set.values.length) return;
    await exec(tx, `UPDATE app.plant_settings SET ${set.sql} WHERE tenant_id = $1 AND plant_id = $2`, [ctx.tenantId, plant.id, ...set.values]);
    await changed(tx, ctx, plant, meta, { action: 'settings.cash_update', entity: 'plant', entityId: plant.id, after: b }, recalc);
  });
  await afterCommit(ctx, plant, recalc);
  return getCash(ctx, plant);
}

// ======================================================================= registers (§11.10–11.11)
type RegisterKind = 'bank_guarantees' | 'insurance_policies';
const REG_COLS: Record<RegisterKind, Record<string, string>> = {
  bank_guarantees: { label: 'label', bgNumber: 'bg_number', bank: 'bank', startDate: 'start_date', endDate: 'end_date',
    amount: 'amount', claimMonths: 'claim_months', remarks: 'remarks' },
  insurance_policies: { policyType: 'policy_type', policyNumber: 'policy_number', insurer: 'insurer', startDate: 'start_date',
    endDate: 'end_date', sumAssured: 'sum_assured', premium: 'premium', remarks: 'remarks' },
};
export async function listRegister(ctx: Ctx, plant: PlantCtx, kind: RegisterKind) {
  return withTenant(T(ctx), async (tx) => {
    const rows = await many<Record<string, unknown>>(tx,
      `SELECT * FROM app.${kind} WHERE tenant_id = $1 AND plant_id = $2 ORDER BY start_date`, [ctx.tenantId, plant.id]);
    const cols = REG_COLS[kind];
    return Promise.all(rows.map(async (r) => ({
      id: r.id, ...Object.fromEntries(Object.entries(cols).map(([k, c]) => [k, r[c]])),
      documentUrl: await signedUrlOrNull(r.doc_key as string | null),
    })));
  });
}
export async function createRegister(ctx: Ctx, plant: PlantCtx, kind: RegisterKind, b: Record<string, unknown>, meta: RequestMeta) {
  const cols = REG_COLS[kind];
  const keys = Object.keys(cols).filter((k) => b[k] !== undefined);
  await withTenant(T(ctx), async (tx) => {
    const r = await one<{ id: string }>(tx,
      `INSERT INTO app.${kind} (tenant_id, plant_id, created_by, ${keys.map((k) => cols[k]).join(', ')})
       VALUES ($1, $2, $3, ${keys.map((_, i) => `$${i + 4}`).join(', ')}) RETURNING id`,
      [ctx.tenantId, plant.id, ctx.userId, ...keys.map((k) => b[k])]);
    await changed(tx, ctx, plant, meta, { action: `${kind}.create`, entity: kind, entityId: r.id, after: b }, null);
  });
  return listRegister(ctx, plant, kind);
}
export async function patchRegister(ctx: Ctx, plant: PlantCtx, kind: RegisterKind, id: string, b: Record<string, unknown>, meta: RequestMeta) {
  const cols = REG_COLS[kind];
  await withTenant(T(ctx), async (tx) => {
    const set = setClause(Object.fromEntries(Object.entries(cols).map(([k, c]) => [c, b[k]])), 4);
    if (!set.values.length) return;
    const n = await exec(tx, `UPDATE app.${kind} SET ${set.sql} WHERE tenant_id = $1 AND plant_id = $2 AND id = $3`,
      [ctx.tenantId, plant.id, id, ...set.values]);
    if (n === 0) throw notFound('Register entry');
    const r = await one<{ start_date: string; end_date: string }>(tx, `SELECT start_date, end_date FROM app.${kind} WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, id]);
    if (r.end_date < r.start_date) throw badRequest('INVALID_RANGE', 'End date must be on or after the start date.');
    await changed(tx, ctx, plant, meta, { action: `${kind}.update`, entity: kind, entityId: id, after: b }, null);
  });
  return listRegister(ctx, plant, kind);
}
export async function setRegisterDocument(ctx: Ctx, plant: PlantCtx, kind: RegisterKind, id: string,
  file: { ext: AllowedKind; mime: string; buffer: Buffer }, meta: RequestMeta) {
  const key = tenantKey(ctx.tenantId, 'p', plant.id, 'registers', `${randomUUID()}.${file.ext}`);
  let old: string | null = null;
  await storage.put(key, file.buffer, file.mime);
  try {
    await withTenant(T(ctx), async (tx) => {
      const r = await maybeOne<{ doc_key: string | null }>(tx, `SELECT doc_key FROM app.${kind} WHERE tenant_id = $1 AND plant_id = $2 AND id = $3 FOR UPDATE`,
        [ctx.tenantId, plant.id, id]);
      if (!r) throw notFound('Register entry');
      old = r.doc_key;
      await exec(tx, `UPDATE app.${kind} SET doc_key = $3 WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, id, key]);
      await changed(tx, ctx, plant, meta, { action: `${kind}.document`, entity: kind, entityId: id, after: { key } }, null);
    });
  } catch (e) {
    await storage.remove(key).catch(() => undefined);
    throw e;
  }
  if (old) {
    assertTenantKey(old, ctx.tenantId);
    await storage.remove(old).catch(() => undefined);
  }
  return listRegister(ctx, plant, kind);
}

// ======================================================================= go-live (§11.12) and template/copy (§11.13)
export async function goLiveCheck(ctx: Ctx, plant: PlantCtx) {
  return withTenant(T(ctx), (tx) => goLiveCheckTx(tx, ctx.tenantId, plant.id));
}
export async function goLiveCheckTx(tx: Tx, tenantId: string, plantId: string) {
  const q = async (sql: string) => (await one<{ n: number }>(tx, sql, [tenantId, plantId])).n;
  const missingUnits = await q(`SELECT count(*) AS n FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 AND active_to IS NULL AND coalesce(unit, '') = ''`);
  const missingStd = await q(`SELECT count(*) AS n FROM app.parameters p WHERE p.tenant_id = $1 AND p.plant_id = $2 AND p.active_to IS NULL
      AND p.std_type IN ('per_day', 'monthly_allowance', 'range')
      AND NOT EXISTS (SELECT 1 FROM app.parameter_standards s WHERE s.tenant_id = p.tenant_id AND s.parameter_id = p.id)`);
  const missingLab = await q(`SELECT count(*) AS n FROM app.parameters p WHERE p.tenant_id = $1 AND p.plant_id = $2 AND p.active_to IS NULL
      AND p.group_key IN ('lab_inlet', 'lab_outlet') AND NOT EXISTS (SELECT 1 FROM app.parameter_standards s
      WHERE s.tenant_id = p.tenant_id AND s.parameter_id = p.id AND (s.limit_min IS NOT NULL OR s.limit_max IS NOT NULL))`);
  const missingFees = await q(`SELECT count(*) AS n FROM app.contract_years WHERE tenant_id = $1 AND plant_id = $2 AND NOT fee_configured`);
  const missingOpening = await q(`SELECT count(*) AS n FROM app.stock_items WHERE tenant_id = $1 AND plant_id = $2 AND is_active AND opening_date IS NULL`);
  const staffMissing = await q(`SELECT count(*) AS n FROM app.staff_categories c WHERE c.tenant_id = $1 AND c.plant_id = $2 AND c.is_active
      AND NOT EXISTS (SELECT 1 FROM app.staff_strengths s WHERE s.tenant_id = c.tenant_id AND s.category_id = c.id)`);
  const safetyMissing = await q(`SELECT count(*) AS n FROM app.safety_items i WHERE i.tenant_id = $1 AND i.plant_id = $2 AND i.is_active
      AND NOT EXISTS (SELECT 1 FROM app.safety_requirements s WHERE s.tenant_id = i.tenant_id AND s.item_id = i.id)`);
  const params = await q('SELECT count(*) AS n FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2');
  const cash = await one<{ cash_opening_date: string | null }>(tx, 'SELECT cash_opening_date FROM app.plant_settings WHERE tenant_id = $1 AND plant_id = $2', [tenantId, plantId]);
  const items = [
    { key: 'parameters', ok: params > 0, message: 'The parameter catalogue is empty (apply the template or add parameters).' },
    { key: 'units', ok: missingUnits === 0, message: `${missingUnits} parameter(s) without a unit.` },
    { key: 'standards', ok: missingStd === 0, message: `${missingStd} parameter(s) without a standard.` },
    { key: 'lab_limits', ok: missingLab === 0, message: `${missingLab} lab parameter(s) without limits.` },
    { key: 'contract_fees', ok: missingFees === 0, message: `${missingFees} contract year(s) without a fixed fee.` },
    { key: 'stock_opening', ok: missingOpening === 0, message: `${missingOpening} stock item(s) without an opening balance date.` },
    { key: 'cash_opening', ok: !!cash.cash_opening_date, message: 'Site cash opening balance and date are not set.' },
    { key: 'staff', ok: staffMissing === 0, message: `${staffMissing} staff categor(ies) without a strength.` },
    { key: 'safety', ok: safetyMissing === 0, message: `${safetyMissing} safety item(s) without a requirement.` },
  ];
  return { ready: items.every((i) => i.ok), items };
}
export async function goLive(ctx: Ctx, plant: PlantCtx, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    const c = await goLiveCheckTx(tx, ctx.tenantId, plant.id);
    if (!c.ready) throw unprocessable('GO_LIVE_INCOMPLETE', 'Some settings are missing.', { items: c.items.filter((i) => !i.ok) });
    await exec(tx, `UPDATE app.plants SET setup_status = 'live' WHERE tenant_id = $1 AND id = $2 AND setup_status = 'settings_pending'`, [ctx.tenantId, plant.id]);
    await changed(tx, ctx, plant, meta, { action: 'plant.go_live', entity: 'plant', entityId: plant.id }, null);
  });
  return goLiveCheck(ctx, plant);
}
export async function applyTemplateToPlant(ctx: Ctx, plant: PlantCtx, meta: RequestMeta) {
  await withTenant(T(ctx), async (tx) => {
    await applyTemplate(tx, ctx.tenantId, plant.id, plant.misStart, ctx.userId);
    await changed(tx, ctx, plant, meta, { action: 'settings.apply_template', entity: 'plant', entityId: plant.id, after: { template: 'STP' } }, null);
  });
  return listParameters(ctx, plant);
}

/** TPL-02: copy settings (not history, not opening balances, not contract fees) from another plant of the SAME tenant. */
export async function copyFrom(ctx: Ctx, plant: PlantCtx, sourcePlantId: string, meta: RequestMeta) {
  if (sourcePlantId === plant.id) throw badRequest('SAME_PLANT', 'Choose a different plant.');
  await withTenant(T(ctx), async (tx) => {
    const src = await maybeOne(tx, 'SELECT 1 FROM app.plants WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, sourcePlantId]);
    if (!src) throw notFound('Plant'); // another tenant's plant is invisible (RLS + filter)
    const data = await maybeOne(tx, 'SELECT 1 FROM app.logsheets WHERE tenant_id = $1 AND plant_id = $2 LIMIT 1', [ctx.tenantId, plant.id]);
    if (data) throw conflict('PLANT_HAS_DATA', 'Settings can only be copied into a plant without logsheets.');
    const T1 = [ctx.tenantId, plant.id];
    await exec(tx, `DELETE FROM app.revenue_components c USING app.contract_years y WHERE c.tenant_id = $1 AND y.tenant_id = $1 AND c.contract_year_id = y.id AND y.plant_id = $2`, T1);
    await exec(tx, 'DELETE FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2', T1);
    for (const t of ['plant_constants', 'stock_items', 'staff_categories', 'safety_items']) {
      await exec(tx, `DELETE FROM app.${t} WHERE tenant_id = $1 AND plant_id = $2`, T1);
    }
    const S = [ctx.tenantId, sourcePlantId];
    const consts = await many<{ code: string; name: string; value: string; unit: string | null }>(tx,
      `SELECT DISTINCT ON (code) code, name, value, unit FROM app.plant_constants WHERE tenant_id = $1 AND plant_id = $2 ORDER BY code, effective_from DESC`, S);
    for (const c of consts) await upsertConstant(tx, ctx.tenantId, plant.id, { ...c, value: Number(c.value) }, plant.misStart, 'copied', ctx.userId);
    // stock items, staff, safety (latest values) — their linked parameters are created by the repo helpers
    const stock = await many<{ id: string; name: string; unit: string; min_level: string | null; code: string; std: string | null }>(tx,
      `SELECT s.id, s.name, s.unit, s.min_level, replace(p.code, '_CONSUMED', '') AS code,
              (SELECT std_value FROM app.parameter_standards ps WHERE ps.tenant_id = p.tenant_id AND ps.parameter_id = p.id ORDER BY effective_from DESC LIMIT 1) AS std
         FROM app.stock_items s JOIN app.parameters p ON p.tenant_id = s.tenant_id AND p.stock_item_id = s.id AND p.link_role = 'consumed'
        WHERE s.tenant_id = $1 AND s.plant_id = $2 ORDER BY s.display_order`, S);
    for (const s of stock) {
      await createStockItem(tx, ctx.tenantId, plant.id, { code: s.code, name: s.name, unit: s.unit, stdPerDay: Number(s.std ?? 0),
        minLevel: s.min_level === null ? null : Number(s.min_level), openingDate: null }, plant.misStart, ctx.userId);
    }
    const staff = await many<{ name: string; code: string; strength: number }>(tx,
      `SELECT c.name, replace(replace(p.code, 'STAFF_', ''), '_VACANT', '') AS code,
              (SELECT strength FROM app.staff_strengths s WHERE s.tenant_id = c.tenant_id AND s.category_id = c.id ORDER BY effective_from DESC LIMIT 1) AS strength
         FROM app.staff_categories c JOIN app.parameters p ON p.tenant_id = c.tenant_id AND p.staff_category_id = c.id AND p.link_role = 'vacant'
        WHERE c.tenant_id = $1 AND c.plant_id = $2 ORDER BY c.display_order`, S);
    for (const s of staff) await createStaffCategory(tx, ctx.tenantId, plant.id, { ...s, strength: s.strength ?? 0 }, plant.misStart, ctx.userId);
    const safety = await many<{ name: string; code: string; qty: number }>(tx,
      `SELECT i.name, replace(p.code, 'SAFE_', '') AS code,
              (SELECT qty FROM app.safety_requirements s WHERE s.tenant_id = i.tenant_id AND s.item_id = i.id ORDER BY effective_from DESC LIMIT 1) AS qty
         FROM app.safety_items i JOIN app.parameters p ON p.tenant_id = i.tenant_id AND p.safety_item_id = i.id
        WHERE i.tenant_id = $1 AND i.plant_id = $2 ORDER BY i.display_order`, S);
    for (const s of safety) await createSafetyItem(tx, ctx.tenantId, plant.id, { ...s, qty: s.qty ?? 0 }, plant.misStart, ctx.userId);
    // remaining parameters (not created by the helpers above)
    const params = await many<ParamRow>(tx,
      `SELECT ${PARAM_COLS} FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 AND active_to IS NULL
         AND stock_item_id IS NULL AND staff_category_id IS NULL AND safety_item_id IS NULL`, S);
    for (const p of params) {
      const newId = await insertParameter(tx, ctx.tenantId, plant.id, {
        code: p.code, name: p.name, shortName: p.short_name ?? undefined, group: p.group_key as never, unit: p.unit,
        inputMode: p.input_mode as never, formula: p.formula ?? undefined, decimals: p.decimals,
        hardMin: numOrNull(p.hard_min) ?? undefined, hardMax: numOrNull(p.hard_max) ?? undefined, aggregation: p.aggregation as never,
        stdType: p.std_type as never, direction: p.direction as never, eventRule: p.event_rule as never,
        resultNoun: p.result_noun ?? undefined, block: p.logsheet_block ?? 8, order: p.logsheet_order ?? 99,
        misSection: (p.mis_section ?? undefined) as never, misOrder: p.mis_order ?? undefined, dashboardCard: p.dashboard_card,
        dashboardOrder: p.dashboard_order ?? undefined, chartType: p.chart_type as never,
        chartMetric: (p.chart_metric ?? undefined) as never, mandatory: p.mandatory,
      }, { linkRole: p.link_role ?? undefined }, ctx.userId);
      const st = await maybeOne<{ std_value: string | null; monthly_allowance: string | null; limit_min: string | null; limit_max: string | null }>(tx,
        `SELECT std_value, monthly_allowance, limit_min, limit_max FROM app.parameter_standards WHERE tenant_id = $1 AND parameter_id = $2
          ORDER BY effective_from DESC LIMIT 1`, [ctx.tenantId, p.id]);
      if (st) {
        await upsertStandard(tx, ctx.tenantId, newId, plant.misStart, { std: numOrNull(st.std_value), monthly: numOrNull(st.monthly_allowance),
          min: numOrNull(st.limit_min), max: numOrNull(st.limit_max) }, 'copied', ctx.userId);
      }
    }
    await exec(tx, `UPDATE app.plant_settings t SET end_customer_name = s.end_customer_name, tagline = s.tagline,
        sig_prepared_label = s.sig_prepared_label, sig_checked_label = s.sig_checked_label, sig_verified_label = s.sig_verified_label,
        allow_same_day = s.allow_same_day, editor_backfill_days = s.editor_backfill_days, avg_divisor = s.avg_divisor,
        cash_alert_limit = s.cash_alert_limit, petty_float = s.petty_float, pdf_prefix_mis = s.pdf_prefix_mis
       FROM app.plant_settings s WHERE t.tenant_id = $1 AND t.plant_id = $2 AND s.tenant_id = $1 AND s.plant_id = $3`,
      [ctx.tenantId, plant.id, sourcePlantId]);
    await changed(tx, ctx, plant, meta, { action: 'settings.copy_from', entity: 'plant', entityId: plant.id, after: { sourcePlantId } }, null);
  });
  return listParameters(ctx, plant);
}

