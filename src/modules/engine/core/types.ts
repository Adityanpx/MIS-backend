import type {
  CauseCategory, Criticality, Impact, MonitoringTab, ResultDisplayOverride, ResultMode, StandardKind,
  StandardsShown, StandbyState,
} from '../../../shared/enums';

export type ISODate = string;
export interface Eff<T> { from: ISODate; v: T }
export type Flag = 'ok' | 'bad' | 'neutral';

export interface StandardRow {
  from: ISODate; kind: StandardKind; std: number | null; monthly: number | null; min: number | null; max: number | null;
  inheritFromKind: StandardKind | null;
}
export interface ParamDef {
  id: string; code: string; name: string; shortName: string | null; group: string; unit: string;
  inputMode: 'typed' | 'calculated' | 'suggested'; formula: string | null; decimals: number;
  hardMin: number | null; hardMax: number | null;
  aggregation: 'sum' | 'avg' | 'snapshot' | 'stock' | 'text';
  stdType: 'per_day' | 'monthly_allowance' | 'range' | 'required_qty' | 'none';
  direction: 'higher_better' | 'lower_better' | 'within_range' | 'neutral';
  eventRule: 'above_std' | 'below_std' | 'outside_range' | 'none';
  resultNoun: string | null; linkRole: string | null;
  stockItemId: string | null; staffCategoryId: string | null; safetyItemId: string | null;
  block: number; order: number; misSection: string | null; misOrder: number;
  dashboardCard: boolean; dashboardOrder: number; chartType: string; chartMetric: string | null; mandatory: boolean;
  activeFrom: ISODate | null; activeTo: ISODate | null;
  /** v1.1: default monitoring tab (C5) and a per-parameter override of the plant's result display (PAR-19). */
  monitoringTab: MonitoringTab;
  resultDisplayOverride: ResultDisplayOverride | null;
  /** v1.1 (C2): the single `standards` series above is replaced by one series per kind. */
  standardsByKind: { bidding: StandardRow[]; actual: StandardRow[] };
}
export interface StockItemDef {
  id: string; code: string; name: string; unit: string; opening: number; openingDate: ISODate; minLevel: number | null;
  consumedCode: string; receivedCode: string; active: boolean;
  adjustments: Array<{ date: ISODate; qty: number }>;
}
export interface StaffDef {
  id: string; code: string; name: string; strengths: Eff<number>[]; vacantCode: string; presentCode: string; leaveCode: string;
}
export interface SafetyDef { id: string; code: string; name: string; required: Eff<number>[]; availableCode: string }
export interface ContractYearDef {
  yearNo: number; start: ISODate; end: ISODate; days: number; fixedFee: number; feeConfigured: boolean;
  components: Array<{ name: string; paramCode: string; rate: number; stdQtyPerDay: number; actualStdQtyPerDay: number | null }>;
}
export interface RegisterDef {
  kind: 'bg' | 'insurance'; label: string; number: string; party: string; start: ISODate; end: ISODate;
  amount: number | null; claimMonths: number | null; premium: number | null; sumAssured: number | null;
}
/** v1.1 (C4): equipment register entry. */
export interface EquipmentDef {
  id: string; code: string; name: string; category: string; criticality: Criticality; standby: StandbyState;
  status: 'in_service' | 'out_of_service'; isActive: boolean;
}
/** v1.1 (C4): one breakdown record (cancelled ones are excluded by the loader). */
export interface BreakdownRecord {
  id: string; equipmentId: string; equipmentCode: string; equipmentName: string; criticality: Criticality;
  startedAt: string; restoredAt: string | null; status: string; impact: Impact; causeCategory: CauseCategory | null;
  expectedRestoreOn: ISODate | null; fault: string;
}
export interface MaintenanceSettings {
  enabled: boolean; reviewTickRequired: boolean; longOpenAlertDays: number; criticalLongOpenDays: number;
  repeatThreshold: number; repeatWindowDays: number; criticalAlertEnabled: boolean;
  equipment: EquipmentDef[]; breakdowns: BreakdownRecord[];
}
export interface EngineSettings {
  plant: { id: string; code: string; name: string; type: string; capacityMld: number; omStart: ISODate; omEnd: ISODate;
           tenureMonths: number; misStart: ISODate };
  display: { companyName: string; clientName: string; logsheetTitle: string; dashboardTitle: string; tagline: string;
             sigPrepared: string; sigChecked: string; sigVerified: string; pdfPrefixMis: string };
  avgDivisor: 'calendar_days' | 'data_days';
  constants: Record<string, Eff<number>[]>;
  params: ParamDef[];
  stock: StockItemDef[];
  staff: StaffDef[];
  safety: SafetyDef[];
  contractYears: ContractYearDef[];
  cash: { opening: number; openingDate: ISODate; alertLimit: number | null };
  registers: RegisterDef[];
  /** v1.1 (SET-09..12): plant-level defaults for the two-standards / tabs feature. */
  primaryStandard: StandardKind;
  standardsShown: StandardsShown;
  resultsDisplay: ResultMode;
  tabLabels: Partial<Record<MonitoringTab, string>>;
  maintenance: MaintenanceSettings;
}
export interface DayRecord {
  date: ISODate; status: string; version: number;
  values: Record<string, number | string | null>;
  submittedByName: string | null; submittedAt: string | null; correctedAt: string | null;
}
export interface EngineData { days: Map<ISODate, DayRecord> } // submitted / corrected / checked / verified logsheets only

export interface DerivedDay {
  calc: Record<string, number | null>; // calculated parameters
  stock: Record<string, number>;       // closing balance per stock item code
  cash: number;                        // cash in hand
  absent: Record<string, number>;      // absent per staff category code
  revFp: number; revStd: number; revAct: number; // ₹ per day (0 outside the contract) — revStd = Bidding (contract) quantities
  revStdActual: number;                           // v1.1: ₹/day using each component's Actual standard (falls back to revStd)
  hasData: boolean;
}
export type DerivedMap = Map<ISODate, DerivedDay>;
