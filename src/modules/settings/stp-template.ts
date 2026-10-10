import type { AGGREGATIONS, DIRECTIONS, EVENT_RULES, INPUT_MODES, PARAM_GROUPS, STD_TYPES } from '../../shared/enums';

export interface TemplateParam {
  code: string; name: string; shortName?: string; group: (typeof PARAM_GROUPS)[number]; unit: string;
  inputMode?: (typeof INPUT_MODES)[number]; formula?: string; decimals: number; hardMin?: number; hardMax?: number;
  aggregation: (typeof AGGREGATIONS)[number]; stdType: (typeof STD_TYPES)[number]; direction: (typeof DIRECTIONS)[number];
  eventRule: (typeof EVENT_RULES)[number]; resultNoun?: string; block: number; order: number;
  misSection?: 'key' | 'chemicals' | 'lab_inlet' | 'lab_outlet'; misOrder?: number;
  dashboardCard?: boolean; dashboardOrder?: number; chartType?: 'bar' | 'line' | 'cone' | 'none';
  chartMetric?: 'avg_per_day' | 'monthly_total'; mandatory?: boolean;
  standard?: { std?: number; monthly?: number; min?: number; max?: number };
}
export interface PlantTemplate {
  parameters: TemplateParam[];
  constants: Array<{ code: string; name: string; value: number; unit?: string }>;
  stockItems: Array<{ code: string; name: string; unit: string; stdPerDay: number; dashboardOrder: number }>;
  staff: Array<{ code: string; name: string; strength: number }>;
  safety: Array<{ code: string; name: string; qty: number }>;
  cash: { alertLimit: number; pettyFloat: number };
}

const lab = (side: 'IN' | 'OUT', code: string, name: string, unit: string, decimals: number, order: number,
  std: { min?: number; max?: number }, hardMax?: number): TemplateParam => ({
  code: `${side}_${code}`, name: `${side === 'IN' ? 'Inlet' : 'Outlet'} ${name}`, group: side === 'IN' ? 'lab_inlet' : 'lab_outlet',
  unit, decimals, hardMin: 0, hardMax, aggregation: 'avg', stdType: 'range', direction: 'within_range',
  eventRule: 'outside_range', block: side === 'IN' ? 3 : 4, order, misSection: side === 'IN' ? 'lab_inlet' : 'lab_outlet',
  misOrder: order, dashboardCard: side === 'OUT', dashboardOrder: side === 'OUT' ? 20 + order : undefined,
  chartType: side === 'OUT' ? 'cone' : 'none', chartMetric: side === 'OUT' ? 'avg_per_day' : undefined, standard: std,
});

