import { computeDerived } from '../../src/modules/engine/core/derive';
import { buildMis, type Bundle } from '../../src/modules/engine/core/mis';
import { buildAlerts, buildSummary } from '../../src/modules/insights/insights';
import { goldenInput } from '../golden/fixture';

const D = '2026-09-21';
const { settings, data } = goldenInput();
const bundle: Bundle = { settings, data, derived: computeDerived(settings, data, D) };
const mis = buildMis(bundle, D);

describe('insights: alerts and summary from the golden MIS (21-Sep-2026)', () => {
  it('summary: outlet compliance = 1 − exceedances / (parameters × days with data)', () => {
    const s = buildSummary(mis);
    expect(s.compliance.parameters).toBe(mis.lab.outlet.length);
    expect(s.compliance.testsMtd).toBe(mis.lab.outlet.length * mis.header.mtdDataDays);
    const exc = mis.lab.outlet.reduce((a, l) => a + l.events.utd, 0);
    expect(s.compliance.exceedancesUtd).toBe(exc);
    expect(s.compliance.utdPct).toBeCloseTo((1 - exc / s.compliance.testsUtd) * 100, 6);
    expect(s.dataDays).toEqual({ mtd: 21, mtdDays: 21, utd: 690, utdDays: 690 });
    expect(s.omMonthNo).toBe(49);
  });

  it('alerts come only from engine flags and are sorted critical → warning → info', () => {
    const alerts = buildAlerts(mis);
    const order = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < alerts.length; i++) expect(order[alerts[i - 1]!.level]).toBeLessThanOrEqual(order[alerts[i]!.level]);
    // safety deficits of the golden day → warnings; absent staff → info
    const deficits = mis.safety.rows.filter((r) => r.deficitFlag === 'bad').length;
    expect(alerts.filter((a) => a.kind === 'safety')).toHaveLength(deficits);
    expect(alerts.filter((a) => a.kind === 'staff')).toHaveLength(mis.staff.rows.filter((r) => r.absentFlag === 'bad').length);
    // no lab alert when every outlet result is within limit
    expect(alerts.filter((a) => a.kind === 'lab')).toHaveLength(mis.lab.outlet.filter((l) => l.act !== null && l.resultFlag === 'bad').length);
    // a register that is merely not configured (NOT_AVAILABLE) is not an alert
    expect(alerts.some((a) => a.kind === 'register' && a.code === 'IAR')).toBe(false);
    // ids are unique (React keys)
    expect(new Set(alerts.map((a) => a.id)).size).toBe(alerts.length);
  });

  it('a lab exceedance becomes a critical alert', () => {
    const outlet = mis.lab.outlet.map((l, i) => (i === 0 ? { ...l, act: 99, result: 'EXCEEDED LIMIT' as const, resultFlag: 'bad' as const } : l));
    const alerts = buildAlerts({ ...mis, lab: { ...mis.lab, outlet } });
    expect(alerts[0]).toMatchObject({ level: 'critical', kind: 'lab', code: mis.lab.outlet[0]!.code });
    expect(buildSummary({ ...mis, lab: { ...mis.lab, outlet } }).compliance.failingToday).toBe(1);
  });
});
