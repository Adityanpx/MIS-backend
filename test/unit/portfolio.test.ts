import { describe, expect, it } from 'vitest';
import { computeDerived } from '../../src/modules/engine/core/derive';
import { buildMis, type Bundle } from '../../src/modules/engine/core/mis';
import type { EngineData, EngineSettings } from '../../src/modules/engine/core/types';
import { buildAlerts } from '../../src/modules/insights/insights';
import { portfolioTables } from '../../src/modules/insights/portfolio.export';
import {
  buildPortfolioRow, daysOpen, sortIssues, summarize, type PlantInput, type PortfolioPlant,
} from '../../src/modules/insights/portfolio.rows';
import { goldenInput } from '../golden/fixture';

/** Pure Portfolio rules (MGT-11, T24) on the golden plant — no database. */
const D = '2026-09-21';
const TODAY = '2026-09-25';
const opts = { standard: 'primary' as const, date: D, today: TODAY };
const plant = (over: Partial<PortfolioPlant> = {}): PortfolioPlant => ({
  id: 'p-1', code: 'STP-01', name: 'Alpha STP', type: 'STP', capacityMld: 10, city: null,
  accountState: 'active', setupStatus: 'live', ...over,
});
const misOf = (settings: EngineSettings, data: EngineData, d = D) =>
  buildMis({ settings, data, derived: computeDerived(settings, data, d) } satisfies Bundle, d);
const misInput = (settings: EngineSettings, data: EngineData, d = D): PlantInput =>
  ({ kind: 'mis', mis: misOf(settings, data, d), longOpenAlertDays: settings.maintenance.longOpenAlertDays });

