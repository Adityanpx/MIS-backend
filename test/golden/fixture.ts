import fs from 'node:fs';
import path from 'node:path';
import { addDays } from '../../src/lib/dates';
import { buildContractYears } from '../../src/modules/domain/contract-years';
import type { EngineData, EngineSettings, ParamDef, DayRecord } from '../../src/modules/engine/core/types';
import { STP_TEMPLATE, type TemplateParam } from '../../src/modules/settings/stp-template';

export const MIS_START = '2024-11-01';
const OPENING_DATE = addDays(MIS_START, -1);

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/);
  const split = (l: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]!);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i]!, v])));
}
export const goldenRows = () => parseCsv(fs.readFileSync(path.join(__dirname, '../../test-data/MIS_daily_data_golden.csv'), 'utf8'));

let seq = 0;
const def = (t: TemplateParam, links: Partial<ParamDef> = {}): ParamDef => ({
  id: `p${++seq}`, code: t.code, name: t.name, shortName: t.shortName ?? null, group: t.group, unit: t.unit,
  inputMode: t.inputMode ?? 'typed', formula: t.formula ?? null, decimals: t.decimals, hardMin: t.hardMin ?? null, hardMax: t.hardMax ?? null,
  aggregation: t.aggregation, stdType: t.stdType, direction: t.direction, eventRule: t.eventRule, resultNoun: t.resultNoun ?? null,
  linkRole: null, stockItemId: null, staffCategoryId: null, safetyItemId: null, block: t.block, order: t.order,
  misSection: t.misSection ?? null, misOrder: t.misOrder ?? 99, dashboardCard: t.dashboardCard ?? false, dashboardOrder: t.dashboardOrder ?? 99,
  chartType: t.chartType ?? 'none', chartMetric: t.chartMetric ?? null, mandatory: t.mandatory ?? true, activeFrom: null, activeTo: null,
  standards: t.standard ? [{ from: MIS_START, std: t.standard.std ?? null, monthly: t.standard.monthly ?? null, min: t.standard.min ?? null, max: t.standard.max ?? null }] : [],
  ...links,
});

const CSV_TO_CODE: Record<string, string> = {
  inflow_mld: 'INFLOW', eb_kwh: 'EB_KWH', power_factor: 'PF', bge_hours: 'BGE_HRS', bge_kwh: 'BGE_KWH', dg_hours: 'DG_HRS',
  diesel_consumed_l: 'DIESEL_CONSUMED', diesel_received_l: 'DIESEL_RECEIVED', poly_consumed_kg: 'POLY_CONSUMED', poly_received_kg: 'POLY_RECEIVED',
  chlorine_consumed_kg: 'CHLORINE_CONSUMED', chlorine_received_kg: 'CHLORINE_RECEIVED', lime_consumed_kg: 'LIME_CONSUMED',
  lime_received_kg: 'LIME_RECEIVED', alum_consumed_kg: 'ALUM_CONSUMED', alum_received_kg: 'ALUM_RECEIVED',
  inlet_ph: 'IN_PH', inlet_bod: 'IN_BOD', inlet_cod: 'IN_COD', inlet_tss: 'IN_TSS', inlet_fc: 'IN_FC',
  outlet_ph: 'OUT_PH', outlet_bod: 'OUT_BOD', outlet_cod: 'OUT_COD', outlet_tss: 'OUT_TSS', outlet_fc: 'OUT_FC',
  helmets: 'SAFE_HELMET', safety_shoes: 'SAFE_SHOES', safety_belts: 'SAFE_BELT',
  payroll_vacant: 'STAFF_PAYROLL_VACANT', payroll_present: 'STAFF_PAYROLL_PRESENT', payroll_leave: 'STAFF_PAYROLL_LEAVE',
  ftc_vacant: 'STAFF_FTC_VACANT', ftc_present: 'STAFF_FTC_PRESENT', ftc_leave: 'STAFF_FTC_LEAVE',
  tp_vacant: 'STAFF_TP_VACANT', tp_present: 'STAFF_TP_PRESENT', tp_leave: 'STAFF_TP_LEAVE',
  cash_expensed: 'CASH_EXPENSE', cash_received: 'CASH_RECEIVED',
};

