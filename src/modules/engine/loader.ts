import { many, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { addDays } from '../../lib/dates';
import type { DayRecord, EngineData, EngineSettings, ParamDef } from './core/types';

const n = (v: string | null) => (v === null ? null : Number(v));

export async function loadSettings(tx: Tx, tenantId: string, plantId: string): Promise<EngineSettings> {
  const p = await one<Record<string, string | number | null>>(tx,
    `SELECT p.id, p.code, p.name, p.type, p.capacity_mld, p.om_start, p.om_end, p.om_tenure_months, p.mis_start,
            s.end_customer_name, s.report_company_name, s.logsheet_title, s.dashboard_title, s.tagline, s.sig_prepared_label,
            s.sig_checked_label, s.sig_verified_label, s.pdf_prefix_mis, s.avg_divisor, s.cash_opening, s.cash_opening_date,
            s.cash_alert_limit, c.legal_name
       FROM app.plants p JOIN app.plant_settings s ON s.tenant_id = p.tenant_id AND s.plant_id = p.id
       JOIN app.clients c ON c.id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.id = $2`, [tenantId, plantId]);
  const params = await many<Record<string, string | number | boolean | null>>(tx,
    `SELECT id, code, name, short_name, group_key, unit, input_mode, formula, decimals, hard_min, hard_max, aggregation, std_type,
            direction, event_rule, result_noun, link_role, stock_item_id, staff_category_id, safety_item_id, logsheet_block,
            logsheet_order, mis_section, mis_order, dashboard_card, dashboard_order, chart_type, chart_metric, mandatory,
            active_from, active_to
       FROM app.parameters WHERE tenant_id = $1 AND plant_id = $2 ORDER BY logsheet_block, logsheet_order`, [tenantId, plantId]);
  const standards = await many<{ parameter_id: string; effective_from: string; std_value: string | null; monthly_allowance: string | null; limit_min: string | null; limit_max: string | null }>(tx,
    `SELECT s.parameter_id, s.effective_from, s.std_value, s.monthly_allowance, s.limit_min, s.limit_max
       FROM app.parameter_standards s JOIN app.parameters p ON p.tenant_id = s.tenant_id AND p.id = s.parameter_id
      WHERE s.tenant_id = $1 AND p.plant_id = $2`, [tenantId, plantId]);
  const defs: ParamDef[] = params.map((r) => ({
    id: r.id as string, code: r.code as string, name: r.name as string, shortName: r.short_name as string | null,
    group: r.group_key as string, unit: r.unit as string, inputMode: r.input_mode as ParamDef['inputMode'],
    formula: r.formula as string | null, decimals: r.decimals as number, hardMin: n(r.hard_min as string | null),
    hardMax: n(r.hard_max as string | null), aggregation: r.aggregation as ParamDef['aggregation'],
    stdType: r.std_type as ParamDef['stdType'], direction: r.direction as ParamDef['direction'],
    eventRule: r.event_rule as ParamDef['eventRule'], resultNoun: r.result_noun as string | null,
    linkRole: r.link_role as string | null, stockItemId: r.stock_item_id as string | null,
    staffCategoryId: r.staff_category_id as string | null, safetyItemId: r.safety_item_id as string | null,
    block: (r.logsheet_block as number | null) ?? 8, order: (r.logsheet_order as number | null) ?? 99,
    misSection: r.mis_section as string | null, misOrder: (r.mis_order as number | null) ?? 99,
    dashboardCard: r.dashboard_card as boolean, dashboardOrder: (r.dashboard_order as number | null) ?? 99,
    chartType: r.chart_type as string, chartMetric: r.chart_metric as string | null, mandatory: r.mandatory as boolean,
    activeFrom: r.active_from as string | null, activeTo: r.active_to as string | null,
    standards: standards.filter((s) => s.parameter_id === r.id).map((s) => ({
      from: s.effective_from, std: n(s.std_value), monthly: n(s.monthly_allowance), min: n(s.limit_min), max: n(s.limit_max),
    })),
  }));
  const misStart = p.mis_start as string;
  const constants: EngineSettings['constants'] = {};
  for (const c of await many<{ code: string; effective_from: string; value: string }>(tx,
    'SELECT code, effective_from, value FROM app.plant_constants WHERE tenant_id = $1 AND plant_id = $2', [tenantId, plantId])) {
    (constants[c.code] ??= []).push({ from: c.effective_from, v: Number(c.value) });
  }
  const adjustments = await many<{ stock_item_id: string; adj_date: string; qty: string }>(tx,
    `SELECT a.stock_item_id, a.adj_date, a.qty FROM app.stock_adjustments a JOIN app.stock_items i ON i.tenant_id = a.tenant_id AND i.id = a.stock_item_id
      WHERE a.tenant_id = $1 AND i.plant_id = $2`, [tenantId, plantId]);
  const stock = (await many<{ id: string; name: string; unit: string; opening_balance: string; opening_date: string | null; min_level: string | null; is_active: boolean }>(tx,
    'SELECT id, name, unit, opening_balance, opening_date, min_level, is_active FROM app.stock_items WHERE tenant_id = $1 AND plant_id = $2 ORDER BY display_order',
    [tenantId, plantId])).map((i) => {
    const consumed = defs.find((d) => d.stockItemId === i.id && d.linkRole === 'consumed');
    const received = defs.find((d) => d.stockItemId === i.id && d.linkRole === 'received');
    return {
      id: i.id, code: (consumed?.code ?? i.name).replace(/_CONSUMED$/, ''), name: i.name, unit: i.unit,
      opening: Number(i.opening_balance), openingDate: i.opening_date ?? addDays(misStart, -1), minLevel: n(i.min_level),
      consumedCode: consumed?.code ?? '', receivedCode: received?.code ?? '', active: i.is_active,
      adjustments: adjustments.filter((a) => a.stock_item_id === i.id).map((a) => ({ date: a.adj_date, qty: Number(a.qty) })),
    };
  }).filter((i) => i.consumedCode);
  const strengths = await many<{ category_id: string; effective_from: string; strength: number }>(tx,
    `SELECT s.category_id, s.effective_from, s.strength FROM app.staff_strengths s JOIN app.staff_categories c ON c.tenant_id = s.tenant_id AND c.id = s.category_id
      WHERE s.tenant_id = $1 AND c.plant_id = $2`, [tenantId, plantId]);
  const staff = (await many<{ id: string; name: string }>(tx,
    'SELECT id, name FROM app.staff_categories WHERE tenant_id = $1 AND plant_id = $2 AND is_active ORDER BY display_order', [tenantId, plantId]))
    .map((c) => {
      const code = (role: string) => defs.find((d) => d.staffCategoryId === c.id && d.linkRole === role)?.code ?? '';
      return { id: c.id, code: code('vacant').replace(/^STAFF_|_VACANT$/g, ''), name: c.name,
        strengths: strengths.filter((s) => s.category_id === c.id).map((s) => ({ from: s.effective_from, v: s.strength })),
        vacantCode: code('vacant'), presentCode: code('present'), leaveCode: code('leave') };
    });
  const reqs = await many<{ item_id: string; effective_from: string; qty: number }>(tx,
    `SELECT r.item_id, r.effective_from, r.qty FROM app.safety_requirements r JOIN app.safety_items i ON i.tenant_id = r.tenant_id AND i.id = r.item_id
      WHERE r.tenant_id = $1 AND i.plant_id = $2`, [tenantId, plantId]);
  const safety = (await many<{ id: string; name: string }>(tx,
    'SELECT id, name FROM app.safety_items WHERE tenant_id = $1 AND plant_id = $2 AND is_active ORDER BY display_order', [tenantId, plantId]))
    .map((i) => {
      const availableCode = defs.find((d) => d.safetyItemId === i.id)?.code ?? '';
      return { id: i.id, code: availableCode.replace(/^SAFE_/, ''), name: i.name, availableCode,
        required: reqs.filter((r) => r.item_id === i.id).map((r) => ({ from: r.effective_from, v: r.qty })) };
    });
  const years = await many<{ id: string; year_no: number; start_date: string; end_date: string; days: number; fixed_fee: string; fee_configured: boolean }>(tx,
    'SELECT id, year_no, start_date, end_date, days, fixed_fee, fee_configured FROM app.contract_years WHERE tenant_id = $1 AND plant_id = $2 ORDER BY year_no',
    [tenantId, plantId]);
  const comps = await many<{ contract_year_id: string; name: string; code: string; rate: string; std_qty_per_day: string }>(tx,
    `SELECT c.contract_year_id, c.name, p.code, c.rate, c.std_qty_per_day FROM app.revenue_components c
       JOIN app.parameters p ON p.tenant_id = c.tenant_id AND p.id = c.parameter_id WHERE c.tenant_id = $1 AND p.plant_id = $2`,
    [tenantId, plantId]);
  const bgs = await many<Record<string, string | number | null>>(tx,
    'SELECT label, bg_number, bank, start_date, end_date, amount, claim_months FROM app.bank_guarantees WHERE tenant_id = $1 AND plant_id = $2',
    [tenantId, plantId]);
  const ins = await many<Record<string, string | number | null>>(tx,
    'SELECT policy_type, policy_number, insurer, start_date, end_date, sum_assured, premium FROM app.insurance_policies WHERE tenant_id = $1 AND plant_id = $2',
    [tenantId, plantId]);
  return {
    plant: { id: plantId, code: p.code as string, name: p.name as string, type: p.type as string, capacityMld: Number(p.capacity_mld),
      omStart: p.om_start as string, omEnd: p.om_end as string, tenureMonths: p.om_tenure_months as number, misStart },
    display: {
      companyName: (p.report_company_name as string | null) ?? (p.legal_name as string), clientName: (p.end_customer_name as string | null) ?? '',
      logsheetTitle: (p.logsheet_title as string | null) ?? `${p.name} – DAILY LOGSHEET`,
      dashboardTitle: (p.dashboard_title as string | null) ?? `${p.name}`.toUpperCase(), tagline: p.tagline as string,
      sigPrepared: p.sig_prepared_label as string, sigChecked: p.sig_checked_label as string, sigVerified: p.sig_verified_label as string,
      pdfPrefixMis: p.pdf_prefix_mis as string,
    },
    avgDivisor: p.avg_divisor as EngineSettings['avgDivisor'],
    constants, params: defs, stock, staff, safety,
    contractYears: years.map((y) => ({ yearNo: y.year_no, start: y.start_date, end: y.end_date, days: y.days,
      fixedFee: Number(y.fixed_fee), feeConfigured: y.fee_configured,
      components: comps.filter((c) => c.contract_year_id === y.id).map((c) => ({ name: c.name, paramCode: c.code, rate: Number(c.rate), stdQtyPerDay: Number(c.std_qty_per_day) })) })),
    cash: { opening: Number(p.cash_opening), openingDate: (p.cash_opening_date as string | null) ?? addDays(misStart, -1),
      alertLimit: n(p.cash_alert_limit as string | null) },
    registers: [
      ...bgs.map((r) => ({ kind: 'bg' as const, label: r.label as string, number: r.bg_number as string, party: r.bank as string,
        start: r.start_date as string, end: r.end_date as string, amount: n(r.amount as string | null), claimMonths: r.claim_months as number,
        premium: null, sumAssured: null })),
      ...ins.map((r) => ({ kind: 'insurance' as const, label: r.policy_type as string, number: r.policy_number as string,
        party: r.insurer as string, start: r.start_date as string, end: r.end_date as string, amount: null, claimMonths: null,
        premium: n(r.premium as string | null), sumAssured: n(r.sum_assured as string | null) })),
    ],
  };
}

/** Submitted (and later) logsheets with values keyed by parameter code. */
export async function loadData(tx: Tx, tenantId: string, plantId: string): Promise<EngineData> {
  const sheets = await many<{ id: string; log_date: string; status: string; version: number; submitted_at: string | null; submitted_name: string | null; corrected_at: string | null }>(tx,
    `SELECT l.id, l.log_date, l.status, l.version, l.submitted_at, u.name AS submitted_name,
            (SELECT max(h.changed_at) FROM app.logsheet_value_history h WHERE h.tenant_id = l.tenant_id AND h.logsheet_id = l.id) AS corrected_at
       FROM app.logsheets l LEFT JOIN app.users u ON u.tenant_id = l.tenant_id AND u.id = l.submitted_by
      WHERE l.tenant_id = $1 AND l.plant_id = $2 AND l.status IN ('submitted', 'corrected', 'checked', 'verified')`, [tenantId, plantId]);
  const values = await many<{ logsheet_id: string; code: string; value_num: string | null; value_text: string | null }>(tx,
    `SELECT v.logsheet_id, p.code, v.value_num, v.value_text FROM app.logsheet_values v
       JOIN app.logsheets l ON l.tenant_id = v.tenant_id AND l.id = v.logsheet_id
       JOIN app.parameters p ON p.tenant_id = v.tenant_id AND p.id = v.parameter_id
      WHERE v.tenant_id = $1 AND l.plant_id = $2 AND l.status IN ('submitted', 'corrected', 'checked', 'verified')`, [tenantId, plantId]);
  const byId = new Map<string, DayRecord>();
  const days = new Map<string, DayRecord>();
  for (const s of sheets) {
    const rec: DayRecord = { date: s.log_date, status: s.status, version: s.version, values: {}, submittedByName: s.submitted_name,
      submittedAt: s.submitted_at, correctedAt: s.corrected_at };
    byId.set(s.id, rec);
    days.set(s.log_date, rec);
  }
  for (const v of values) {
    const rec = byId.get(v.logsheet_id);
    if (rec) rec.values[v.code] = v.value_num !== null ? Number(v.value_num) : v.value_text;
  }
  return { days };
}