export const STP_TEMPLATE: PlantTemplate = {
  parameters: [
    { code: 'INFLOW', name: 'Sewage inflow received', shortName: 'Inflow', group: 'key', unit: 'MLD', decimals: 2, hardMin: 0,
      aggregation: 'sum', stdType: 'per_day', direction: 'higher_better', eventRule: 'above_std', resultNoun: 'INFLOW',
      block: 1, order: 1, misSection: 'key', misOrder: 1, dashboardCard: true, dashboardOrder: 1, chartType: 'bar',
      chartMetric: 'avg_per_day', standard: { std: 120 } },
    { code: 'EB_KWH', name: 'EB power consumed', shortName: 'EB power', group: 'key', unit: 'kWh', decimals: 0, hardMin: 0,
      aggregation: 'sum', stdType: 'per_day', direction: 'lower_better', eventRule: 'above_std', resultNoun: 'POWER CONSUMED',
      block: 1, order: 2, misSection: 'key', misOrder: 2, dashboardCard: true, dashboardOrder: 2, chartType: 'bar',
      chartMetric: 'avg_per_day', standard: { std: 18200 } },
    { code: 'PF', name: 'APFC power factor', group: 'key', unit: 'PF', decimals: 2, hardMin: 0, hardMax: 1,
      aggregation: 'avg', stdType: 'per_day', direction: 'higher_better', eventRule: 'none', block: 1, order: 3,
      standard: { std: 1, min: 0.95 } },
    { code: 'BGE_HRS', name: 'BGE running time', shortName: 'BGE hours', group: 'key', unit: 'hours', decimals: 2, hardMin: 0,
      hardMax: 24, aggregation: 'sum', stdType: 'per_day', direction: 'higher_better', eventRule: 'above_std',
      resultNoun: 'BGE RUNNING HOURS', block: 1, order: 4, misSection: 'key', misOrder: 5,
      standard: { std: 11800 / (800 * 0.7) } },
    { code: 'BGE_KWH', name: 'BGE power generation', shortName: 'BGE power', group: 'key', unit: 'kWh', decimals: 0, hardMin: 0,
      aggregation: 'sum', stdType: 'per_day', direction: 'higher_better', eventRule: 'above_std',
      resultNoun: 'BGE POWER GENERATED', block: 1, order: 5, misSection: 'key', misOrder: 6, dashboardCard: true,
      dashboardOrder: 3, chartType: 'bar', chartMetric: 'avg_per_day', standard: { std: 11800 } },
    { code: 'DG_HRS', name: 'DG running hours', shortName: 'DG hours', group: 'key', unit: 'hours', decimals: 2, hardMin: 0,
      hardMax: 24, aggregation: 'sum', stdType: 'monthly_allowance', direction: 'lower_better', eventRule: 'above_std',
      resultNoun: 'DG RUNNING HOURS', block: 1, order: 6, misSection: 'key', misOrder: 3, standard: { std: 8, monthly: 32 } },
    { code: 'DG_KWH', name: 'DG power generation', shortName: 'DG power', group: 'key', unit: 'kWh', decimals: 0,
      inputMode: 'calculated', formula: 'DG_HRS * DG_CAPACITY_KW * DG_LOAD_FACTOR', aggregation: 'sum',
      stdType: 'monthly_allowance', direction: 'lower_better', eventRule: 'above_std', resultNoun: 'DG POWER GENERATED',
      block: 1, order: 7, misSection: 'key', misOrder: 4, dashboardCard: true, dashboardOrder: 4, chartType: 'bar',
      chartMetric: 'avg_per_day', standard: { std: 9360, monthly: 37440 } },
    lab('IN', 'PH', 'pH', 'value', 1, 1, { min: 6, max: 8.5 }, 14),
    lab('IN', 'BOD', 'BOD', 'mg/L', 0, 2, { max: 300 }),
    lab('IN', 'COD', 'COD', 'mg/L', 0, 3, { max: 500 }),
    lab('IN', 'TSS', 'TSS', 'mg/L', 0, 4, { max: 400 }),
    lab('IN', 'FC', 'FC', 'MPN', 0, 5, { max: 10000000 }),
    lab('OUT', 'PH', 'pH', 'value', 1, 1, { min: 6, max: 8.5 }, 14),
    lab('OUT', 'BOD', 'BOD', 'mg/L', 0, 2, { max: 10 }),
    lab('OUT', 'COD', 'COD', 'mg/L', 0, 3, { max: 50 }),
    lab('OUT', 'TSS', 'TSS', 'mg/L', 0, 4, { max: 10 }),
    lab('OUT', 'FC', 'FC', 'MPN', 0, 5, { max: 100 }),
    { code: 'REMARKS', name: 'General remarks', group: 'other', unit: 'text', decimals: 0, aggregation: 'text',
      stdType: 'none', direction: 'neutral', eventRule: 'none', block: 8, order: 1, mandatory: false },
  ],
  constants: [
    { code: 'PLANT_CAPACITY_MLD', name: 'Plant capacity', value: 120, unit: 'MLD' },
    { code: 'PLANT_POWER_DEMAND_KWH', name: 'Plant power demand per day', value: 30000, unit: 'kWh' },
    { code: 'BGE_ENGINE_KW', name: 'BGE engine capacity', value: 800, unit: 'kW' },
    { code: 'BGE_STD_LOAD_FACTOR', name: 'BGE standard load factor', value: 0.7 },
    { code: 'DG_SETS', name: 'Number of DG sets', value: 3 },
    { code: 'DG_SET_KW', name: 'DG set capacity', value: 520, unit: 'kW' },
    { code: 'DG_CAPACITY_KW', name: 'Total DG capacity', value: 1560, unit: 'kW' },
    { code: 'DG_LOAD_FACTOR', name: 'DG load factor', value: 0.75 },
    { code: 'DIESEL_L_PER_DG_HOUR', name: 'Diesel per DG hour', value: 135, unit: 'L' },
    { code: 'POWER_CUT_DAYS_PER_MONTH', name: 'Power-cut days per month', value: 4 },
    { code: 'POWER_CUT_HOURS_PER_DAY', name: 'Power-cut hours per day', value: 8, unit: 'hours' },
  ],
  stockItems: [
    { code: 'DIESEL', name: 'Diesel', unit: 'L', stdPerDay: 120, dashboardOrder: 11 },
    { code: 'POLY', name: 'Poly', unit: 'kg', stdPerDay: 30, dashboardOrder: 12 },
    { code: 'CHLORINE', name: 'Chlorine', unit: 'kg', stdPerDay: 420, dashboardOrder: 13 },
    { code: 'LIME', name: 'Lime', unit: 'kg', stdPerDay: 1200, dashboardOrder: 14 },
    { code: 'ALUM', name: 'Alum', unit: 'kg', stdPerDay: 960, dashboardOrder: 15 },
  ],
  staff: [
    { code: 'PAYROLL', name: 'Payroll', strength: 1 },
    { code: 'FTC', name: 'FTC', strength: 17 },
    { code: 'TP', name: 'Third party', strength: 14 },
  ],
  safety: [
    { code: 'HELMET', name: 'Safety helmets', qty: 12 },
    { code: 'SHOES', name: 'Safety shoes', qty: 21 },
    { code: 'BELT', name: 'Safety belts', qty: 15 },
  ],
  cash: { alertLimit: 1500, pettyFloat: 10000 },
};