export function goldenInput(): { settings: EngineSettings; data: EngineData } {
  const rows = goldenRows();
  const first = rows[0]!;
  const n = (v: string | undefined) => (v === undefined || v.trim() === '' || Number.isNaN(Number(v)) ? 0 : Number(v)); // "z" → 0 (D2)
  const params: ParamDef[] = STP_TEMPLATE.parameters.map((t) => def(t));
  const stock = STP_TEMPLATE.stockItems.map((s) => {
    const consumed = def({ code: `${s.code}_CONSUMED`, name: `${s.name} consumed`, shortName: s.name, group: 'chemical', unit: s.unit, decimals: 2,
      aggregation: 'sum', stdType: 'per_day', direction: 'lower_better', eventRule: 'above_std', resultNoun: 'CONSUMED', block: 2, order: 1,
      misSection: 'chemicals', dashboardCard: true, chartType: 'line', chartMetric: 'avg_per_day', dashboardOrder: s.dashboardOrder,
      standard: { std: s.stdPerDay } }, { linkRole: 'consumed', stockItemId: s.code });
    const received = def({ code: `${s.code}_RECEIVED`, name: `${s.name} received`, group: 'chemical', unit: s.unit, decimals: 2,
      aggregation: 'sum', stdType: 'none', direction: 'neutral', eventRule: 'none', block: 2, order: 2, mandatory: false },
      { linkRole: 'received', stockItemId: s.code });
    params.push(consumed, received);
    const col = s.code.toLowerCase();
    const unit = s.unit === 'L' ? 'l' : 'kg';
    const balance = n(first[`${col}_balance_${unit}`]);
    return { id: s.code, code: s.code, name: s.name, unit: s.unit, minLevel: null, active: true, adjustments: [],
      consumedCode: consumed.code, receivedCode: received.code, openingDate: OPENING_DATE,
      opening: balance + n(first[`${col}_consumed_${unit}`]) - n(first[`${col}_received_${unit}`]) }; // IMP-05 back-calculation
  });
  const staff = STP_TEMPLATE.staff.map((c) => {
    for (const r of ['VACANT', 'PRESENT', 'LEAVE']) {
      params.push(def({ code: `STAFF_${c.code}_${r}`, name: `${c.name} ${r}`, group: 'staff', unit: 'Nos', decimals: 0, aggregation: 'snapshot',
        stdType: 'none', direction: 'neutral', eventRule: 'none', block: 6, order: 1 }, { staffCategoryId: c.code, linkRole: r.toLowerCase() }));
    }
    return { id: c.code, code: c.code, name: c.name, strengths: [{ from: MIS_START, v: c.strength }],
      vacantCode: `STAFF_${c.code}_VACANT`, presentCode: `STAFF_${c.code}_PRESENT`, leaveCode: `STAFF_${c.code}_LEAVE` };
  });
  const safety = STP_TEMPLATE.safety.map((s) => {
    params.push(def({ code: `SAFE_${s.code}`, name: `${s.name} available`, shortName: s.name, group: 'safety', unit: 'Nos', decimals: 0,
      aggregation: 'snapshot', stdType: 'required_qty', direction: 'higher_better', eventRule: 'below_std', block: 5, order: 1 },
      { safetyItemId: s.code, linkRole: 'available' }));
    return { id: s.code, code: s.code, name: s.name, required: [{ from: MIS_START, v: s.qty }], availableCode: `SAFE_${s.code}` };
  });
  params.push(def({ code: 'CASH_EXPENSE', name: 'Expenses today', group: 'cash', unit: 'INR', decimals: 0, aggregation: 'sum', stdType: 'none',
    direction: 'lower_better', eventRule: 'none', block: 7, order: 1 }, { linkRole: 'expense' }));
  params.push(def({ code: 'CASH_RECEIVED', name: 'Cash received', group: 'cash', unit: 'INR', decimals: 0, aggregation: 'sum', stdType: 'none',
    direction: 'neutral', eventRule: 'none', block: 7, order: 2 }, { linkRole: 'cash_received' }));
  params.push(def({ code: 'CASH_DESC', name: 'Description', group: 'cash', unit: 'text', decimals: 0, aggregation: 'text', stdType: 'none',
    direction: 'neutral', eventRule: 'none', block: 7, order: 3 }, { linkRole: 'description' }));

  const fees = [23662389, 23703156, 24674676, 25703392, 26793025];
  const bgeStd = [10000, 11000, 12000, 13000, 13000];
  const settings: EngineSettings = {
    plant: { id: 'plant', code: 'P-001', name: 'Bherampur 120 MLD STP', type: 'STP', capacityMld: 120, omStart: '2022-09-01',
      omEnd: '2027-08-31', tenureMonths: 60, misStart: MIS_START },
    display: { companyName: 'Toshiba Water Solutions Private Limited (TWSPL)', clientName: 'GMDA', logsheetTitle: 'DAILY LOGSHEET',
      dashboardTitle: 'TWS – BHERAMPUR 120 MLD STP', tagline: 'CLEAN WATER / SUSTAINABLE TOMORROW', sigPrepared: 'Plant In-charge',
      sigChecked: 'HO – Manager', sigVerified: 'HO – Head O&M', pdfPrefixMis: 'MIS REPORT' },
    avgDivisor: 'calendar_days',
    constants: Object.fromEntries(STP_TEMPLATE.constants.map((c) => [c.code, [{ from: MIS_START, v: c.value }]])),
    params, stock, staff, safety,
    contractYears: buildContractYears('2022-09-01', 60).map((y, i) => ({
      yearNo: y.yearNo, start: y.startDate, end: y.endDate, days: y.days, fixedFee: fees[i]!, feeConfigured: true,
      components: [{ name: 'BGE power payment', paramCode: 'BGE_KWH', rate: 4.14, stdQtyPerDay: bgeStd[i]! }],
    })),
    cash: { opening: n(first.cash_balance) + n(first.cash_expensed) - n(first.cash_received), openingDate: OPENING_DATE, alertLimit: 1500 },
    registers: [
      { kind: 'bg', label: 'BG-1', number: 'MD2227700002', party: 'SMBC', start: '2022-10-04', end: '2028-09-05', amount: 10688582, claimMonths: 12, premium: null, sumAssured: null },
      { kind: 'insurance', label: 'WC', number: '4010/264218974/02/000', party: 'ICICI', start: '2024-09-10', end: '2027-09-09', amount: null, claimMonths: null, premium: 18285, sumAssured: 12024000 },
      { kind: 'insurance', label: 'FIRE', number: 'D153959120', party: 'GO DIGIT', start: '2024-06-28', end: '2027-06-27', amount: null, claimMonths: null, premium: 65016, sumAssured: 110000000 },
    ],
  };
  const days = new Map<string, DayRecord>();
  for (const r of rows) {
    const values: DayRecord['values'] = { CASH_DESC: r.expense_description ?? null };
    for (const [col, code] of Object.entries(CSV_TO_CODE)) values[code] = n(r[col]);
    days.set(r.date!, { date: r.date!, status: 'submitted', version: 1, values, submittedByName: 'Golden', submittedAt: null, correctedAt: null });
  }
  return { settings, data: { days } };
}
