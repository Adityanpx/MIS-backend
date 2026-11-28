import { NUM0, NUM2, type ReportTable } from '../reports/table';
import { fmtIsoDate, type PortfolioLogsheetStatus } from './portfolio.rows';
import type { PortfolioReport } from './portfolio.service';

/**
 * Excel export of the Portfolio screen (§10A "Excel export matches the screen"): sheet 1 = one row per plant with the
 * same figures as the table, sheet 2 = every system-detected issue. Pure: builds tables only.
 */

const LOGSHEET_LABEL: Record<PortfolioLogsheetStatus, string> = {
  draft: 'Draft', submitted: 'Submitted', corrected: 'Corrected', returned: 'Returned', checked: 'Checked', verified: 'Verified',
  missing: 'Missing', not_due: 'Not due', not_live: 'Not live', unavailable: 'Unavailable',
};
const REGISTER_LABEL = { ok: 'OK', expiring: 'Expiring', expired: 'Expired', not_available: 'N/A' } as const;
const OUTLET_LABEL = { within: 'Within', exceeded: 'Exceeded', no_data: 'No data' } as const;
const STANDARD_LABEL = { primary: 'Primary standard', actual: 'Actual standard', bidding: 'Bidding standard' } as const;
const CATEGORY_LABEL = {
  logsheet: 'Logsheet', compliance: 'Compliance', chemicals: 'Chemicals', admin: 'Administrative',
  maintenance: 'Maintenance', account: 'Account', data: 'Data',
} as const;
const pretty = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function portfolioTables(r: PortfolioReport): Array<ReportTable & { sheetName: string }> {
  const subtitle = `${fmtIsoDate(r.reportDate)} · ${STANDARD_LABEL[r.standard]} · ${r.summary.plants} plants`;
  const s = r.summary;

  const plants: ReportTable & { sheetName: string } = {
    sheetName: 'Plants',
    title: `Portfolio ${fmtIsoDate(r.reportDate)}`,
    subtitle,
    columns: [
      { key: 'name', header: 'Plant', width: 28 },
      { key: 'code', header: 'Code' },
      { key: 'type', header: 'Type' },
      { key: 'capacity', header: 'Capacity (MLD)', numFmt: NUM2 },
      { key: 'account', header: 'Account' },
      { key: 'logsheet', header: 'Logsheet' },
      { key: 'keyName', header: 'Key parameter', width: 22 },
      { key: 'keyUnit', header: 'Unit' },
      { key: 'keyToday', header: 'Today', numFmt: NUM2 },
      { key: 'keyMtd', header: 'MTD actual', numFmt: NUM2 },
      { key: 'keyMtdStd', header: 'MTD standard', numFmt: NUM2 },
      { key: 'keyResult', header: 'Result % (MTD)', numFmt: NUM2 },
      { key: 'revAct', header: 'Revenue MTD (₹ M)', numFmt: NUM2 },
      { key: 'revStd', header: 'Revenue std MTD (₹ M)', numFmt: NUM2 },
      { key: 'revPct', header: 'Revenue achieved %', numFmt: NUM2 },
      { key: 'chemAbove', header: 'Chemicals above std (MTD)', numFmt: NUM0 },
      { key: 'chemLow', header: 'Chemicals below min', numFmt: NUM0 },
      { key: 'outlet', header: 'Outlet today' },
      { key: 'outletEvents', header: 'Outlet events MTD', numFmt: NUM0 },
      { key: 'registers', header: 'BG / insurance' },
      { key: 'absent', header: 'Staff absent', numFmt: NUM0 },
      { key: 'safety', header: 'Safety deficit', numFmt: NUM0 },
      { key: 'cash', header: 'Cash in hand (₹)', numFmt: NUM2 },
      { key: 'openBd', header: 'Open breakdowns', numFmt: NUM0 },
      { key: 'critBd', header: 'Critical open', numFmt: NUM0 },
      { key: 'longest', header: 'Longest open (days)', numFmt: NUM0 },
      { key: 'avail', header: 'Availability MTD %', numFmt: NUM2 },
      { key: 'critical', header: 'Critical issues', numFmt: NUM0 },
      { key: 'warning', header: 'Warnings', numFmt: NUM0 },
    ],
    rows: r.rows.map((x) => ({
      name: x.name, code: x.code, type: x.type, capacity: x.capacityMld, account: pretty(x.accountState),
      logsheet: LOGSHEET_LABEL[x.logsheetStatus],
      keyName: x.key?.name ?? null, keyUnit: x.key?.unit ?? null, keyToday: x.key?.today.act ?? null,
      keyMtd: x.key?.mtd.act ?? null, keyMtdStd: x.key?.mtd.std ?? null, keyResult: x.key?.resultPct ?? null,
      revAct: x.revenue?.mtdAct ?? null, revStd: x.revenue?.mtdStd ?? null, revPct: x.revenue?.achievementPct ?? null,
      chemAbove: x.hasData ? x.chemicals.aboveStdMtd : null, chemLow: x.hasData ? x.chemicals.belowMin : null,
      outlet: x.hasData ? OUTLET_LABEL[x.compliance.outletToday] : null,
      outletEvents: x.hasData ? x.compliance.outletEventsMtd : null,
      registers: x.hasData ? REGISTER_LABEL[x.compliance.worstRegister] : null,
      absent: x.administrative.staffAbsentToday, safety: x.hasData ? x.administrative.safetyDeficit : null,
      cash: x.administrative.cashInHand,
      openBd: x.maintenance.enabled ? x.maintenance.openBreakdowns : null,
      critBd: x.maintenance.enabled ? x.maintenance.criticalOpen : null,
      longest: x.maintenance.longestOpenDays,
      avail: x.maintenance.availabilityMtd === null ? null : x.maintenance.availabilityMtd * 100,
      critical: x.issues.critical, warning: x.issues.warning,
    })),
    footer: [{
      name: `Total (${s.plants} plants)`,
      capacity: r.rows.reduce((a, x) => a + x.capacityMld, 0),
      logsheet: `${s.logsheets.submitted} / ${s.logsheets.expected} submitted`,
      revAct: s.revenueMtd?.act ?? null, revStd: s.revenueMtd?.std ?? null,
      revPct: s.revenueMtd && s.revenueMtd.std !== 0 ? (s.revenueMtd.act / s.revenueMtd.std) * 100 : null,
      openBd: s.breakdowns.open, critBd: s.breakdowns.critical,
      critical: s.issues.critical, warning: s.issues.warning,
    }],
  };

  const issues: ReportTable & { sheetName: string } = {
    sheetName: 'Issues',
    title: `Portfolio issues ${fmtIsoDate(r.reportDate)}`,
    subtitle: `${s.issues.critical} critical · ${s.issues.warning} warnings · ${s.issues.plantsAffected} plants affected`,
    columns: [
      { key: 'level', header: 'Severity' },
      { key: 'plant', header: 'Plant', width: 28 },
      { key: 'code', header: 'Code' },
      { key: 'category', header: 'Area', width: 16 },
      { key: 'title', header: 'Issue', width: 40 },
      { key: 'detail', header: 'Detail', width: 60 },
    ],
    rows: r.issues.map((i) => ({
      level: i.level === 'critical' ? 'Critical' : 'Warning', plant: i.plantName, code: i.plantCode,
      category: CATEGORY_LABEL[i.category], title: i.title, detail: i.detail,
    })),
  };

  return [plants, issues];
}