describe('portfolio rows and issues', () => {
  it('golden day: the row carries the MIS figures, and MIS-derived issues match the dashboard alerts (critical + warning)', () => {
    const { settings, data } = goldenInput();
    const input = misInput(settings, data);
    const { row, issues } = buildPortfolioRow(plant(), input, opts);
    const mis = (input as Extract<PlantInput, { kind: 'mis' }>).mis;

    expect(row.hasData).toBe(true);
    expect(row.logsheetStatus).toBe(mis.header.logsheet!.status);
    const first = mis.keyParameters.find((r) => r.code !== 'REVENUE')!;
    expect(row.key?.code).toBe(first.code);
    expect(row.key?.mtd.act).toBe(first.standards[mis.header.primaryStandard].mtd.act);
    expect(row.revenue?.mtdAct).toBe(mis.keyParameters.find((r) => r.code === 'REVENUE')!.standards[mis.header.primaryStandard].mtd.act);
    expect(row.chemicals.tracked).toBe(mis.chemicals.length);

    const alerts = buildAlerts(mis).filter((a) => a.level !== 'info' && ['lab', 'register', 'stock', 'cash', 'safety'].includes(a.kind));
    const fromMis = issues.filter((i) => !['logsheet', 'maintenance', 'account', 'data'].includes(i.category));
    expect(fromMis.map((i) => i.title).sort()).toEqual(alerts.map((a) => a.title).sort());
    expect(row.issues.critical + row.issues.warning).toBe(issues.length);
    expect(issues.every((i) => i.plantId === 'p-1' && i.plantName === 'Alpha STP')).toBe(true);
  });

  it('missing logsheet is critical when the day is past and a warning on the current day', () => {
    const { settings, data } = goldenInput();
    data.days.delete(D);
    const past = buildPortfolioRow(plant(), misInput(settings, data), opts);
    expect(past.row.logsheetStatus).toBe('missing');
    expect(past.row.health).toBe('critical');
    expect(past.issues.find((i) => i.type === 'MISSING_LOGSHEET')?.level).toBe('critical');

    const sameDay = buildPortfolioRow(plant(), misInput(settings, data), { ...opts, today: D });
    expect(sameDay.issues.find((i) => i.type === 'MISSING_LOGSHEET')?.level).toBe('warning');
  });

  it('draft and returned logsheets raise warnings', () => {
    for (const status of ['draft', 'returned'] as const) {
      const { settings, data } = goldenInput();
      data.days.set(D, { ...data.days.get(D)!, status });
      const { issues } = buildPortfolioRow(plant(), misInput(settings, data), opts);
      const i = issues.find((x) => x.category === 'logsheet');
      expect(i?.type).toBe(status === 'draft' ? 'LOGSHEET_DRAFT' : 'LOGSHEET_RETURNED');
      expect(i?.level).toBe('warning');
    }
  });

  it('outlet exceeded → critical compliance issue and "exceeded" outlet state', () => {
    const { settings, data } = goldenInput();
    const p = settings.params.find((x) => x.group === 'lab_outlet' && x.standardsByKind.actual.length > 0)!;
    const lim = p.standardsByKind.actual[0]!;
    const rec = data.days.get(D)!;
    data.days.set(D, { ...rec, values: { ...rec.values, [p.code]: (lim.max ?? lim.std ?? 10) + 100 } });
    const { row, issues } = buildPortfolioRow(plant(), misInput(settings, data), opts);
    expect(row.compliance.outletToday).toBe('exceeded');
    expect(row.compliance.outletFailingToday).toBeGreaterThan(0);
    const i = issues.find((x) => x.type === 'OUTLET_EXCEEDED');
    expect(i?.level).toBe('critical');
    expect(i?.category).toBe('compliance');
  });

  it('breakdowns: critical open → critical issue; non-critical open past the alert days → warning', () => {
    const { settings, data } = goldenInput();
    const s: EngineSettings = {
      ...settings,
      maintenance: {
        ...settings.maintenance, enabled: true, longOpenAlertDays: 3,
        equipment: [
          { id: 'eq1', code: 'EQ-1', name: 'Blower', category: 'blower', criticality: 'critical', standby: 'none', status: 'in_service', isActive: true },
          { id: 'eq2', code: 'EQ-2', name: 'Pump', category: 'pump', criticality: 'normal', standby: 'none', status: 'in_service', isActive: true },
        ],
        breakdowns: [
          { id: 'b1', equipmentId: 'eq1', equipmentCode: 'EQ-1', equipmentName: 'Blower', criticality: 'critical',
            startedAt: '2026-09-20T06:00:00+05:30', restoredAt: null, status: 'open', impact: 'plant_stopped',
            causeCategory: null, expectedRestoreOn: null, fault: 'Bearing' },
          { id: 'b2', equipmentId: 'eq2', equipmentCode: 'EQ-2', equipmentName: 'Pump', criticality: 'normal',
            startedAt: '2026-09-10T06:00:00+05:30', restoredAt: null, status: 'open', impact: 'reduced_capacity',
            causeCategory: null, expectedRestoreOn: null, fault: 'Seal' },
        ],
      },
    } as EngineSettings;
    const { row, issues } = buildPortfolioRow(plant(), misInput(s, data), opts);
    expect(row.maintenance.enabled).toBe(true);
    expect(row.maintenance.openBreakdowns).toBe(2);
    expect(issues.find((i) => i.type === 'CRITICAL_BREAKDOWN')).toMatchObject({ level: 'critical', detail: 'Blower (1 day)' });
    expect(issues.find((i) => i.type === 'BREAKDOWN_LONG_OPEN')).toMatchObject({ level: 'warning', detail: 'Pump (11 days)' });
  });

  it('plants that do not report: no MIS figures; account and data problems still surface', () => {
    const notLive = buildPortfolioRow(plant({ setupStatus: 'settings_pending' }), { kind: 'not_live' }, opts);
    expect(notLive.row).toMatchObject({ logsheetStatus: 'not_live', hasData: false, health: 'inactive' });
    expect(notLive.issues).toHaveLength(0);

    const suspended = buildPortfolioRow(plant({ accountState: 'suspended' }), { kind: 'not_live' }, opts);
    expect(suspended.issues[0]).toMatchObject({ type: 'ACCOUNT_RESTRICTED', level: 'critical' });
    expect(suspended.row.health).toBe('critical');

    const notDue = buildPortfolioRow(plant(), { kind: 'not_due' }, opts);
    expect(notDue.row).toMatchObject({ logsheetStatus: 'not_due', health: 'inactive' });

    const broken = buildPortfolioRow(plant(), { kind: 'unavailable' }, opts);
    expect(broken.issues[0]).toMatchObject({ type: 'DATA_UNAVAILABLE', level: 'critical' });

    const { settings, data } = goldenInput();
    const grace = buildPortfolioRow(plant({ accountState: 'grace' }), misInput(settings, data), opts);
    expect(grace.issues.find((i) => i.type === 'ACCOUNT_RESTRICTED')?.level).toBe('warning');
  });

  it('summary, issue order and the Excel tables agree with the rows (T24: 3 plants)', () => {
    const a = goldenInput(); a.data.days.delete(D);
    const b = goldenInput();
    const built = [
      buildPortfolioRow(plant({ id: 'a', name: 'Charlie' }), misInput(a.settings, a.data), opts),
      buildPortfolioRow(plant({ id: 'b', name: 'Alpha' }), misInput(b.settings, b.data), opts),
      buildPortfolioRow(plant({ id: 'c', name: 'Bravo', setupStatus: 'settings_pending' }), { kind: 'not_live' }, opts),
    ];
    const rows = built.map((x) => x.row);
    const issues = sortIssues(built.flatMap((x) => x.issues));
    const s = summarize(rows, issues);
    expect(s).toMatchObject({ plants: 3, live: 2, logsheets: { expected: 2, submitted: 1, missing: 1 } });
    expect(s.issues.critical + s.issues.warning).toBe(issues.length);
    const firstWarning = issues.findIndex((i) => i.level === 'warning');
    if (firstWarning >= 0) expect(issues.slice(firstWarning).every((i) => i.level === 'warning')).toBe(true);

    const [plantsSheet, issuesSheet] = portfolioTables({ reportDate: D, today: TODAY, standard: 'primary', summary: s, rows, issues });
    expect(plantsSheet!.rows).toHaveLength(3);
    expect(issuesSheet!.rows).toHaveLength(issues.length);
    expect(plantsSheet!.footer![0]).toMatchObject({ logsheet: '1 / 2 submitted', critical: s.issues.critical });
  });

  it('daysOpen counts whole days to the end of the report date (IST)', () => {
    expect(daysOpen('2026-09-21T06:00:00+05:30', D)).toBe(0);
    expect(daysOpen('2026-09-20T23:00:00+05:30', D)).toBe(1);
    expect(daysOpen('2026-09-25T06:00:00+05:30', D)).toBe(0);
  });
});
